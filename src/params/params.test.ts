import { describe, expect, it } from 'vitest';
import { match as legal } from './legal';

describe('param matchers', () => {
	it('legal accepts only the two draft legal pages (hapus-akun is its own page since FN-01)', () => {
		expect(['privasi', 'ketentuan'].every(legal)).toBe(true);
		expect(legal('hapus-akun')).toBe(false);
		expect(legal('blog')).toBe(false);
	});
});
