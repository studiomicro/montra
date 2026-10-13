import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	decodeSealed,
	deriveWrapKey,
	encodeSealed,
	generateKeyPair,
	hkdfSha256,
	keyCheck,
	isAccountKeySupported,
	isAllowedScryptParams,
	newKdfSalt,
	SCRYPT_PARAMS,
	scryptBytes,
	SEAL_VERSION,
	sealToPublicKey,
	unseal,
	unwrapPrivateKey,
	wrapPrivateKey,
	type AccountKeyPair,
	type SealedBlob
} from './account-key';

const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b: Uint8Array | ArrayBuffer) => Buffer.from(new Uint8Array(b)).toString('hex');
const pkcs8 = async (key: CryptoKey) => toHex(await crypto.subtle.exportKey('pkcs8', key));
const flip = (bytes: Uint8Array, at: number) => {
	const copy = bytes.slice();
	copy[at] = (copy[at] as number) ^ 0x01;
	return copy;
};
const text = (s: string) => new TextEncoder().encode(s);

afterEach(() => vi.restoreAllMocks());

describe('isAccountKeySupported', () => {
	it('is true where WebCrypto makes X25519 keys', async () => {
		expect(await isAccountKeySupported()).toBe(true);
	});

	it('is false, never throwing, where generateKey rejects X25519', async () => {
		vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(new DOMException('NotSupportedError'));
		await expect(isAccountKeySupported()).resolves.toBe(false);
	});

	it('is false where generateKey throws synchronously', async () => {
		vi.spyOn(crypto.subtle, 'generateKey').mockImplementation(() => {
			throw new TypeError('Unrecognized name');
		});
		await expect(isAccountKeySupported()).resolves.toBe(false);
	});
});

describe('X25519 through WebCrypto (RFC 7748)', () => {
	// The scalar as an X25519 PKCS#8 key (RFC 8410 prefix): the format wrapPrivateKey stores.
	const importPrivate = (d: string) =>
		crypto.subtle.importKey(
			'pkcs8',
			hex(`302e020100300506032b656e04220420${d}`),
			{ name: 'X25519' },
			false,
			['deriveBits']
		);
	const derive = async (d: string, u: string) =>
		toHex(
			await crypto.subtle.deriveBits(
				{
					name: 'X25519',
					public: await crypto.subtle.importKey('raw', hex(u), { name: 'X25519' }, false, [])
				},
				await importPrivate(d),
				256
			)
		);

	it('§5.2 scalar multiplication vector', async () => {
		expect(
			await derive(
				'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4',
				'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'
			)
		).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
	});

	it('§6.1 Diffie-Hellman: Alice and Bob reach the same shared secret', async () => {
		const alice = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
		const alicePub = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
		const bob = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
		const bobPub = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
		const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
		expect(await derive(alice, bobPub)).toBe(shared);
		expect(await derive(bob, alicePub)).toBe(shared);
	});
});

describe('hkdfSha256 (RFC 5869)', () => {
	it('test case 1', async () => {
		const okm = await hkdfSha256(
			hex('0b'.repeat(22)),
			hex('000102030405060708090a0b0c'),
			hex('f0f1f2f3f4f5f6f7f8f9'),
			42
		);
		expect(toHex(okm)).toBe(
			'3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
		);
	});

	it('test case 3 (empty salt and info)', async () => {
		const okm = await hkdfSha256(hex('0b'.repeat(22)), new Uint8Array(0), new Uint8Array(0), 42);
		expect(toHex(okm)).toBe(
			'8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8'
		);
	});
});

describe('scrypt (RFC 7914 §12 vectors, @noble/hashes)', () => {
	it('empty password and salt, N=16 r=1 p=1', () => {
		expect(toHex(scryptBytes('', new Uint8Array(0), { N: 16, r: 1, p: 1, dkLen: 64 }))).toBe(
			'77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906'
		);
	});

	it('"password" / "NaCl", N=1024 r=8 p=16', () => {
		expect(toHex(scryptBytes('password', text('NaCl'), { N: 1024, r: 8, p: 16, dkLen: 64 }))).toBe(
			'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640'
		);
	});
});

describe('scrypt parameter policy (OWASP minimum N=2^17, r=8, p=1)', () => {
	it('the default is OWASP minimum and allowed', () => {
		expect(SCRYPT_PARAMS).toEqual({ alg: 'scrypt', N: 131072, r: 8, p: 1, dkLen: 32 });
		expect(isAllowedScryptParams(SCRYPT_PARAMS)).toBe(true);
		expect(isAllowedScryptParams({ ...SCRYPT_PARAMS, N: 2 ** 18 })).toBe(true);
	});

	it.each([
		['N below the minimum', { N: 2 ** 16 }],
		['N = 2^15 (the PRD figure, below the current sheet)', { N: 2 ** 15 }],
		['N above the device cap', { N: 2 ** 19 }],
		['N not a power of two', { N: 131073 }],
		['N as text', { N: '131072' }],
		['r below 8', { r: 4 }],
		['p other than 1', { p: 2 }],
		['short output', { dkLen: 16 }],
		['other algorithm', { alg: 'pbkdf2' }],
		['extra key', { extra: 1 }]
	])('refuses %s', (_, change) => {
		expect(isAllowedScryptParams({ ...SCRYPT_PARAMS, ...change })).toBe(false);
	});

	it('refuses non-objects', () => {
		expect(isAllowedScryptParams(null)).toBe(false);
		expect(isAllowedScryptParams('scrypt')).toBe(false);
	});

	it('deriveWrapKey refuses weak params and a wrong salt length before deriving', async () => {
		await expect(deriveWrapKey('pw', newKdfSalt(), { ...SCRYPT_PARAMS, N: 1024 })).rejects.toThrow(
			RangeError
		);
		await expect(deriveWrapKey('pw', new Uint8Array(8), SCRYPT_PARAMS)).rejects.toThrow(RangeError);
	});
});

describe('wrap / unwrap', () => {
	const PASSWORD = 'kopi-pagi-2026';
	let pair: AccountKeyPair;
	let salt: Uint8Array;
	let wrapKey: CryptoKey;

	beforeAll(async () => {
		pair = await generateKeyPair();
		salt = newKdfSalt();
		wrapKey = await deriveWrapKey(PASSWORD, salt, SCRYPT_PARAMS);
	});

	it('generateKeyPair gives a 32-byte public key and fresh pairs each call', async () => {
		const other = await generateKeyPair();
		expect(pair.publicKeyRaw).toHaveLength(32);
		expect(toHex(other.publicKeyRaw)).not.toBe(toHex(pair.publicKeyRaw));
		expect(await pkcs8(other.privateKey)).not.toBe(await pkcs8(pair.privateKey));
	});

	it('round-trips with the same password to the same private key bytes', async () => {
		const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		const again = await deriveWrapKey(PASSWORD, salt, SCRYPT_PARAMS);
		const opened = await unwrapPrivateKey(wrapped, nonce, pair.publicKeyRaw, again, true);
		expect(opened).not.toBeNull();
		expect(await pkcs8(opened!)).toBe(await pkcs8(pair.privateKey));
	});

	it('opens non-extractable by default', async () => {
		const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		const opened = await unwrapPrivateKey(wrapped, nonce, pair.publicKeyRaw, wrapKey);
		expect(opened?.extractable).toBe(false);
	});

	it('returns null for a wrong password, never a key', async () => {
		const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		const wrong = await deriveWrapKey('kopi-pagi-2027', salt, SCRYPT_PARAMS);
		expect(await unwrapPrivateKey(wrapped, nonce, pair.publicKeyRaw, wrong)).toBeNull();
	});

	it('returns null for the right password with another salt', async () => {
		const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		const otherSalt = await deriveWrapKey(PASSWORD, newKdfSalt(), SCRYPT_PARAMS);
		expect(await unwrapPrivateKey(wrapped, nonce, pair.publicKeyRaw, otherSalt)).toBeNull();
	});

	it('returns null for a tampered ciphertext, tag or nonce, or another public key', async () => {
		const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		const pub = pair.publicKeyRaw;
		expect(await unwrapPrivateKey(flip(wrapped, 0), nonce, pub, wrapKey)).toBeNull();
		expect(
			await unwrapPrivateKey(flip(wrapped, wrapped.length - 1), nonce, pub, wrapKey)
		).toBeNull();
		expect(await unwrapPrivateKey(wrapped, flip(nonce, 0), pub, wrapKey)).toBeNull();
		expect(await unwrapPrivateKey(wrapped, nonce.slice(0, 8), pub, wrapKey)).toBeNull();
		expect(await unwrapPrivateKey(wrapped, nonce, flip(pub, 0), wrapKey)).toBeNull();
	});

	it('uses a fresh 12-byte nonce on every wrap', async () => {
		const a = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		const b = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		expect(a.nonce).toHaveLength(12);
		expect(toHex(a.nonce)).not.toBe(toHex(b.nonce));
		expect(toHex(a.wrapped)).not.toBe(toHex(b.wrapped));
		expect(a.wrapped).toHaveLength(64);
	});

	it('re-wrap under a new password keeps the key pair: a result sealed before still opens', async () => {
		const sealed = await sealToPublicKey(text('Mutasi Oktober'), pair.publicKeyRaw);
		const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		const extractable = await unwrapPrivateKey(wrapped, nonce, pair.publicKeyRaw, wrapKey, true);
		const newSalt = newKdfSalt();
		const newKey = await deriveWrapKey('teh-sore-2026', newSalt, SCRYPT_PARAMS);
		const rewrapped = await wrapPrivateKey(extractable!, pair.publicKeyRaw, newKey);
		// The old password no longer opens the new wrap; the new one does, to the same key.
		expect(
			await unwrapPrivateKey(rewrapped.wrapped, rewrapped.nonce, pair.publicKeyRaw, wrapKey)
		).toBeNull();
		const reopened = await unwrapPrivateKey(
			rewrapped.wrapped,
			rewrapped.nonce,
			pair.publicKeyRaw,
			await deriveWrapKey('teh-sore-2026', newSalt, SCRYPT_PARAMS)
		);
		expect(new TextDecoder().decode(await unseal(sealed, reopened!, pair.publicKeyRaw))).toBe(
			'Mutasi Oktober'
		);
	});
});

describe('keyCheck (key confirmation, red team L1)', () => {
	it('is 32 bytes, the same for the key and its re-opened copy, and differs between key pairs', async () => {
		const pair = await generateKeyPair();
		const other = await generateKeyPair();
		const wrapKey = await deriveWrapKey('kopi-pagi-2026', newKdfSalt(), SCRYPT_PARAMS);
		const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
		const reopened = await unwrapPrivateKey(wrapped, nonce, pair.publicKeyRaw, wrapKey);
		const a = await keyCheck(pair.privateKey, pair.publicKeyRaw);
		expect(a).toHaveLength(32);
		expect(toHex(await keyCheck(reopened!, pair.publicKeyRaw))).toBe(toHex(a));
		expect(toHex(await keyCheck(other.privateKey, other.publicKeyRaw))).not.toBe(toHex(a));
		// Another private key against this public key does not give this check.
		expect(toHex(await keyCheck(other.privateKey, pair.publicKeyRaw))).not.toBe(toHex(a));
	});
});

describe('seal / unseal', () => {
	let alice: AccountKeyPair;
	let bob: AccountKeyPair;

	beforeAll(async () => {
		alice = await generateKeyPair();
		bob = await generateKeyPair();
	});

	const sealedFor = (s: string) => sealToPublicKey(text(s), alice.publicKeyRaw);
	const open = (sealed: SealedBlob) => unseal(sealed, alice.privateKey, alice.publicKeyRaw);

	it('round-trips the exact bytes, including empty and binary plaintext', async () => {
		expect(new TextDecoder().decode(await open(await sealedFor('Rp 1.264.000 · QRIS')))).toBe(
			'Rp 1.264.000 · QRIS'
		);
		expect(await open(await sealToPublicKey(new Uint8Array(0), alice.publicKeyRaw))).toHaveLength(
			0
		);
		const binary = crypto.getRandomValues(new Uint8Array(4096));
		expect(toHex(await open(await sealToPublicKey(binary, alice.publicKeyRaw)))).toBe(
			toHex(binary)
		);
	});

	it("throws with another user's private key", async () => {
		const sealed = await sealedFor('rahasia');
		await expect(unseal(sealed, bob.privateKey, bob.publicKeyRaw)).rejects.toThrow();
		await expect(unseal(sealed, bob.privateKey, alice.publicKeyRaw)).rejects.toThrow();
	});

	it('throws when the recipient public key bound into the derivation differs', async () => {
		const sealed = await sealedFor('rahasia');
		await expect(unseal(sealed, alice.privateKey, bob.publicKeyRaw)).rejects.toThrow();
	});

	it('uses a fresh ephemeral key and nonce per seal', async () => {
		const a = await sealedFor('sama');
		const b = await sealedFor('sama');
		expect(toHex(a.ephemeralPublicKey)).not.toBe(toHex(b.ephemeralPublicKey));
		expect(toHex(a.nonce)).not.toBe(toHex(b.nonce));
		expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
		expect(a.nonce).toHaveLength(12);
	});

	it('throws on a tampered ciphertext, tag, nonce or ephemeral key', async () => {
		const s = await sealedFor('jangan diubah');
		await expect(open({ ...s, ciphertext: flip(s.ciphertext, 0) })).rejects.toThrow();
		await expect(
			open({ ...s, ciphertext: flip(s.ciphertext, s.ciphertext.length - 1) })
		).rejects.toThrow();
		await expect(open({ ...s, nonce: flip(s.nonce, 3) })).rejects.toThrow();
		await expect(
			open({ ...s, ephemeralPublicKey: flip(s.ephemeralPublicKey, 5) })
		).rejects.toThrow();
		await expect(open({ ...s, ciphertext: s.ciphertext.slice(0, -1) })).rejects.toThrow();
	});

	it('envelope: encodes and decodes losslessly, version byte first', async () => {
		const s = await sealedFor('amplop');
		const bytes = encodeSealed(s);
		expect(bytes[0]).toBe(SEAL_VERSION);
		expect(bytes).toHaveLength(1 + 32 + 12 + s.ciphertext.length);
		const back = decodeSealed(bytes);
		expect(new TextDecoder().decode(await open(back))).toBe('amplop');
	});

	it('envelope: refuses an unknown version and a truncated envelope', async () => {
		const s = await sealedFor('amplop');
		const bytes = encodeSealed(s);
		const v2 = bytes.slice();
		v2[0] = 2;
		expect(() => decodeSealed(v2)).toThrow(/version/);
		expect(() => decodeSealed(bytes.slice(0, 1 + 32 + 12 + 15))).toThrow(/Malformed/);
		await expect(open({ ...s, version: 2 })).rejects.toThrow(/version/);
	});

	it('refuses a recipient public key of the wrong length', async () => {
		await expect(sealToPublicKey(text('x'), new Uint8Array(31))).rejects.toThrow(RangeError);
	});
});
