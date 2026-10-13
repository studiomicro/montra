import { describe, expect, it } from 'vitest';
import { compareVersionsDesc, isVersion } from './versions';

describe('isVersion', () => {
	it('accepts MAJOR.MINOR.PATCH only', () => {
		for (const v of ['0.6.0', '0.10.0', '1.0.0', '9999.0.1']) expect(isVersion(v), v).toBe(true);
		for (const v of [
			'abc',
			'',
			'1.2',
			'01.2.3',
			'1.2.3.4',
			'v1.2.3',
			' 1.2.3',
			'10000.0.0',
			null,
			3
		])
			expect(isVersion(v), String(v)).toBe(false);
	});
});

describe('compareVersionsDesc (moved from release-notes.ts)', () => {
	it('is negative when the first is newer, positive when older, zero when equal', () => {
		expect(compareVersionsDesc('0.10.0', '0.9.0')).toBeLessThan(0);
		expect(compareVersionsDesc('0.9.0', '0.10.0')).toBeGreaterThan(0);
		expect(compareVersionsDesc('1.2.3', '1.2.3')).toBe(0);
	});
});
