import { describe, expect, it } from 'vitest';
import { API_TOKEN_PATTERN, API_TOKEN_PREFIX } from '#lib/shared/api-tokens';
import { randomToken } from '../util';
import { constantTimeEqual } from './api-tokens';

describe('API token format and comparison (FN-38)', () => {
	it('a minted token (prefix + 32 random bytes, base64url) always matches the accepted pattern', () => {
		for (let i = 0; i < 200; i++)
			expect(API_TOKEN_PREFIX + randomToken(32)).toMatch(API_TOKEN_PATTERN);
	});

	it('refuses anything that cannot be a token', () => {
		for (const bad of [
			'',
			'fin_',
			'fin_' + 'a'.repeat(42),
			'fin_' + 'a'.repeat(44),
			'xyz_' + 'a'.repeat(43),
			'fin_' + '+'.repeat(43)
		])
			expect(bad).not.toMatch(API_TOKEN_PATTERN);
	});

	it('compares equal-length hashes without an early exit', () => {
		const a = 'a'.repeat(64);
		expect(constantTimeEqual(a, a)).toBe(true);
		expect(constantTimeEqual(a, 'a'.repeat(63) + 'b')).toBe(false);
		expect(constantTimeEqual(a, 'b' + 'a'.repeat(63))).toBe(false);
		expect(constantTimeEqual(a, 'a'.repeat(63))).toBe(false);
	});
});
