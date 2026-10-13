import { describe, expect, it } from 'vitest';
import { cleanDescriptor, matchKeyOf, MATCH_KEY_MAX_LENGTH } from './clean';

describe('cleanDescriptor (FN-20 AC-1)', () => {
	it('QRIS prefix, city code and the phone-like run go; Title Case name and lower-case key', () => {
		expect(cleanDescriptor('QRIS*KOPI KENANGAN JKT 0812 3456 7890')).toEqual({
			name: 'Kopi Kenangan',
			key: 'kopi kenangan'
		});
	});

	it('bank transfer, debit and wallet prefixes and slash-joined references are stripped', () => {
		expect(cleanDescriptor('TRSF E-BANKING DB 1234/FTSCY/WS95031 GAJI OKT')).toEqual({
			name: 'Gaji Okt',
			key: 'gaji okt'
		});
		expect(cleanDescriptor('DEBIT DOMESTIK POS INDOMARET 1234 JKT').name).toBe('Indomaret');
		expect(cleanDescriptor('GOPAY-GOJEK 5/10').name).toBe('Gojek');
		expect(cleanDescriptor('BI-FAST CR PAYROLL PT CONTOH').key).toBe('payroll pt contoh');
	});

	it('masked card tails and lone ids leave nothing; a wallet-only descriptor keeps its name', () => {
		expect(cleanDescriptor('xxxx1234')).toEqual({ name: '', key: '' });
		expect(cleanDescriptor('••••1234')).toEqual({ name: '', key: '' });
		expect(cleanDescriptor('GOPAY').name).toBe('Gopay');
	});

	it('empty, whitespace and non-strings', () => {
		expect(cleanDescriptor('')).toEqual({ name: '', key: '' });
		expect(cleanDescriptor('   \t\n ')).toEqual({ name: '', key: '' });
		expect(cleanDescriptor(undefined as unknown as string)).toEqual({ name: '', key: '' });
	});

	it('5,000 characters: bounded name and key', () => {
		const r = cleanDescriptor('TOKO '.repeat(1000));
		expect(Array.from(r.name).length).toBeLessThanOrEqual(80);
		expect(Array.from(r.key).length).toBeLessThanOrEqual(MATCH_KEY_MAX_LENGTH);
		expect(r.key.startsWith('toko toko')).toBe(true);
	});

	it('zero-width, control and bidi characters are removed; no HTML survives', () => {
		const invisible = [0x200b, 0x0000, 0x202e, 0x202c].map((c) => String.fromCharCode(c));
		const r = cleanDescriptor(
			`KOPI${invisible[0]}${invisible[1]} ${invisible[2]}SENJA${invisible[3]} <script>alert(1)</script>`
		);
		for (const ch of [...invisible, '<', '>']) expect(r.name).not.toContain(ch);
		expect(r.name.startsWith('Kopi Senja')).toBe(true);
		expect(cleanDescriptor('<img src=x onerror=alert(1)>').name).not.toMatch(/[<>="]/);
	});

	it('RTL text is kept as letters', () => {
		expect(cleanDescriptor('مقهى القهوة 0812345678').name).toBe('مقهى القهوة');
	});

	it('no digit run of 3+ digits ever reaches the key', () => {
		for (const raw of [
			'TRF 1234567890 BUDI',
			'POS 4111 1111 1111 1111 TOKO',
			'EDC WS95031 WARUNG',
			'QRIS*TOKO 08123456789'
		])
			expect(cleanDescriptor(raw).key).not.toMatch(/\d{3}/);
	});

	it('matchKeyOf folds punctuation and case', () => {
		expect(matchKeyOf('Kopi--Kenangan!!')).toBe('kopi kenangan');
	});
});
