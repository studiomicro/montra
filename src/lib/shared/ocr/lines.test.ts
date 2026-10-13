import { describe, expect, it } from 'vitest';
import { ocrDoc } from '../../../../test/helpers/ocr';
import { readOcrDocument } from './read';
import { looksNumeric, pageUnclear, poisonLowConfidence, UNREADABLE } from './confidence';
import { buildPage, textLayout, textPages } from './lines';

const word = (text: string, x0: number, y0: number, confidence = 95) => ({
	text,
	confidence,
	x0,
	x1: x0 + text.length * 10,
	y0,
	y1: y0 + 20
});

describe('buildPage', () => {
	it('groups word boxes into lines top to bottom, left to right, keeping column gaps', () => {
		const page = buildPage(
			[
				word('-Rp25.000', 400, 52),
				word('Kopi', 10, 50),
				word('Senja', 60, 49),
				word('14:30', 10, 90),
				word(' ', 0, 0)
			],
			500,
			200
		);
		expect(page.lines.map((l) => l.words.map((w) => w.t))).toEqual([
			['Kopi', 'Senja', '-Rp25.000'],
			['14:30']
		]);
		expect(page.lines[0]!.text).toMatch(/^Kopi Senja {2,8}-Rp25\.000$/);
		expect(page.lines[0]!.y).toBe(49);
		expect(page.meanConf).toBe(95);
		expect(textPages({ pages: [page] })[0]!.split('\n')).toHaveLength(2);
	});

	it('textLayout gives each text line’s left edge and the page width (FN-16f/16h red team L1)', () => {
		const page = buildPage([word('05/07/2026', 40, 50), word('Berita', 300, 90)], 2480, 3508);
		expect(textLayout({ pages: [page] })).toEqual([{ width: 2480, lineX: [40, 300] }]);
		expect(textPages({ pages: [page] })[0]!.split('\n')).toHaveLength(2);
	});

	it('rounds coordinates and clamps confidence to integers 0–100', () => {
		const page = buildPage(
			[{ text: 'a', confidence: 120.4, x0: 1.6, x1: 9.2, y0: 0.4, y1: 10.6 }],
			10.2,
			10.7
		);
		expect(page.lines[0]!.words[0]).toEqual({ t: 'a', c: 100, x0: 2, x1: 9 });
		expect(page.widthPx).toBe(10);
	});
});

describe('confidence', () => {
	it('poisons numeric words below 70 only; letters-only words stay', () => {
		const doc = ocrDoc([['Kopi 25.000 Rp']], (w) => (w === 'Kopi' ? 10 : 69));
		const out = poisonLowConfidence(doc).pages[0]!.lines[0]!.words.map((w) => w.t);
		expect(out).toEqual(['Kopi', UNREADABLE, UNREADABLE]);
		expect(looksNumeric('Okt')).toBe(false);
		expect(looksNumeric('1O.000')).toBe(true);
		expect(looksNumeric('-Rp')).toBe(true);
	});

	it('a page under 60 mean confidence or 8 words is unclear and every row from it is reviewed (criterion 18)', () => {
		const lines = [
			'GoPay',
			'Riwayat transaksi',
			'08 Okt 2026',
			'Kopi Senja Fiktif   -Rp25.000',
			'Roti Contoh   -Rp9.000'
		];
		expect(pageUnclear(ocrDoc([lines], 96).pages[0]!)).toBe(false);
		expect(pageUnclear(ocrDoc([lines.slice(0, 2)], 96).pages[0]!)).toBe(true);
		const blurry = ocrDoc([lines], (w) => (/\d|Okt/.test(w) ? 95 : 30));
		expect(pageUnclear(blurry.pages[0]!)).toBe(true);
		const r = readOcrDocument({
			doc: blurry,
			institution: null,
			section: null,
			todayWib: '2026-10-10'
		});
		expect(r.ok && r.reading.unclearPages).toBe(1);
		expect(r.ok && r.reading.rows.map((x) => x.ok && x.review)).toEqual([
			'photo_unclear',
			'photo_unclear'
		]);
	});
});
