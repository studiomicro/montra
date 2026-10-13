import { scrypt } from '@noble/hashes/scrypt.js';

/**
 * The account key (FN-21, docs/ARCHITECTURE.md › Account key). Pure WebCrypto plus one vetted library
 * (`@noble/hashes` scrypt, Cure53-audited, no dependencies): no D1, no bindings, so the device and the Workers
 * run exactly this code.
 *
 * - Key pair: X25519, made on the device. The public key is stored on the server as is.
 * - Wrap: the private key (PKCS#8) is encrypted with AES-256-GCM under a key derived from the password with
 *   scrypt (OWASP Password Storage Cheat Sheet, read 2026-10-08: N = 2^17, r = 8, p = 1), a 16-byte salt per
 *   wrap and a fresh 12-byte nonce. The public key is the additional data, so a wrapped key only opens as the
 *   key of that public key. The server stores only the public key, the wrapped key, nonce, salt and params.
 * - Seal: ephemeral X25519 against the recipient's public key → HKDF-SHA256 (info binds the version, the
 *   ephemeral and the recipient public key) → AES-256-GCM with a fresh nonce; the header is the additional data.
 *   Envelope: `[version 1 byte][ephemeral public key 32][nonce 12][ciphertext + 16-byte tag]`.
 *
 * These are the only sealing primitives in the codebase: later features (FN-15/16/25) call them, never a
 * second scheme.
 */

export interface ScryptParams {
	alg: 'scrypt';
	N: number;
	r: number;
	p: number;
	dkLen: number;
}

/** OWASP's scrypt minimum (cheat sheet as read 2026-10-08), the parameters every new wrap uses. */
export const SCRYPT_PARAMS: ScryptParams = { alg: 'scrypt', N: 2 ** 17, r: 8, p: 1, dkLen: 32 };
/** Cost range a stored wrap may name: never below OWASP's minimum, never above 256 MiB of device memory. */
const SCRYPT_MIN_N = 2 ** 17;
const SCRYPT_MAX_N = 2 ** 18;

export const PUBLIC_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const KDF_SALT_BYTES = 16;
/** An X25519 PKCS#8 private key is 48 bytes; AES-GCM adds a 16-byte tag. */
export const WRAPPED_KEY_BYTES = 48 + 16;
export const SEAL_VERSION = 1;
const SEAL_HEADER_BYTES = 1 + PUBLIC_KEY_BYTES + NONCE_BYTES;
const TAG_BYTES = 16;

const enc = new TextEncoder();
const WRAP_LABEL = enc.encode('financer/account-key/wrap/v1');
const SEAL_LABEL = enc.encode('financer/account-key/seal/v1');
const CHECK_LABEL = enc.encode('financer/account-key/check/v1');
export const KEY_CHECK_BYTES = 32;

const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

/** Whether `value` is scrypt parameters this app derives with: r = 8, p = 1, N a power of two in range. */
export function isAllowedScryptParams(value: unknown): value is ScryptParams {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		Object.keys(v).length === 5 &&
		v.alg === 'scrypt' &&
		v.r === 8 &&
		v.p === 1 &&
		v.dkLen === 32 &&
		typeof v.N === 'number' &&
		Number.isInteger(v.N) &&
		v.N >= SCRYPT_MIN_N &&
		v.N <= SCRYPT_MAX_N &&
		(v.N & (v.N - 1)) === 0
	);
}

/**
 * True when this runtime's WebCrypto makes X25519 keys (Chrome 133+, Firefox 130+, Safari 17+, Workers).
 * Never throws: an older browser simply has no account key (results are then not stored at all).
 */
export async function isAccountKeySupported(): Promise<boolean> {
	try {
		await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
		return true;
	} catch {
		return false;
	}
}

export interface AccountKeyPair {
	publicKeyRaw: Uint8Array;
	/** Extractable only so wrapPrivateKey can encrypt it; never exported anywhere else. */
	privateKey: CryptoKey;
}

/** A fresh X25519 key pair; the public key exported raw (32 bytes). */
export async function generateKeyPair(): Promise<AccountKeyPair> {
	const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
		'deriveBits'
	])) as CryptoKeyPair;
	const publicKeyRaw = new Uint8Array(
		(await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer
	);
	return { publicKeyRaw, privateKey: pair.privateKey };
}

/** scrypt (RFC 7914) as is, without the parameter policy: for deriveWrapKey and the RFC test vectors. */
export function scryptBytes(
	password: string | Uint8Array,
	salt: Uint8Array,
	params: Pick<ScryptParams, 'N' | 'r' | 'p' | 'dkLen'>
): Uint8Array {
	return scrypt(password, salt, {
		N: params.N,
		r: params.r,
		p: params.p,
		dkLen: params.dkLen
	});
}

/**
 * The AES-256-GCM key that wraps the private key, from the password, its per-user salt and the stored params.
 * Refuses parameters outside isAllowedScryptParams. Costly by design (~0.3 s, 128 MiB): run it in a Web Worker.
 */
export async function deriveWrapKey(
	password: string,
	salt: Uint8Array,
	params: ScryptParams
): Promise<CryptoKey> {
	if (!isAllowedScryptParams(params)) throw new RangeError('Unsupported scrypt parameters');
	if (salt.length !== KDF_SALT_BYTES) throw new RangeError('Unsupported salt length');
	const bytes = scryptBytes(password.normalize('NFC'), salt, params);
	try {
		return await crypto.subtle.importKey('raw', buf(bytes), 'AES-GCM', false, [
			'encrypt',
			'decrypt'
		]);
	} finally {
		bytes.fill(0);
	}
}

/** A fresh random salt for deriveWrapKey. */
export const newKdfSalt = () => crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));

/** Encrypts the private key (PKCS#8) under `wrapKey` with a fresh random nonce; the public key is the AD. */
export async function wrapPrivateKey(
	privateKey: CryptoKey,
	publicKeyRaw: Uint8Array,
	wrapKey: CryptoKey
): Promise<{ wrapped: Uint8Array; nonce: Uint8Array }> {
	const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', privateKey)) as ArrayBuffer);
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	try {
		const wrapped = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce, additionalData: buf(concat(WRAP_LABEL, publicKeyRaw)) },
			wrapKey,
			pkcs8
		);
		return { wrapped: new Uint8Array(wrapped), nonce };
	} finally {
		pkcs8.fill(0);
	}
}

/**
 * The private key inside `wrapped`, or null when it does not open: a wrong password (the GCM tag fails), a
 * different public key, or any tampered byte. Never a partial key. Non-extractable unless a re-wrap needs it.
 */
export async function unwrapPrivateKey(
	wrapped: Uint8Array,
	nonce: Uint8Array,
	publicKeyRaw: Uint8Array,
	wrapKey: CryptoKey,
	extractable = false
): Promise<CryptoKey | null> {
	if (nonce.length !== NONCE_BYTES) return null;
	let pkcs8: Uint8Array;
	try {
		pkcs8 = new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(concat(WRAP_LABEL, publicKeyRaw)) },
				wrapKey,
				buf(wrapped)
			)
		);
	} catch {
		return null;
	}
	try {
		return await crypto.subtle.importKey('pkcs8', buf(pkcs8), { name: 'X25519' }, extractable, [
			'deriveBits'
		]);
	} catch {
		return null;
	} finally {
		pkcs8.fill(0);
	}
}

/** HKDF-SHA256 (RFC 5869) through WebCrypto: `length` bytes from `ikm`, `salt` and `info`. */
export async function hkdfSha256(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	length: number
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
		key,
		length * 8
	);
	return new Uint8Array(bits);
}

export interface SealedBlob {
	version: number;
	ephemeralPublicKey: Uint8Array;
	nonce: Uint8Array;
	ciphertext: Uint8Array;
}

const header = (version: number, ephemeralPublicKey: Uint8Array, nonce: Uint8Array) =>
	concat(Uint8Array.of(version), ephemeralPublicKey, nonce);

/**
 * `{ name: 'X25519', public }` for deriveBits. Cast because @cloudflare/workers-types spells the member
 * `$public` (workerd strips the `$` at runtime), while the DOM types and every runtime read `public`.
 */
const x25519Algorithm = (publicKey: CryptoKey) =>
	({ name: 'X25519', public: publicKey }) as unknown as Parameters<SubtleCrypto['deriveBits']>[0];

/**
 * The key confirmation of a key pair: HKDF-SHA256 of X25519(private key, own public key), bound to a label and
 * the public key. Only a holder of the private key can compute it (the server stores it at the first write and
 * compares it on every re-wrap, so a re-wrap proves the device opened the current wrap); it reveals nothing that
 * opens a sealed result, which needs X25519(private key, ephemeral key).
 */
export async function keyCheck(
	privateKey: CryptoKey,
	publicKeyRaw: Uint8Array
): Promise<Uint8Array> {
	const own = await crypto.subtle.importKey(
		'raw',
		buf(publicKeyRaw),
		{ name: 'X25519' },
		false,
		[]
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits(x25519Algorithm(own), privateKey, 256)
	);
	try {
		return await hkdfSha256(
			shared,
			new Uint8Array(0),
			concat(CHECK_LABEL, publicKeyRaw),
			KEY_CHECK_BYTES
		);
	} finally {
		shared.fill(0);
	}
}

/** The one-time AES-256-GCM key of a seal: X25519 shared secret → HKDF-SHA256 bound to both public keys. */
async function sealKey(
	privateKey: CryptoKey,
	otherPublicKeyRaw: Uint8Array,
	ephemeralPublicKey: Uint8Array,
	recipientPublicKeyRaw: Uint8Array
): Promise<CryptoKey> {
	const other = await crypto.subtle.importKey(
		'raw',
		buf(otherPublicKeyRaw),
		{ name: 'X25519' },
		false,
		[]
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits(x25519Algorithm(other), privateKey, 256)
	);
	try {
		const okm = await hkdfSha256(
			shared,
			new Uint8Array(0),
			concat(SEAL_LABEL, ephemeralPublicKey, recipientPublicKeyRaw),
			32
		);
		try {
			return await crypto.subtle.importKey('raw', buf(okm), 'AES-GCM', false, [
				'encrypt',
				'decrypt'
			]);
		} finally {
			okm.fill(0);
		}
	} finally {
		shared.fill(0);
	}
}

/**
 * Seals `plaintext` to a recipient public key: a fresh ephemeral key pair and nonce every call, so two seals of
 * the same bytes never look alike. Operates on bytes only (no binding): a Worker passes a key it fetched itself.
 */
export async function sealToPublicKey(
	plaintext: Uint8Array,
	recipientPublicKeyRaw: Uint8Array
): Promise<SealedBlob> {
	if (recipientPublicKeyRaw.length !== PUBLIC_KEY_BYTES)
		throw new RangeError('Unsupported public key length');
	const ephemeral = await generateKeyPair();
	const key = await sealKey(
		ephemeral.privateKey,
		recipientPublicKeyRaw,
		ephemeral.publicKeyRaw,
		recipientPublicKeyRaw
	);
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: nonce,
			additionalData: buf(header(SEAL_VERSION, ephemeral.publicKeyRaw, nonce))
		},
		key,
		buf(plaintext)
	);
	return {
		version: SEAL_VERSION,
		ephemeralPublicKey: ephemeral.publicKeyRaw,
		nonce,
		ciphertext: new Uint8Array(ciphertext)
	};
}

/**
 * Opens a sealed blob with the recipient's private key (and its public key, bound into the key derivation).
 * Throws on an unknown envelope version, a different recipient or any tampered byte; never returns
 * corrupted plaintext.
 */
export async function unseal(
	sealed: SealedBlob,
	recipientPrivateKey: CryptoKey,
	recipientPublicKeyRaw: Uint8Array
): Promise<Uint8Array> {
	if (sealed.version !== SEAL_VERSION) throw new Error('Unsupported sealed envelope version');
	if (sealed.ephemeralPublicKey.length !== PUBLIC_KEY_BYTES || sealed.nonce.length !== NONCE_BYTES)
		throw new Error('Malformed sealed envelope');
	const key = await sealKey(
		recipientPrivateKey,
		sealed.ephemeralPublicKey,
		sealed.ephemeralPublicKey,
		recipientPublicKeyRaw
	);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: buf(sealed.nonce),
			additionalData: buf(header(sealed.version, sealed.ephemeralPublicKey, sealed.nonce))
		},
		key,
		buf(sealed.ciphertext)
	);
	return new Uint8Array(plaintext);
}

/** The envelope bytes of a sealed blob, for storage: `[version][ephemeral key][nonce][ciphertext + tag]`. */
export function encodeSealed(sealed: SealedBlob): Uint8Array {
	return concat(header(sealed.version, sealed.ephemeralPublicKey, sealed.nonce), sealed.ciphertext);
}

/** A sealed blob from its envelope bytes; throws on an unknown version or a truncated envelope. */
export function decodeSealed(bytes: Uint8Array): SealedBlob {
	if (bytes.length < SEAL_HEADER_BYTES + TAG_BYTES) throw new Error('Malformed sealed envelope');
	const version = bytes[0] as number;
	if (version !== SEAL_VERSION) throw new Error('Unsupported sealed envelope version');
	return {
		version,
		ephemeralPublicKey: bytes.slice(1, 1 + PUBLIC_KEY_BYTES),
		nonce: bytes.slice(1 + PUBLIC_KEY_BYTES, SEAL_HEADER_BYTES),
		ciphertext: bytes.slice(SEAL_HEADER_BYTES)
	};
}
