import { describe, expect, it } from 'vitest';
import { cleanText, maskAccountNumbers } from './text';

describe('cleanText', () => {
	it('strips control, zero-width and bidi characters', () => {
		expect(cleanText('Bu​di\u0000 ‮San‍toso\u0007', 80)).toBe('Budi Santoso');
		expect(cleanText('﻿Siti Aminah', 80)).toBe('Siti Aminah');
	});

	it('turns tabs and newlines into single spaces and trims', () => {
		expect(cleanText('  Rina\t\n  Wati  ', 80)).toBe('Rina Wati');
	});

	it('normalises to NFC', () => {
		expect(cleanText('José', 80)).toBe('José');
	});

	it('caps the length in code points, never splitting a surrogate pair', () => {
		expect(cleanText('a'.repeat(500), 80)).toHaveLength(80);
		expect(Array.from(cleanText('😀'.repeat(100), 80))).toHaveLength(80);
	});

	it('works on a huge input without processing all of it', () => {
		expect(cleanText('x'.repeat(5_000_000), 80)).toHaveLength(80);
	});

	it('returns empty for invisible-only input', () => {
		expect(cleanText('​‌\u0000 ', 80)).toBe('');
	});
});

describe('maskAccountNumbers (CLAUDE.md masking rule, red team FN-18 L1)', () => {
	it('FN-19 red team L3: numbers split by *, /, or a spaced dash are masked; dates and amounts stay', () => {
		const m = '\u2022\u2022\u2022\u2022';
		expect(maskAccountNumbers('Kartu 4111*1111*1111*1111')).toBe(`Kartu ${m}1111`);
		expect(maskAccountNumbers('Rek 1234 - 5678 - 9012')).toBe(`Rek ${m}9012`);
		expect(maskAccountNumbers('Rek 1234 \u2013 5678 \u2013 9012')).toBe(`Rek ${m}9012`);
		expect(maskAccountNumbers('HP 0812/3456/7890')).toBe(`HP ${m}7890`);
		for (const kept of [
			'Tanggal: 08/10/2026 18:05',
			'2026/10/08',
			'Rp 1.250.000',
			'Rp 28.000 - Rp 5.000',
			'1/2'
		])
			expect(maskAccountNumbers(kept), kept).toBe(kept);
	});

	it('FN-19 forwarding red team L3 (2026-10-13): other single joiners and a spaced slash; instalments stay', () => {
		const m = '\u2022\u2022\u2022\u2022';
		for (const joiner of ['\u2013', '\u2014', '\u2212', '\u2010', '_', ',', '\u2022', ' / '])
			expect(maskAccountNumbers(`Kartu 4111${joiner}1111${joiner}1111${joiner}4321`), joiner).toBe(
				`Kartu ${m}4321`
			);
		for (const kept of [
			'Cicilan Rp150.000*12',
			'Rp 150.000 * 12 bulan',
			'IDR 1,250,000.00',
			'IDR 250,000.00',
			'Rp 1.250.000,50',
			'Rp 1250000,00',
			'Hampir 1,5 jt',
			'Periode 01/10/2026 / 31/10/2026',
			'Total 25.000, 30.000'
		])
			expect(maskAccountNumbers(kept), kept).toBe(kept);
	});

	it('cuts every run of 8 or more digits and card-style groups to the last 4', () => {
		expect(maskAccountNumbers('1234567890123456')).toBe('\u2022\u2022\u2022\u20223456');
		expect(maskAccountNumbers('BCA 0123456789')).toBe('BCA \u2022\u2022\u2022\u20226789');
		expect(maskAccountNumbers('Kartu 4111 1111 1111 1234 lunas')).toBe(
			'Kartu \u2022\u2022\u2022\u20221234 lunas'
		);
		expect(maskAccountNumbers('4111-1111-1111-9876')).toBe('\u2022\u2022\u2022\u20229876');
		expect(maskAccountNumbers('a 12345678 b 87654321')).toBe(
			'a \u2022\u2022\u2022\u20225678 b \u2022\u2022\u2022\u20224321'
		);
	});

	it('leaves short numbers, dates and thousands-grouped amounts alone', () => {
		for (const v of [
			'INV-1234567',
			'2026-10-01',
			'08-10-2026',
			'08.10.2026',
			'Rp 1.250.000',
			'Rp 1.250.000,00',
			'Ref 12-34-56',
			'mutasi 2026-10-01 2026-10-31.csv',
			'Rp 100.000.000.000'
		])
			expect(maskAccountNumbers(v)).toBe(v);
	});

	it('masks digits joined by single spaces, dots or dashes once they total 8 or more (cycle 3)', () => {
		const M = '\u2022\u2022\u2022\u2022';
		expect(maskAccountNumbers('1234 5678')).toBe(`${M}5678`);
		expect(maskAccountNumbers('12345 67890')).toBe(`${M}7890`);
		expect(maskAccountNumbers('1234.5678.9012')).toBe(`${M}9012`);
		expect(maskAccountNumbers('No 123-456-7890')).toBe(`No ${M}7890`);
		// A date next to an account number: the date stays, the number is masked.
		expect(maskAccountNumbers('2026-10-08 1234 5678 9012')).toBe(`2026-10-08 ${M}9012`);
	});

	it('masks fullwidth and other Unicode decimal digits too (cycle 3)', () => {
		const M = '\u2022\u2022\u2022\u2022';
		expect(maskAccountNumbers('\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17\uFF18\uFF19\uFF10')).toBe(
			`${M}7890`
		);
		const arabic = '\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660';
		expect(maskAccountNumbers(arabic)).toBe(`${M}\u0667\u0668\u0669\u0660`);
		expect(maskAccountNumbers('\u0661\u0662\u0663')).toBe('\u0661\u0662\u0663');
	});
});

// fix-lows-services red team N1 (cycle 2): the comma-decimal shape never keeps an account number, and the other
// joiners mask too.
describe('maskAccountNumbers cycle 2 (red team N1)', () => {
	const m = '••••';
	it('a 10-digit account glued to ,NN keeps only its last 4 digits; a card with ,00 shows no 8 digits', () => {
		expect(maskAccountNumbers('Rek 1234567890,12')).not.toContain('123456');
		expect(maskAccountNumbers('Rek 1234567890,12')).toMatch(/^Rek •{4}\d{4}/);
		const card = maskAccountNumbers('4111 1111 1111 1111,00');
		expect(card.match(/\d/g)?.length ?? 0).toBeLessThanOrEqual(4);
		expect(card.startsWith(m)).toBe(true);
	});

	it.each(['  ', '·', '‒', '―', '・', '~', '+', '|', ' _ ', ' | ', ' ~ '])(
		'masks card groups joined by %j',
		(joiner) => {
			const out = maskAccountNumbers(`Kartu 4111${joiner}1111${joiner}1111${joiner}4321`);
			expect(out).toBe(`Kartu ${m}4321`);
		}
	);

	it('rupiah amounts with a comma decimal stay, grouped or (after Rp/IDR) ungrouped', () => {
		for (const kept of [
			'Rp 1250000,00',
			'Rp12500000,00',
			'IDR 150000000,00',
			'Total 1250,50',
			'Rp 1.250.000,50',
			'IDR 1,250,000.00',
			'Jam 18:05',
			'08/10/2026 18:05'
		])
			expect(maskAccountNumbers(kept), kept).toBe(kept);
	});
});
