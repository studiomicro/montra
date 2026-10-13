import { describe, expect, it } from 'vitest';
import {
	BCA_CSV_SEPTEMBER,
	BCA_CSV_SEPTEMBER_ROWS,
	bcaCsv,
	type BcaCsvFixture
} from '../../../../test/fixtures/statements/bca-csv';
import { fictionalStatementCsv } from '../../../../test/fixtures/statements/fictional-bank';
import { csvLine, parseCsv, TEMPLATE_COLUMNS } from '../csv';
import { BCA } from './bca';
import { detectInstitution } from './detect';
import { STATEMENT_PARSERS } from './parsers';
import { balanceCheck } from './rows';
import type { MappedRow, StatementDocument } from './types';

/** The text as the statement reader turns it into a document (FN-18's CSV reader). */
function csvDoc(text: string): StatementDocument {
	const parsed = parseCsv(text);
	if (!parsed.ok) throw new Error(parsed.error);
	return { format: 'csv', rows: parsed.rows };
}
const parse = (f: BcaCsvFixture) => BCA.parse(csvDoc(bcaCsv(f)));
const values = (rows: MappedRow[]) =>
	rows.map((r) => (r.ok ? [r.value.date, r.value.type, r.value.amountMinor, r.value.title] : r));
const reasons = (rows: MappedRow[]) => rows.map((r) => (r.ok ? 'ok' : r.reason));
const EXPECTED = BCA_CSV_SEPTEMBER_ROWS.map((x) => [...x]);

/** A one-row file around `row`, opening 1000000.00. */
const oneRow = (row: string, footer: Partial<BcaCsvFixture['footer']> = {}) =>
	parse({
		rows: [row],
		footer: {
			opening: '1000000.00',
			credit: '0.00',
			debit: '10.00',
			closing: '999990.00',
			...footer
		}
	});

describe('BCA CSV detection', () => {
	it('is detected from its column row and header labels, by the shipped registry', () => {
		const doc = csvDoc(bcaCsv(BCA_CSV_SEPTEMBER));
		expect(BCA.detect(doc)).toBe(0.9);
		expect(BCA.formats).toEqual(['pdf_text', 'csv']);
		expect(detectInstitution(doc, STATEMENT_PARSERS)).toMatchObject({
			institution: { id: 'bca' },
			confidence: 0.9
		});
	});

	it('claims less without the header labels, nothing without the exact column row', () => {
		const text = bcaCsv(BCA_CSV_SEPTEMBER);
		const noLabels = text.replace(/^No\. Rekening.*\n/m, '').replace(/^Mata Uang.*\n/m, '');
		expect(BCA.detect(csvDoc(noLabels))).toBe(0.6);
		for (const column of [
			'Tanggal,Keterangan,Cabang,Jumlah,Saldo',
			'Tanggal,Keterangan,Cabang,Jumlah,,Saldo,Lain',
			'Tanggal,Uraian,Cabang,Jumlah,,Saldo'
		])
			expect(
				BCA.detect(csvDoc(text.replace('Tanggal,Keterangan,Cabang,Jumlah,,Saldo', column)))
			).toBe(0);
	});

	it('never claims a FN-18 template, another institution’s CSV, or a column row far below the top', () => {
		expect(BCA.detect(csvDoc(csvLine(TEMPLATE_COLUMNS)))).toBe(0);
		expect(BCA.detect(csvDoc(fictionalStatementCsv()))).toBe(0);
		const late = `${'Catatan,=,x\n'.repeat(25)}${bcaCsv(BCA_CSV_SEPTEMBER)}`;
		expect(BCA.detect(csvDoc(late))).toBe(0);
		expect(BCA.parse(csvDoc(late)).inconsistent).toBe(true);
	});
});

describe('BCA CSV rows', () => {
	it('reads every row: DB debits, CR credits, full WIB dates, quote marks dropped, spaces collapsed', () => {
		const r = parse(BCA_CSV_SEPTEMBER);
		expect(values(r.rows)).toEqual(EXPECTED);
		expect(r.rows.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(r).toMatchObject({
			openingBalanceMinor: 100_000_000,
			closingBalanceMinor: 321_548_715,
			inconsistent: false
		});
		expect(balanceCheck(r)).toEqual({ status: 'pass' });
	});

	it('never puts the header, the account number, the name or the footer into a row', () => {
		const titles = parse(BCA_CSV_SEPTEMBER)
			.rows.map((x) => (x.ok ? `${x.value.title} ${x.value.reference}` : ''))
			.join(' ');
		expect(titles).not.toMatch(/1234567890(?!123456)|NASABAH|Saldo|Kredit|Debet|Rekening|'/);
	});

	it('reads the same with CRLF, a BOM, semicolons, quoted cells and comma-grouped amounts', () => {
		const text = bcaCsv(BCA_CSV_SEPTEMBER);
		const variants = [
			text.replaceAll('\n', '\r\n'),
			`\uFEFF${text}`,
			text.replaceAll(',', ';'),
			text.replace('BIAYA ADM ,', '"BIAYA ADM ",').replace(',DB,800000.00', ',"DB","800000.00"'),
			text.replace(',200000.00,DB,800000.00', ',"200,000.00",DB,"800,000.00"')
		];
		for (const v of variants) {
			const r = BCA.parse(csvDoc(v));
			expect(values(r.rows)).toEqual(EXPECTED);
			expect(r.inconsistent).toBe(false);
		}
	});

	it('a comma inside a remark only widens the description; the bank’s last four columns decide the row', () => {
		const r = oneRow("'02/09/2026,TRANSFER, KE TEMAN,'0000,10.00,DB,999990.00");
		expect(values(r.rows)).toEqual([['2026-09-02', 'expense', 1000, 'TRANSFER, KE TEMAN']]);
		expect(r.inconsistent).toBe(false);
	});

	it('an empty statement (no rows) still reconciles', () => {
		const empty = parse({
			rows: [],
			footer: { opening: '5.00', credit: '0.00', debit: '0.00', closing: '5.00' }
		});
		expect(empty).toMatchObject({ rows: [], inconsistent: false });
	});
});

describe('BCA CSV self-checks: refused whole, never imported with a warning', () => {
	const bad = (f: Partial<BcaCsvFixture>) => parse({ ...BCA_CSV_SEPTEMBER, ...f }).inconsistent;
	const footer = (over: Partial<BcaCsvFixture['footer']>) => ({
		...BCA_CSV_SEPTEMBER.footer,
		...over
	});

	it('a dropped row, a wrong running balance, closing balance or credit/debit total', () => {
		const rows = BCA_CSV_SEPTEMBER.rows;
		expect(bad({ rows: rows.filter((_, i) => i !== 2) })).toBe(true);
		expect(
			bad({ rows: rows.map((l, i) => (i === 3 ? l.replace(/714499\.50$/, '714499.51') : l)) })
		).toBe(true);
		expect(bad({ rows: rows.map((l, i) => (i === 3 ? l.replace(/,714499\.50$/, ',') : l)) })).toBe(
			true
		);
		expect(bad({ footer: footer({ closing: '3215487.16' }) })).toBe(true);
		expect(bad({ footer: footer({ credit: '2501234.55' }) })).toBe(true);
		expect(bad({ footer: footer({ debit: '285747.42' }) })).toBe(true);
		expect(bad({ footer: footer({ opening: '1000000.01' }) })).toBe(true);
	});

	it('a missing footer line, a repeated or unknown label, a row after the footer, a stray record', () => {
		for (const k of ['opening', 'credit', 'debit', 'closing'] as const)
			expect(bad({ footer: footer({ [k]: null }) })).toBe(true);
		const text = bcaCsv(BCA_CSV_SEPTEMBER);
		const variants = [
			`${text}Saldo Akhir,=,3215487.15\n`,
			`${text}Bunga,=,0.00\n`,
			`${text}'30/09/2026,BUNGA,'0000,1.00,CR,3215488.15\n`,
			text.replace('Tanggal,Keterangan', 'CATATAN FIKTIF\nTanggal,Keterangan'),
			text.replace("'03/09/2026", "SISA BARIS FIKTIF\n'03/09/2026"),
			text.replace("'03/09/2026,BIAYA ADM ,'0000", "'03/09/2026,'0000")
		];
		for (const v of variants) expect(BCA.parse(csvDoc(v)).inconsistent).toBe(true);
	});

	it('a pending (PEND), impossible or two-digit-year date is an unreadable row', () => {
		for (const date of ['PEND', '31/02/2026', '02/09/26', '2026-09-02']) {
			const r = oneRow(`'${date},BIAYA FIKTIF,'0000,10.00,DB,999990.00`);
			expect(r.inconsistent).toBe(true);
		}
		expect(reasons(oneRow("'PEND,BIAYA FIKTIF,'0000,10.00,DB,999990.00").rows)).toEqual([
			'unparseable_date'
		]);
		expect(reasons(oneRow("'31/02/2026,BIAYA FIKTIF,'0000,10.00,DB,999990.00").rows)).toEqual([
			'unparseable_date'
		]);
	});

	it('an unknown mark, an Indonesian or negative amount, zero, or an amount past the cap is unreadable', () => {
		for (const cells of [
			'10.00,D,999990.00',
			'10.00,,999990.00',
			'"10,00",DB,999990.00',
			'-10.00,DB,999990.00',
			'0.00,DB,1000000.00',
			'10,DB,999990.00',
			'1000000000000.00,CR,1000001000000.00'
		])
			expect(reasons(oneRow(`'02/09/2026,BIAYA FIKTIF,'0000,${cells}`).rows)).toEqual([
				'unparseable_amount'
			]);
	});

	it('a non-IDR account is never read as rupiah; a missing or disputed currency is refused', () => {
		const usd = parse({ ...BCA_CSV_SEPTEMBER, currency: 'USD' });
		expect(new Set(reasons(usd.rows))).toEqual(new Set(['unsupported_currency']));
		const text = bcaCsv(BCA_CSV_SEPTEMBER);
		expect(BCA.parse(csvDoc(text.replace(/^Mata Uang.*\n/m, ''))).inconsistent).toBe(true);
		const twice = text.replace('Mata Uang,=,IDR', 'Mata Uang,=,IDR\nMata Uang,=,USD');
		expect(new Set(reasons(BCA.parse(csvDoc(twice)).rows))).toEqual(
			new Set(['unsupported_currency'])
		);
	});
});

describe('BCA CSV hostile remarks (red team M1, FN-16b)', () => {
	const two = (first: string, second: string) =>
		parse({
			rows: [
				`'10/09/2026,${first},'0000,10.00,CR,1000010.00`,
				`'11/09/2026,${second},'0000,10.00,CR,1000020.00`
			],
			footer: { opening: '1000000.00', credit: '20.00', debit: '0.00', closing: '1000020.00' }
		});

	it('remarks that imitate an amount, a mark or a whole row never decide one (the zero-gap vector)', () => {
		const r = two(
			"BI-FAST CR 1000010.00 CR,'0000,1000010.00,CR,2000010.00",
			"BI-FAST CR,'0000,999990.00,DB,1000020.00"
		);
		expect(values(r.rows).map((v) => (Array.isArray(v) ? v.slice(0, 3) : v))).toEqual([
			['2026-09-10', 'income', 1000],
			['2026-09-11', 'income', 1000]
		]);
		expect(r.inconsistent).toBe(false);
	});

	it('a remark imitating the footer or the header stays a description (quoted) or refuses the file (bare)', () => {
		const quoted = two('"Saldo Akhir,=,1.00"', '"Tanggal,Keterangan,Cabang,Jumlah,,Saldo"');
		expect(quoted.inconsistent).toBe(false);
		expect(values(quoted.rows).map((v) => (Array.isArray(v) ? v[3] : v))).toEqual([
			'Saldo Akhir,=,1.00',
			'Tanggal,Keterangan,Cabang,Jumlah,,Saldo'
		]);
		// A line break inside an unquoted remark splits the record: both halves are refused, never read.
		for (const remark of [
			'X\nSaldo Akhir,=,1000020.00\nY',
			"X\n'12/09/2026,FORGED,'0000,5.00,CR,1000025.00\nY",
			'X\nKredit,=,20.00\nY'
		])
			expect(two(remark, 'BI-FAST CR').inconsistent).toBe(true);
	});

	it('red team L1: a remark that is just `=` stays a row of its own, never a label', () => {
		const r = two('=', 'BI-FAST CR');
		expect(r.inconsistent).toBe(false);
		expect(values(r.rows).map((v) => (Array.isArray(v) ? v[3] : v))).toEqual(['=', 'BI-FAST CR']);
	});

	it('formula-looking descriptions are kept as text and leave an export guarded', () => {
		const r = two('=HYPERLINK("http://contoh.invalid")', '@SUM(1+1)');
		expect(r.inconsistent).toBe(false);
		const titles = r.rows.map((x) => (x.ok ? x.value.title : ''));
		expect(titles).toEqual(['=HYPERLINK("http://contoh.invalid")', '@SUM(1+1)']);
		for (const t of [...titles, '+1', '-1']) expect(csvLine([t])).toMatch(/^"?'/);
	});

	it('huge input stays bounded and linear', () => {
		const rows = Array.from(
			// The reader keeps CSV_MAX_ROWS records: header, column row, rows and footer must fit.
			{ length: 4990 },
			(_, i) => `'02/09/2026,${'X'.repeat(200)},'0000,1.00,CR,${1000001 + i}.00`
		);
		const big = bcaCsv({
			rows,
			footer: { opening: '1000000.00', credit: '4990.00', debit: '0.00', closing: '1004990.00' }
		});
		const t0 = performance.now();
		const r = BCA.parse(csvDoc(big));
		expect(r.inconsistent).toBe(false);
		expect(r.rows).toHaveLength(4990);
		const long = `'02/09/2026,X,'0000,${'1'.repeat(1_000_000)}.00,CR,${'9'.repeat(1_000_000)}.00`;
		expect(oneRow(long).inconsistent).toBe(true);
		expect(performance.now() - t0).toBeLessThan(5000);
	});
});
