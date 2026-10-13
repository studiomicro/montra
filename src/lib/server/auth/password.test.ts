import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	checkPasswordStrength,
	derive,
	equalConstantTime,
	isPlausibleEmail,
	normalizeEmail,
	PASSWORD_MIN_LENGTH,
	PBKDF2_ITERATIONS,
	PBKDF2_MAX_ITERATIONS
} from './password';

describe('PBKDF2 iteration count', () => {
	it('stays within the Workers cap', () => {
		expect(PBKDF2_MAX_ITERATIONS).toBe(100_000);
		expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(PBKDF2_MAX_ITERATIONS);
	});

	it.each([PBKDF2_MAX_ITERATIONS + 1, 0, -1, 1.5, Number.NaN])(
		'derive refuses %s iterations',
		async (n) => {
			await expect(derive('jalan-merdeka', new Uint8Array(16), n)).rejects.toThrow(
				/iteration count/
			);
		}
	);

	it('derive is PBKDF2-HMAC-SHA256', async () => {
		const salt = new Uint8Array(16).fill(7);
		expect(await derive('jalan-merdeka', salt, 1000)).toBe(
			pbkdf2Sync('jalan-merdeka', salt, 1000, 32, 'sha256').toString('base64')
		);
	});
});

describe('checkPasswordStrength', () => {
	it('uses the owner floor of 8 characters (decision C)', () => {
		expect(PASSWORD_MIN_LENGTH).toBe(8);
		expect(checkPasswordStrength('k0p1-pagi', 'budi@contoh.id')).toBeNull();
		expect(checkPasswordStrength('k0p1pag', 'budi@contoh.id')).toBe('too_short');
		expect(checkPasswordStrength('k0p1paGi', 'budi@contoh.id')).toBeNull();
	});
	it('refuses overlong, common, repeated and e-mail passwords', () => {
		expect(checkPasswordStrength('a'.repeat(201), 'x@y.id')).toBe('too_long');
		expect(checkPasswordStrength('Password', 'x@y.id')).toBe('too_simple');
		expect(checkPasswordStrength('12345678', 'x@y.id')).toBe('too_simple');
		expect(checkPasswordStrength('zzzzzzzzz', 'x@y.id')).toBe('too_simple');
		expect(checkPasswordStrength('budisantoso', 'BudiSantoso@contoh.id')).toBe('same_as_email');
		expect(checkPasswordStrength('budi@contoh.id', 'budi@contoh.id')).toBe('same_as_email');
	});
});

describe('e-mail helpers', () => {
	it('normalises case and whitespace', () => {
		expect(normalizeEmail('  Budi@Contoh.ID ')).toBe('budi@contoh.id');
	});
	it.each(['budi@contoh.id', 'a.b+c@sub.contoh.co.id'])('accepts %s', (e) =>
		expect(isPlausibleEmail(e)).toBe(true)
	);
	it.each(['budi', 'budi@contoh', '@contoh.id', 'bu di@contoh.id', 'a@b@c.id', 'a\u0000@b.id'])(
		'refuses %j',
		(e) => expect(isPlausibleEmail(e)).toBe(false)
	);
	it.each(['a​b@example.test', 'ab@exa‍mple.test', 'a‮b@example.test', 'a b@example.test'])(
		'refuses invisible format/separator characters in %j (red team L4)',
		(e) => expect(isPlausibleEmail(e)).toBe(false)
	);
	it('refuses more than 254 characters', () => {
		expect(isPlausibleEmail(`${'a'.repeat(250)}@b.id`)).toBe(false);
	});
});

describe('equalConstantTime', () => {
	it('compares exactly', () => {
		expect(equalConstantTime('abc', 'abc')).toBe(true);
		expect(equalConstantTime('abc', 'abd')).toBe(false);
		expect(equalConstantTime('abc', 'abcd')).toBe(false);
	});
});
