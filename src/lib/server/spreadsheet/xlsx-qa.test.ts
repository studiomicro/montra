import { describe, expect, it } from 'vitest';
import { proposeTab } from '#lib/shared/spreadsheet/layout';
import { mapSheets } from '#lib/shared/spreadsheet/rows';
import type { SheetMapping } from '#lib/shared/spreadsheet/types';
import { buildXlsx, serialOf, type FixtureSheet } from '../../../../test/helpers/xlsx';
import { readXlsx } from './xlsx-read';

// FN-17 QA cycle 1: gaps found while checking the PRD (AC 7 on every XML part, AC 16 the 1904 system end to end).

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const BOMB = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>';

const sheet = (): FixtureSheet => ({
	name: 'Transaksi',
	rows: [
		['Tanggal', 'Keterangan', 'Jumlah'],
		[{ serial: 46296 }, 'Kopi susu', 28000]
	]
});

describe('AC 7: a DOCTYPE or ENTITY is refused in every part the reader inflates', () => {
	const parts: Record<string, string> = {
		'xl/styles.xml': `${HEAD}${BOMB}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`,
		'xl/sharedStrings.xml': `${HEAD}${BOMB}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>&lol2;</t></si></sst>`,
		'xl/_rels/workbook.xml.rels': `${HEAD}${BOMB}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
		'[Content_Types].xml': `${HEAD}${BOMB}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
		'xl/worksheets/sheet1.xml': `${HEAD}${BOMB}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>`
	};
	for (const [name, xml] of Object.entries(parts)) {
		it(name, () => {
			const r = readXlsx(buildXlsx([sheet()], { extra: { [name]: xml } }));
			expect(r.ok).toBe(false);
			// Never a workbook with an expanded entity in it.
			expect(JSON.stringify(r)).not.toContain('lollol');
		});
	}

	it('lower-case <!doctype and a bare <!ENTITY (no DOCTYPE wrapper) in a sheet', () => {
		for (const mark of ['<!doctype html>', '<!ENTITY x "y">']) {
			expect(readXlsx(buildXlsx([{ ...sheet(), before: mark }]))).toEqual({
				ok: false,
				error: 'unsafe_xml'
			});
		}
	});

	it('an XML comment cannot hide the marker: DOCTYPE after a comment is still refused', () => {
		expect(readXlsx(buildXlsx([sheet()], { workbookPrologue: `<!-- ok -->${BOMB}` }))).toEqual({
			ok: false,
			error: 'unsafe_xml'
		});
	});
});

describe('AC 16: the 1904 date system, from the file to the row', () => {
	// 1900-system serial of the date, less the 1,462 days between the two epochs.
	const s1904 = (date: string) => serialOf(date) - 1462;
	const book = (date1904: boolean) =>
		buildXlsx(
			[
				{
					name: 'Okt',
					rows: [
						['Tanggal', 'Keterangan', 'Pengeluaran'],
						[{ serial: s1904('2026-01-31') }, 'Akhir Januari', 10000],
						[{ serial: s1904('2026-02-01') }, 'Awal Februari', 20000],
						[{ serial: s1904('2026-12-31'), style: 'custom-date' }, 'Akhir tahun', 30000],
						[{ serial: s1904('2027-01-01') + 0.9999 }, 'Awal tahun', 40000]
					]
				}
			],
			{ date1904 }
		);

	function mapped(date1904: boolean) {
		const r = readXlsx(book(date1904));
		if (!r.ok) throw new Error(r.error);
		const g = r.workbook.sheets[0]!;
		const p = proposeTab(g, r.workbook.date1904);
		if ('skip' in p) throw new Error('skipped');
		const mapping: SheetMapping = { tabs: [{ ...p.mapping, use: true }], fillDown: false };
		const out = mapSheets(r.workbook, mapping, 5000);
		return out.rows.flatMap((x) =>
			x.ok ? [{ date: x.value.date, minor: x.value.amountMinor }] : []
		);
	}

	it('<workbookPr date1904="1"> reads 31 Jan / 1 Feb / 31 Dec / 1 Jan as the calendar dates, time dropped', () => {
		expect(mapped(true)).toEqual([
			{ date: '2026-01-31', minor: 1_000_000 },
			{ date: '2026-02-01', minor: 2_000_000 },
			{ date: '2026-12-31', minor: 3_000_000 },
			{ date: '2027-01-01', minor: 4_000_000 }
		]);
	});

	it('the same serials in a 1900-system file are different dates (the flag is what decides)', () => {
		expect(mapped(false).map((r) => r.date)).not.toContain('2026-01-31');
	});
});
