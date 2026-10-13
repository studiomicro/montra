import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate/browser';
import { buildXlsx, serialOf, type FixtureSheet } from '../../../../test/helpers/xlsx';
import { centralDirectory, inflateEntry, RATIO_FLOOR, readXlsx } from './xlsx-read';

function sheet(extra: Partial<FixtureSheet> = {}): FixtureSheet {
	return {
		name: 'Sheet1',
		rows: [
			['Tanggal', 'Keterangan', 'Jumlah'],
			[{ serial: serialOf('2026-10-08'), style: 'date' }, 'Kopi susu', 28000]
		],
		...extra
	};
}

describe('QA ac(a): below-RATIO_FLOOR real parts accepted at any ratio', () => {
	it('900 KB of repeated empty rows compressed ~500:1 is not refused as too_large', () => {
		const text = 'a'.repeat(900_000); // trivially compressible: one byte repeated
		const zip = zipSync({ 'p.xml': strToU8(text) }, { level: 9 });
		const entry = centralDirectory(zip).get('p.xml');
		if (!entry) throw new Error('no entry');
		expect(entry.size).toBeLessThan(RATIO_FLOOR); // below the floor
		expect(entry.size).toBeGreaterThan(entry.compressed * 100); // far past the 100:1 ratio
		expect(entry.size / entry.compressed).toBeGreaterThan(400); // ~500:1 claimed
		const out = inflateEntry(zip, entry, { total: 0 });
		expect(out.byteLength).toBe(entry.size);
	});

	it('readXlsx accepts a real workbook whose worksheet part is small but compresses past 100:1', () => {
		// Pad the worksheet part (via `after`) with a long run of a single repeated attribute-safe char
		// inside a comment, so it is real decompressed bytes the reader must still scan/skip, highly
		// compressible, and under RATIO_FLOOR when inflated.
		const after = `<!--${'x'.repeat(700_000)}-->`;
		const file = buildXlsx([sheet({ after })]);
		const r = readXlsx(file);
		expect(r.ok).toBe(true);
	});
});

describe('QA ac(b): a tolerated long tag cannot hide or corrupt real cell data', () => {
	it('a long dataValidation nested *inside* sheetData, wrapping a real row, does not drop that row', () => {
		const long = 'A1:B2 '.repeat(7000); // > 32KB sqref
		const rows = [
			['Tanggal', 'Keterangan', 'Jumlah'],
			[{ serial: serialOf('2026-10-08'), style: 'date' }, 'Kopi susu', 28000]
		];
		const rowsXml = rows
			.map(
				(cells, i) =>
					`<row r="${i + 1}">${cells
						.map((c, j) => {
							const ref = `${String.fromCharCode(65 + j)}${i + 1}`;
							if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
							if (typeof c === 'string')
								return `<c r="${ref}" t="inlineStr"><is><t>${c}</t></is></c>`;
							return `<c r="${ref}" s="1"><v>${(c as { serial: number }).serial}</v></c>`;
						})
						.join('')}</row>`
			)
			.join('');
		// A tolerated long tag wraps the second real row, nested *inside* sheetData (adversarial order).
		const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml.replace(
			/(<row r="2">)/,
			`<dataValidation type="list" sqref="${long}">$1`
		)}</dataValidation></sheetData></worksheet>`;
		const file = buildXlsx([sheet()], { extra: { 'xl/worksheets/sheet1.xml': xml } });
		const r = readXlsx(file);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const rows2 = r.workbook.sheets[0]?.rows;
			expect(rows2).toHaveLength(2);
			expect(rows2?.[1]?.cells[2]).toEqual({
				kind: 'number',
				text: '28000',
				date: false,
				foreign: false
			});
		}
	});

	it('a value-bearing cell placed between a tolerated tag and its own real <v> is still read, not swapped', () => {
		const long = 'A1:B2 '.repeat(7000);
		// A tolerated <selection> with nested real-looking <v> tag appears between two real cells; the
		// reader must not let it leak into the next cell's captured value.
		const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView><selection sqref="${long}"><v>999999</v></selection></sheetView></sheetViews><sheetData><row r="1"><c r="A1"><v>111</v></c><c r="B1"><v>222</v></c></row></sheetData></worksheet>`;
		const file = buildXlsx([sheet()], { extra: { 'xl/worksheets/sheet1.xml': xml } });
		const r = readXlsx(file);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const cells = r.workbook.sheets[0]?.rows[0]?.cells;
			expect(cells?.[0]).toEqual({ kind: 'number', text: '111', date: false, foreign: false });
			expect(cells?.[1]).toEqual({ kind: 'number', text: '222', date: false, foreign: false });
		}
	});
});
