import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from '../../shared/base64url';
import { encryptPushPayload, PAYLOAD_MAX_BYTES } from './encrypt';

const b = (text: string) => base64urlDecode(text.replace(/\s+/g, '')) as Uint8Array<ArrayBuffer>;

// RFC 8291 §5 and Appendix A (https://www.rfc-editor.org/rfc/rfc8291), copied verbatim.
const RFC = {
	plaintext: 'When I grow up, I want to be a watermelon',
	asPublic:
		'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
	asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
	uaPublic:
		'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
	uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
	salt: 'DGv6ra1nlYgDCS1FRnbzlw',
	auth: 'BTBZMqHH6r4Tts7J_aSIgg',
	body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
	mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
	pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`
};

/** A P-256 key pair from a raw public point and private scalar (base64url), as WebCrypto JWKs. */
async function keyPairFrom(publicRaw: string, privateD: string): Promise<CryptoKeyPair> {
	const pub = b(publicRaw);
	const jwk = {
		kty: 'EC',
		crv: 'P-256',
		x: base64urlEncode(pub.slice(1, 33)),
		y: base64urlEncode(pub.slice(33, 65))
	};
	const alg = { name: 'ECDH', namedCurve: 'P-256' };
	return {
		publicKey: await crypto.subtle.importKey('jwk', jwk, alg, true, []),
		privateKey: await crypto.subtle.importKey('jwk', { ...jwk, d: privateD }, alg, true, [
			'deriveBits'
		])
	};
}

/** The receiving browser's side (RFC 8291 §3.4 for a user agent), to prove the random-key path decrypts. */
async function decrypt(body: Uint8Array, uaKeys: CryptoKeyPair, auth: Uint8Array<ArrayBuffer>) {
	const salt = body.slice(0, 16);
	const idlen = body[20] as number;
	const asPublic = body.slice(21, 21 + idlen);
	const ciphertext = body.slice(21 + idlen);
	const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
	const asKey = await crypto.subtle.importKey(
		'raw',
		asPublic,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[]
	);
	const ecdh = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKeys.privateKey, 256)
	);
	const hmac = async (key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) =>
		new Uint8Array(
			await crypto.subtle.sign(
				'HMAC',
				await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
					'sign'
				]),
				data
			)
		);
	const te = new TextEncoder();
	const info = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic, 1]);
	const ikm = await hmac(await hmac(auth, ecdh), info);
	const prk = await hmac(salt, ikm);
	const cek = (await hmac(prk, te.encode('Content-Encoding: aes128gcm\0\x01'))).slice(0, 16);
	const nonce = (await hmac(prk, te.encode('Content-Encoding: nonce\0\x01'))).slice(0, 12);
	const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
	const plain = new Uint8Array(
		await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext)
	);
	expect(plain.at(-1)).toBe(2);
	return new TextDecoder().decode(plain.slice(0, -1));
}

describe('encryptPushPayload (RFC 8291)', () => {
	it('reproduces the RFC 8291 Appendix A message byte for byte', async () => {
		const body = await encryptPushPayload(
			new TextEncoder().encode(RFC.plaintext),
			b(RFC.uaPublic),
			b(RFC.auth),
			{ keyPair: await keyPairFrom(RFC.asPublic, RFC.asPrivate), salt: b(RFC.salt) }
		);
		expect(base64urlEncode(body)).toBe(RFC.body.replace(/\s+/g, ''));
	});

	it('the RFC receiver decrypts a message sent with a fresh random key pair and salt', async () => {
		const ua = await keyPairFrom(RFC.uaPublic, RFC.uaPrivate);
		const one = await encryptPushPayload(
			new TextEncoder().encode('{"title":"Uji"}'),
			b(RFC.uaPublic),
			b(RFC.auth)
		);
		const two = await encryptPushPayload(
			new TextEncoder().encode('{"title":"Uji"}'),
			b(RFC.uaPublic),
			b(RFC.auth)
		);
		expect(await decrypt(one, ua, b(RFC.auth))).toBe('{"title":"Uji"}');
		// Fresh salt and sender key per message: the same plaintext never encrypts the same way twice.
		expect(base64urlEncode(one.slice(0, 16))).not.toBe(base64urlEncode(two.slice(0, 16)));
		expect(base64urlEncode(one)).not.toBe(base64urlEncode(two));
	});

	it('refuses malformed subscription keys and oversized payloads', async () => {
		const text = new TextEncoder().encode('x');
		await expect(encryptPushPayload(text, b(RFC.uaPublic).slice(1), b(RFC.auth))).rejects.toThrow(
			/P-256/
		);
		await expect(encryptPushPayload(text, b(RFC.uaPublic), b(RFC.auth).slice(1))).rejects.toThrow(
			/16 octets/
		);
		await expect(
			encryptPushPayload(new Uint8Array(PAYLOAD_MAX_BYTES + 1), b(RFC.uaPublic), b(RFC.auth))
		).rejects.toThrow(/too large/);
	});
});
