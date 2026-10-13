import { describe, expect, it } from 'vitest';
import { SCRYPT_PARAMS } from './account-key';
import { decodeAccountKey, encodeAccountKey } from './account-key-fields';
import { base64urlEncode } from './base64url';

const bytes = (len: number, fill = 7) => new Uint8Array(len).fill(fill);
const key = {
	publicKey: bytes(32, 1),
	wrappedPrivateKey: bytes(64, 2),
	wrapNonce: bytes(12, 3),
	kdfSalt: bytes(16, 4),
	kdfParams: SCRYPT_PARAMS
};

describe('account key transport fields', () => {
	it('round-trips through encode and decode', () => {
		const fields = encodeAccountKey(key);
		expect(fields.kdfParams).toBe('{"alg":"scrypt","N":131072,"r":8,"p":1,"dkLen":32}');
		expect(decodeAccountKey(fields)).toEqual(key);
	});

	it('tolerates base64url padding but not standard base64 characters', () => {
		const fields = encodeAccountKey(key);
		expect(decodeAccountKey({ ...fields, wrapNonce: `${fields.wrapNonce}==` })).not.toBeNull();
		const plus = encodeAccountKey({ ...key, publicKey: bytes(32, 0xfb) });
		expect(decodeAccountKey({ ...plus, publicKey: plus.publicKey.replace(/-/g, '+') })).toBeNull();
	});

	it.each([
		['public key 31 bytes', { publicKey: base64urlEncode(bytes(31)) }],
		['public key 33 bytes', { publicKey: base64urlEncode(bytes(33)) }],
		['wrapped key 63 bytes', { wrappedPrivateKey: base64urlEncode(bytes(63)) }],
		['nonce 16 bytes', { wrapNonce: base64urlEncode(bytes(16)) }],
		['salt 8 bytes', { kdfSalt: base64urlEncode(bytes(8)) }],
		['empty salt', { kdfSalt: '' }],
		['params below OWASP', { kdfParams: JSON.stringify({ ...SCRYPT_PARAMS, N: 16384 }) }],
		['params not JSON', { kdfParams: '{' }],
		['params too long', { kdfParams: ' '.repeat(201) }],
		['prototype keys in params', { kdfParams: '{"__proto__":{"N":131072}}' }]
	])('refuses %s', (_, over) => {
		expect(decodeAccountKey({ ...encodeAccountKey(key), ...over })).toBeNull();
	});
});
