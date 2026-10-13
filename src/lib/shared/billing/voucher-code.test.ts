import { describe, expect, it } from 'vitest';
import { CROCKFORD, generateVoucherCode, normalizeVoucherCode } from './voucher-code';

describe('normalizeVoucherCode (Crockford base32)', () => {
	it('ignores case, spaces and dashes', () => {
		expect(normalizeVoucherCode(' abcd-efgh-jk ')).toBe('ABCDEFGHJK');
		expect(normalizeVoucherCode('ABCD EFGH JK')).toBe('ABCDEFGHJK');
		expect(normalizeVoucherCode('ab--cd efghjk')).toBe('ABCDEFGHJK');
	});
	it('folds the look-alikes O → 0 and I, L → 1', () => {
		expect(normalizeVoucherCode('OOII-LL00-11')).toBe('0011110011');
		expect(normalizeVoucherCode('coba-kredit-100')).toBe('C0BAKRED1T100');
		expect(normalizeVoucherCode('UJI-KREDIT-100')).toBeNull(); // U is not Crockford
	});
	it('refuses short, long or non-base32 input', () => {
		for (const bad of [
			'',
			'ABCD-EFGH-J',
			'A'.repeat(33),
			'ABCDEFGHJU',
			'ABCDEFGHJ_K',
			"ABCDEFGHJ'K",
			'ABCDÉFGHJK',
			'<script>abc',
			'A'.repeat(101)
		])
			expect(normalizeVoucherCode(bad), bad).toBeNull();
	});
});

describe('generateVoucherCode', () => {
	it('makes 16 Crockford symbols in four groups that normalise to themselves', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const code = generateVoucherCode();
			expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
			const canonical = normalizeVoucherCode(code);
			expect(canonical).toBe(code.replaceAll('-', ''));
			for (const ch of canonical ?? '') expect(CROCKFORD).toContain(ch);
			seen.add(code);
		}
		expect(seen.size).toBe(200);
	});
});
