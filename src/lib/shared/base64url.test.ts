import { describe, expect, it } from 'vitest';
import { base64Encode, base64urlDecode, base64urlEncode } from './base64url';

describe('base64url', () => {
	it('round-trips bytes that need the URL-safe alphabet, without padding', () => {
		const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01]);
		const text = base64urlEncode(bytes);
		expect(text).toBe('-_-_AAE');
		expect(base64urlDecode(text)).toEqual(bytes);
	});
	it('accepts padding and refuses other alphabets or impossible lengths', () => {
		expect(base64urlDecode('AAE=')).toEqual(new Uint8Array([0, 1]));
		expect(base64urlDecode('a+b/')).toBeNull();
		expect(base64urlDecode('abcde')).toBeNull();
		expect(base64urlDecode('<script>')).toBeNull();
	});

	it('base64Encode is standard padded base64, also across 32 KiB chunk boundaries (FN-15)', () => {
		expect(base64Encode(new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01]))).toBe('+/+/AAE=');
		const big = Uint8Array.from({ length: 0x8000 * 3 + 7 }, (_, i) => (i * 31 + 7) % 256);
		expect(base64Encode(big)).toBe(Buffer.from(big).toString('base64'));
		expect(base64Encode(new Uint8Array(0))).toBe('');
	});
});
