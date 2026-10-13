import { describe, expect, it } from 'vitest';
import { buildXlsx, serialOf, type FixtureSheet } from '../../../../test/helpers/xlsx';
import {
	FORMAT_CODE_MAX,
	FORMATS_MAX,
	isDateFormat,
	isForeignFormat,
	readXlsx,
	XLSX_MAX_BYTES,
	XLSX_MAX_ENTRY_INFLATED
} from './xlsx-read';
import { XML_TAG_MAX_LENGTH } from './xml';
import { SHEET_MAX_ROW } from '#lib/shared/spreadsheet/types';

// FN-17 security cycle 1, M1/L2: crafted XML tags and number formats must not cost CPU beyond the input's
// size. The payloads below are the review's repro inputs; each read must end well under a second.

const FAST_MS = 1000;
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const STYLES_OPEN = `${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`;

const sheet = (extra: Partial<FixtureSheet> = {}): FixtureSheet => ({
	name: 'Transaksi',
	rows: [
		['Tanggal', 'Keterangan', 'Jumlah'],
		[{ serial: serialOf('2026-10-08') }, 'Kopi susu', 28000]
	],
	...extra
});

function timed<T>(run: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = run();
	return { value, ms: performance.now() - start };
}

const stylesWith = (formatCode: string, xfs = 4) =>
	`${STYLES_OPEN}<numFmts count="1"><numFmt numFmtId="164" formatCode="${formatCode}"/></numFmts><cellXfs count="${xfs}">${'<xf numFmtId="164"/>'.repeat(xfs)}</cellXfs></styleSheet>`;

describe('M1: an open tag without a closing quote or equals sign', () => {
	it('10 tags of `<x ` + 80,000 a + `/>` are refused as too complex, fast', () => {
		const tag = `<x ${'a'.repeat(80_000)}/>`;
		const file = buildXlsx([sheet({ before: tag.repeat(10) })]);
		const { value, ms } = timed(() => readXlsx(file));
		expect(value).toEqual({ ok: false, error: 'too_complex' });
		expect(ms).toBeLessThan(FAST_MS);
	});

	it('a tag just under the cap with no `=` at all is read in linear time and the file still parses', () => {
		const tag = `<x ${'a'.repeat(XML_TAG_MAX_LENGTH - 100)}/>`;
		const file = buildXlsx([sheet({ before: tag.repeat(10) })]);
		const { value, ms } = timed(() => readXlsx(file));
		expect(value.ok).toBe(true);
		expect(ms).toBeLessThan(FAST_MS);
	});

	it('many stray `=`, spaces and an unterminated quote are skipped without a blow-up', () => {
		const junk = `<x ${'= '.repeat(10_000)}${'a b '.repeat(2_000)}k='v' z="/>`;
		// The unterminated quote makes the tag never close: a syntax refusal, not a hang.
		const { value, ms } = timed(() => readXlsx(buildXlsx([sheet({ before: junk })])));
		expect(value.ok).toBe(false);
		expect(ms).toBeLessThan(FAST_MS);
	});

	it('attributes of normal tags are still read (single and double quotes, spaces around =, prefixes)', () => {
		const file = buildXlsx([sheet({ before: `<ext:x a = "1" b='2' c="a&amp;b" d=e   f="3"/>` })]);
		const r = readXlsx(file);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.workbook.sheets[0]?.rows).toHaveLength(2);
	});
});

describe('M1: number formats', () => {
	it('a 40,000 x `[` format code is refused as too complex, fast', () => {
		const file = buildXlsx([sheet()], {
			extra: { 'xl/styles.xml': stylesWith('['.repeat(40_000)) }
		});
		const { value, ms } = timed(() => readXlsx(file));
		expect(value).toEqual({ ok: false, error: 'too_complex' });
		expect(ms).toBeLessThan(FAST_MS);
	});

	it('a format code of FORMAT_CODE_MAX characters is accepted; one more is refused', () => {
		const at = (n: number) => `dd/mm/yyyy${'['.repeat(n - 10)}`;
		const ok = readXlsx(
			buildXlsx([sheet()], { extra: { 'xl/styles.xml': stylesWith(at(FORMAT_CODE_MAX)) } })
		);
		expect(ok.ok).toBe(true);
		const over = readXlsx(
			buildXlsx([sheet()], { extra: { 'xl/styles.xml': stylesWith(at(FORMAT_CODE_MAX + 1)) } })
		);
		expect(over).toEqual({ ok: false, error: 'too_complex' });
	});

	it('45,000 <xf> sharing one long format code cost one classification, not 45,000', () => {
		const code = '[$'.repeat(FORMAT_CODE_MAX / 2);
		const file = buildXlsx([sheet()], {
			extra: { 'xl/styles.xml': stylesWith(code, 45_000) },
			level: 9
		});
		const { value, ms } = timed(() => readXlsx(file));
		expect(value.ok).toBe(true);
		expect(ms).toBeLessThan(FAST_MS);
	});

	it('more than FORMATS_MAX custom formats are refused', () => {
		const fmts = Array.from(
			{ length: FORMATS_MAX + 1 },
			(_, i) => `<numFmt numFmtId="${164 + i}" formatCode="0"/>`
		).join('');
		const styles = `${STYLES_OPEN}<numFmts>${fmts}</numFmts><cellXfs count="1"><xf numFmtId="164"/></cellXfs></styleSheet>`;
		expect(readXlsx(buildXlsx([sheet()], { extra: { 'xl/styles.xml': styles } }))).toEqual({
			ok: false,
			error: 'too_complex'
		});
	});

	it('the format checks are linear on unclosed `[`, `[$` and `"` runs', () => {
		for (const unit of ['[', '[$', '"', '"[', '\\']) {
			const code = unit.repeat(200_000);
			const { ms } = timed(() => [isDateFormat(code), isForeignFormat(code)]);
			expect(ms).toBeLessThan(FAST_MS);
		}
	});

	it('format classification is unchanged for normal codes', () => {
		expect(isDateFormat('dd/mm/yyyy')).toBe(true);
		expect(isDateFormat('[$-409]mmmm d, yyyy')).toBe(true);
		expect(isDateFormat('0.00 "days"')).toBe(false);
		expect(isDateFormat('#,##0 \\d')).toBe(false);
		expect(isDateFormat('[Red]#,##0')).toBe(false);
		expect(isForeignFormat('[$$-409]#,##0.00')).toBe(true);
		expect(isForeignFormat('[$Rp-421]#,##0')).toBe(false);
		expect(isForeignFormat('[$-421]#,##0')).toBe(false);
		expect(isForeignFormat('"$"#,##0')).toBe(true);
		expect(isForeignFormat('#,##0 [$€-2]')).toBe(true);
		expect(isForeignFormat('#,##0')).toBe(false);
	});

	it('a normal workbook still reads dates and foreign amounts through the cached classification', () => {
		const r = readXlsx(
			buildXlsx([
				sheet({
					rows: [
						['Tanggal', 'Jumlah'],
						[
							{ serial: serialOf('2026-10-08'), style: 'custom-date' },
							{ num: '12.5', style: 'foreign' }
						]
					]
				})
			])
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const row = r.workbook.sheets[0]?.rows[1];
		expect(row?.cells[0]).toMatchObject({ kind: 'number', date: true });
		expect(row?.cells[1]).toMatchObject({ kind: 'number', foreign: true });
	});
});

describe("L2: row numbers past Excel's last row", () => {
	it('a `<row r>` above 1,048,576 is refused; the last Excel row is read', () => {
		const rows = sheet().rows;
		const bad = readXlsx(buildXlsx([sheet({ rowNumbers: [1, SHEET_MAX_ROW + 1] })]));
		expect(bad).toEqual({ ok: false, error: 'corrupt' });
		const good = readXlsx(buildXlsx([sheet({ rows, rowNumbers: [1, SHEET_MAX_ROW] })]));
		expect(good.ok).toBe(true);
	});
});

// FN-17 L5: Excel writes `sqref` lists of thousands of ranges on these tags in heavily edited sheets. The
// reader never uses their attributes, so an open tag past XML_TAG_MAX_LENGTH no longer refuses the file.
describe('L5: a very long sqref', () => {
	/** `A1:B2 A4:B5 …` of at least `min` characters (48,595 in the 2026-10-11 repro). */
	const sqref = (min: number) => {
		const ranges: string[] = [];
		for (let i = 0, n = 0; n <= min; i++) {
			const r = `A${3 * i + 1}:B${3 * i + 2}`;
			ranges.push(r);
			n += r.length + 1;
		}
		return ranges.join(' ');
	};
	const long = sqref(48_595);

	const readsRows = (extra: Partial<FixtureSheet>) => {
		const r = readXlsx(buildXlsx([sheet(extra)]));
		expect(r).toMatchObject({ ok: true });
		if (r.ok)
			expect(r.workbook.sheets[0]?.rows.map((row) => row.cells)).toEqual([
				[
					{ kind: 'text', text: 'Tanggal' },
					{ kind: 'text', text: 'Keterangan' },
					{ kind: 'text', text: 'Jumlah' }
				],
				[
					{ kind: 'number', text: String(serialOf('2026-10-08')), date: true, foreign: false },
					{ kind: 'text', text: 'Kopi susu' },
					{ kind: 'number', text: '28000', date: false, foreign: false }
				]
			]);
	};

	it.each([
		[
			'dataValidation',
			`<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="${long}"><formula1>"a,b"</formula1></dataValidation></dataValidations>`
		],
		[
			'conditionalFormatting',
			`<conditionalFormatting sqref="${long}"><cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>0</formula></cfRule></conditionalFormatting>`
		],
		[
			'ignoredError (self-closing)',
			`<ignoredErrors><ignoredError sqref="${long}" numberStoredAsText="1"/></ignoredErrors>`
		]
	])('a %s over 40 KB after <sheetData> reads the sheet', (_, after) => {
		expect(long.length).toBeGreaterThan(Math.max(40_000, XML_TAG_MAX_LENGTH));
		readsRows({ after });
	});

	it('a long <selection sqref> in the sheet view (before <sheetData>) reads the sheet', () => {
		readsRows({
			before: `<sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="${long}"/></sheetView></sheetViews>`
		});
	});

	it('an open tag past the cap on a tag the reader uses still refuses', () => {
		const huge = 'a'.repeat(XML_TAG_MAX_LENGTH);
		const cell = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" x="${huge}"><v>1</v></c></row></sheetData></worksheet>`;
		expect(readXlsx(buildXlsx([sheet()], { extra: { 'xl/worksheets/sheet1.xml': cell } }))).toEqual(
			{ ok: false, error: 'too_complex' }
		);
		const row = `<?xml version="1.0"?><worksheet><sheetData><row r="1" x="${huge}"/></sheetData></worksheet>`;
		expect(readXlsx(buildXlsx([sheet()], { extra: { 'xl/worksheets/sheet1.xml': row } }))).toEqual({
			ok: false,
			error: 'too_complex'
		});
		expect(readXlsx(buildXlsx([sheet({ name: 'T'.repeat(XML_TAG_MAX_LENGTH) })]))).toEqual({
			ok: false,
			error: 'too_complex'
		});
	});

	it('a long sqref tag outside a worksheet (styles.xml) still refuses', () => {
		const styles = `${STYLES_OPEN}<dataValidation sqref="${long}"/></styleSheet>`;
		expect(readXlsx(buildXlsx([sheet()], { extra: { 'xl/styles.xml': styles } }))).toEqual({
			ok: false,
			error: 'too_complex'
		});
	});

	// FN-47 follow-up: this read takes about 0.3 s alone, but went past 1 s under a load average of 27 (a flake).
	// A quadratic scan of 16 MB would take minutes, so a 10 s bound still tells linear from quadratic.
	const LINEAR_16MB_MS = 10_000;

	it(
		'a 16 MB worksheet that is one long <dataValidation> reads in linear time',
		{ timeout: 30_000 },
		() => {
			// Runs of a pseudo-random range pool: compresses about 7:1, under the 100:1 ratio and the 5 MB file cap.
			let seed = 5;
			const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
			const pool = Array.from(
				{ length: 2000 },
				(_, i) => `${String.fromCharCode(65 + (rand() % 26))}${i * 3 + 1}:B${i * 3 + 2}`
			);
			const ranges: string[] = [];
			for (let n = 0; n < 16_000_000;) {
				const at = rand() % (pool.length - 8);
				for (const r of pool.slice(at, at + 8)) {
					ranges.push(r);
					n += r.length + 1;
				}
			}
			const after = `<dataValidations count="1"><dataValidation type="list" sqref="${ranges.join(' ')}"/></dataValidations>`;
			const file = buildXlsx([sheet({ after })]);
			expect(file.length).toBeLessThan(XLSX_MAX_BYTES);
			expect(after.length).toBeLessThan(XLSX_MAX_ENTRY_INFLATED);
			const { value, ms } = timed(() => readXlsx(file));
			expect(value.ok).toBe(true);
			expect(ms).toBeLessThan(LINEAR_16MB_MS);
		}
	);
});
