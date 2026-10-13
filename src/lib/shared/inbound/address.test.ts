import { describe, expect, it } from 'vitest';
import {
	formatAddress,
	inboundDomain,
	isLocalPart,
	newLocalPart,
	recipientLocalPart
} from './address';

describe('forwarding address (FN-19)', () => {
	it('is m- plus 26 Crockford base32 characters of 16 random bytes', () => {
		expect(newLocalPart(new Uint8Array(16))).toBe(`m-${'0'.repeat(26)}`);
		expect(newLocalPart(new Uint8Array(16).fill(255))).toBe(`m-${'z'.repeat(25)}w`);
		const a = newLocalPart();
		expect(a).toMatch(/^m-[0-9a-hjkmnp-tv-z]{26}$/);
		expect(isLocalPart(a)).toBe(true);
		const many = new Set(Array.from({ length: 200 }, () => newLocalPart()));
		expect(many.size).toBe(200);
		expect(() => newLocalPart(new Uint8Array(15))).toThrow(RangeError);
	});

	it('accepts only a well-formed forwarding domain', () => {
		expect(inboundDomain(' In.Contoh.Example ')).toBe('in.contoh.example');
		for (const bad of [
			undefined,
			'',
			'localhost',
			'contoh',
			'-a.example',
			'a..example',
			'a b.example'
		])
			expect(inboundDomain(bad), String(bad)).toBeNull();
	});

	it('matches the recipient case-insensitively on the configured domain only', () => {
		const local = newLocalPart();
		const domain = 'in.contoh.example';
		expect(recipientLocalPart(formatAddress(local, domain).toUpperCase(), domain)).toBe(local);
		expect(recipientLocalPart(`${local}@other.example`, domain)).toBeNull();
		expect(recipientLocalPart(`${local}@${domain}`, null)).toBeNull();
		expect(recipientLocalPart(`budi@${domain}`, domain)).toBeNull();
		expect(recipientLocalPart(`m-${'i'.repeat(26)}@${domain}`, domain)).toBeNull();
		expect(recipientLocalPart(`${'a'.repeat(400)}@${domain}`, domain)).toBeNull();
	});
});
