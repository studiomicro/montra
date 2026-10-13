import { base64urlDecode, base64urlEncode } from '../shared/base64url.ts';

/**
 * Sealing with a server-held key (FN-29 connected-app tokens, FN-41 personal AI keys). Unlike FN-21's account key
 * (sealed to the user's password-derived key, which the server cannot open alone), these secrets must be usable
 * without the user present, so each feature seals with its own Worker secret: 32 random bytes in base64url
 * (standard base64 is accepted too). WebCrypto AES-256-GCM only, a fresh random 96-bit nonce per seal, and
 * associated data binding the feature's label, the key id and the row's identity, so a ciphertext copied into
 * another row (or to another owner or provider) fails to open. Unset or malformed key: the feature is "Belum
 * dikonfigurasi" and nothing is sealed; never a guessed default.
 *
 * Rotation: the new key in the feature's current secret, the old one in its `_PREVIOUS` secret. Each seal stores
 * `keyId` (the first 8 bytes of a SHA-256 over a label and the key, base64url), so a row opens with whichever of
 * the two keys sealed it; new seals always use the current key.
 *
 * Errors never carry the plaintext: an unopenable value is `null`, and nothing here logs.
 */

/** A sealed value as stored (all base64url). */
export interface Sealed {
	ciphertext: string;
	nonce: string;
	keyId: string;
}

/** A feature's two secrets (the previous one only during a rotation). */
export interface SealKeys {
	current: string | undefined;
	previous: string | undefined;
}

/** A feature's domain-separation labels: never shared between features. */
export interface SealLabels {
	aad: string;
	keyId: string;
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * The raw 32-byte key of a secret value, or null unless it decodes to exactly 32 bytes. Also parses FN-30's
 * CLAIM_HASH_KEY (billing/claims.ts), which follows the same secret format.
 */
export function keyBytes(value: string | undefined): Uint8Array<ArrayBuffer> | null {
	const text = (value ?? '').trim().replace(/\+/g, '-').replace(/\//g, '_');
	if (text === '') return null;
	const bytes = base64urlDecode(text);
	return bytes && bytes.length === KEY_BYTES ? bytes : null;
}

/** True only for a well-formed 32-byte key. */
export function isSealKeyWellFormed(value: string | undefined): boolean {
	return keyBytes(value) !== null;
}

async function keyId(raw: Uint8Array<ArrayBuffer>, label: string): Promise<string> {
	const prefix = new TextEncoder().encode(label);
	const input = new Uint8Array(prefix.length + raw.length);
	input.set(prefix);
	input.set(raw, prefix.length);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
	return base64urlEncode(digest.slice(0, 8));
}

interface Key {
	id: string;
	key: CryptoKey;
}

async function importKey(raw: Uint8Array<ArrayBuffer> | null, label: string): Promise<Key | null> {
	if (!raw) return null;
	const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt'
	]);
	return { id: await keyId(raw, label), key };
}

/** JSON array: no delimiter inside an id can make two different bindings encode alike. */
function associatedData(
	label: string,
	keyIdText: string,
	binding: readonly string[]
): Uint8Array<ArrayBuffer> {
	// Cast: the Workers runtime types (jobs Worker) declare `encode` as Uint8Array<ArrayBufferLike>.
	return new TextEncoder().encode(
		JSON.stringify([label, keyIdText, ...binding])
	) as Uint8Array<ArrayBuffer>;
}

/**
 * `plaintext` sealed for `binding` with the current key; null when the key is unset or malformed. Throws a
 * RangeError (without the plaintext) for an empty value or one longer than `maxBytes` UTF-8 bytes.
 */
export async function sealValue(
	keys: SealKeys,
	labels: SealLabels,
	plaintext: string,
	binding: readonly string[],
	maxBytes: number
): Promise<Sealed | null> {
	const bytes = new TextEncoder().encode(plaintext);
	if (bytes.length === 0 || bytes.length > maxBytes)
		throw new RangeError('sealed value length out of range');
	const current = await importKey(keyBytes(keys.current), labels.keyId);
	if (!current) return null;
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce, additionalData: associatedData(labels.aad, current.id, binding) },
		current.key,
		bytes
	);
	return {
		ciphertext: base64urlEncode(sealed),
		nonce: base64urlEncode(nonce),
		keyId: current.id
	};
}

/**
 * The plaintext of `sealed`, opened for `binding`, or null (fails closed) when: no configured key has its key id,
 * the nonce or ciphertext is malformed, or authentication fails (a wrong key, a tampered ciphertext, or a
 * ciphertext moved to another binding). Never returns a wrong plaintext.
 */
export async function openValue(
	keys: SealKeys,
	labels: SealLabels,
	sealed: Sealed,
	binding: readonly string[]
): Promise<string | null> {
	const candidates = await Promise.all([
		importKey(keyBytes(keys.current), labels.keyId),
		importKey(keyBytes(keys.previous), labels.keyId)
	]);
	const key = candidates.find((k) => k !== null && k.id === sealed.keyId);
	const nonce = base64urlDecode(sealed.nonce);
	const ciphertext = base64urlDecode(sealed.ciphertext);
	if (!key || !nonce || nonce.length !== NONCE_BYTES || !ciphertext) return null;
	try {
		const opened = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: nonce, additionalData: associatedData(labels.aad, key.id, binding) },
			key.key,
			ciphertext
		);
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(opened);
	} catch {
		return null;
	}
}

/**
 * True when `sealed` was sealed with the current key (or no current key is configured, so nothing could re-seal
 * it). False means it opens only with `_PREVIOUS` and should be re-sealed while that key is still present.
 */
export async function sealedWithCurrentKey(
	keys: SealKeys,
	labels: SealLabels,
	sealed: Sealed
): Promise<boolean> {
	const current = keyBytes(keys.current);
	return !current || (await keyId(current, labels.keyId)) === sealed.keyId;
}

/** The key id the current key seals under, or null when no well-formed current key is set. */
export async function currentKeyId(keys: SealKeys, labels: SealLabels): Promise<string | null> {
	const current = keyBytes(keys.current);
	return current ? keyId(current, labels.keyId) : null;
}
