import { describe, expect, it } from 'vitest';
import { base64urlEncode } from '#lib/shared/base64url';
import { canonicalClaimEmail, claimHashes, isClaimHashConfigured } from './claims';

const key = (fill: number, length = 32) => base64urlEncode(new Uint8Array(length).fill(fill));
const K1 = key(1);
const K2 = key(2);

describe('canonicalClaimEmail (FN-30 hardening criterion 13)', () => {
	it.each([
		[' A.B+x@GMail.com ', 'ab@gmail.com'],
		['a.b@googlemail.com', 'ab@gmail.com'],
		['a.b+x@contoh.id', 'a.b@contoh.id'],
		['+x@contoh.id', '+x@contoh.id'],
		['.+x@gmail.com', '.+x@gmail.com'],
		['ab@gmail.com', 'ab@gmail.com']
	])('%s → %s', (input, expected) => {
		expect(canonicalClaimEmail(input)).toBe(expected);
	});

	it('red team L1: fullwidth letters and a trailing dot on the domain count as the same address', () => {
		for (const variant of [
			'ａb@gmail.com',
			'ab@gmail.com.',
			'a.b@googlemail.com.',
			'ab@GMAIL.COM..'
		])
			expect(canonicalClaimEmail(variant), variant).toBe('ab@gmail.com');
		expect(canonicalClaimEmail('ani@contoh.id.')).toBe('ani@contoh.id');
	});

	it('keeps two different addresses on a non-Gmail domain distinct (dots matter there)', () => {
		expect(canonicalClaimEmail('a.b@contoh.id')).not.toBe(canonicalClaimEmail('ab@contoh.id'));
		expect(canonicalClaimEmail('ani@contoh.id')).not.toBe(canonicalClaimEmail('budi@contoh.id'));
	});
});

describe('claimHashes (criterion 14)', () => {
	it('is deterministic for one key and differs between keys', async () => {
		const a = await claimHashes({ CLAIM_HASH_KEY: K1 }, 'ab@gmail.com');
		const b = await claimHashes({ CLAIM_HASH_KEY: K1 }, ' A.B+promo@googlemail.com');
		const c = await claimHashes({ CLAIM_HASH_KEY: K2 }, 'ab@gmail.com');
		expect(a).not.toBeNull();
		expect(a).toEqual(b);
		expect(a!.current).not.toBe(c!.current);
		expect(a!.current).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(a!.previous).toBeNull();
	});

	it('hashes under the previous key during a rotation', async () => {
		const rotated = await claimHashes(
			{ CLAIM_HASH_KEY: K2, CLAIM_HASH_KEY_PREVIOUS: K1 },
			'ab@gmail.com'
		);
		const old = await claimHashes({ CLAIM_HASH_KEY: K1 }, 'ab@gmail.com');
		expect(rotated!.previous).toBe(old!.current);
		// A malformed previous key is ignored, never used.
		expect(
			(await claimHashes({ CLAIM_HASH_KEY: K2, CLAIM_HASH_KEY_PREVIOUS: 'x' }, 'ab@gmail.com'))!
				.previous
		).toBeNull();
	});

	it('returns null for an unset, empty, 31-byte or 33-byte key: no default key', async () => {
		for (const value of [undefined, '', '   ', key(1, 31), key(1, 33), 'not base64 at all!'])
			expect(
				await claimHashes({ CLAIM_HASH_KEY: value }, 'ab@gmail.com'),
				String(value)
			).toBeNull();
		expect(await claimHashes(undefined, 'ab@gmail.com')).toBeNull();
		expect(isClaimHashConfigured({ CLAIM_HASH_KEY: key(1, 31) })).toBe(false);
		expect(isClaimHashConfigured({ CLAIM_HASH_KEY: K1 })).toBe(true);
		expect(isClaimHashConfigured(undefined)).toBe(false);
	});

	it('never contains the address or its canonical form', async () => {
		const hashes = await claimHashes(
			{ CLAIM_HASH_KEY: K1, CLAIM_HASH_KEY_PREVIOUS: K2 },
			'A.B@gmail.com'
		);
		const text = JSON.stringify(hashes);
		for (const part of ['a.b', 'ab@', 'gmail', '@']) expect(text).not.toContain(part);
	});
});
