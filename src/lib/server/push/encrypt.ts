/**
 * Web Push message encryption, RFC 8291 (the `aes128gcm` content coding of RFC 8188), on WebCrypto only so it
 * runs unchanged in the Workers runtime. Verified against the RFC's Appendix A vector (encrypt.test.ts).
 */

const enc = new TextEncoder();
/** UTF-8 bytes on their own ArrayBuffer (the Workers types type `encode()` more loosely than the DOM's). */
const utf8 = (text: string) => new Uint8Array(enc.encode(text));
/** RFC 8188 record size advertised in the header; a push message is always a single record. */
const RECORD_SIZE = 4096;
/** P-256 uncompressed point: 0x04 || X (32) || Y (32). */
export const P256_PUBLIC_KEY_BYTES = 65;
export const AUTH_SECRET_BYTES = 16;
/**
 * Largest plaintext this sender accepts: one record of 4096 octets, minus the 16-octet GCM tag and the
 * delimiter octet, and the 86-octet header leaves the body under the 4096 the push services guarantee.
 */
export const PAYLOAD_MAX_BYTES = RECORD_SIZE - 86 - 16 - 1;

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) {
	const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign'
	]);
	return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** The P-256 public key of a raw uncompressed point, for ECDH. */
async function importP256Public(raw: Uint8Array<ArrayBuffer>) {
	return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export interface SenderKeys {
	/** The application server's ephemeral ECDH key pair (fresh per message). */
	keyPair: CryptoKeyPair;
	/** 16 random octets (fresh per message). */
	salt: Uint8Array<ArrayBuffer>;
}

/** A fresh ephemeral key pair and salt: never reused across messages (RFC 8291 §3.1, RFC 8188 §2.1). */
async function freshSenderKeys(): Promise<SenderKeys> {
	const keyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits'
	])) as CryptoKeyPair;
	return { keyPair, salt: crypto.getRandomValues(new Uint8Array(16)) };
}

/**
 * The encrypted body of one push message for the subscription keys `uaPublic` (p256dh) and `authSecret`
 * (auth): header (salt, record size, sender public key) followed by the AES-128-GCM ciphertext of
 * `plaintext || 0x02`. `sender` is injectable only so the RFC test vector can fix the key pair and salt.
 */
export async function encryptPushPayload(
	plaintext: Uint8Array<ArrayBuffer>,
	uaPublic: Uint8Array<ArrayBuffer>,
	authSecret: Uint8Array<ArrayBuffer>,
	sender?: SenderKeys
): Promise<Uint8Array<ArrayBuffer>> {
	if (uaPublic.length !== P256_PUBLIC_KEY_BYTES || uaPublic[0] !== 0x04)
		throw new Error('push: subscription public key is not an uncompressed P-256 point');
	if (authSecret.length !== AUTH_SECRET_BYTES)
		throw new Error('push: subscription auth secret is not 16 octets');
	if (plaintext.length > PAYLOAD_MAX_BYTES) throw new Error('push: payload too large');

	const { keyPair, salt } = sender ?? (await freshSenderKeys());
	const asPublic = new Uint8Array(
		(await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer
	);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			// Cast: the Workers types spell the member `$public`; the runtime (and WebCrypto) read `public`.
			{ name: 'ECDH', public: await importP256Public(uaPublic) } as Parameters<
				SubtleCrypto['deriveBits']
			>[0],
			keyPair.privateKey,
			256
		)
	);

	// RFC 8291 §3.4, HKDF written out as HMAC steps exactly as the RFC's pseudocode.
	const prkKey = await hmac(authSecret, ecdhSecret);
	const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
	const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
	const prk = await hmac(salt, ikm);
	const cek = (await hmac(prk, utf8('Content-Encoding: aes128gcm\0\x01'))).slice(0, 16);
	const nonce = (await hmac(prk, utf8('Content-Encoding: nonce\0\x01'))).slice(0, 12);

	const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce },
			key,
			concat(plaintext, new Uint8Array([2]))
		)
	);

	const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = asPublic.length;
	header.set(asPublic, 21);
	return concat(header, ciphertext);
}
