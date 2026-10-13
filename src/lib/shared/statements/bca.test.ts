import { describe, expect, it } from 'vitest';
import {
	BCA_SEPTEMBER,
	BCA_SEPTEMBER_ROWS,
	bcaPages,
	type BcaFixture
} from '../../../../test/fixtures/statements/bca';
import { FICTIONAL_LINES } from '../../../../test/fixtures/statements/fictional-bank';
import { maskAccountNumbers } from '../text';
import { BCA } from './bca';
import { detectInstitution } from './detect';
import { STATEMENT_PARSERS } from './parsers';
import { balanceCheck } from './rows';
import type { MappedRow, StatementDocument } from './types';

const doc = (f: BcaFixture): StatementDocument => ({ format: 'pdf_text', pages: bcaPages(f) });
const parse = (f: BcaFixture) => BCA.parse(doc(f));
const pdf = (pages: string[]): StatementDocument => ({ format: 'pdf_text', pages });
const values = (rows: MappedRow[]) =>
	rows.map((r) => (r.ok ? [r.value.date, r.value.type, r.value.amountMinor, r.value.title] : r));
const reasons = (rows: MappedRow[]) => rows.map((r) => (r.ok ? 'ok' : r.reason));

describe('BCA detection', () => {
	it('is detected from its table header and period line, and is the shipped registry entry', () => {
		expect(BCA.detect(doc(BCA_SEPTEMBER))).toBe(0.9);
		expect(detectInstitution(doc(BCA_SEPTEMBER), STATEMENT_PARSERS).institution?.id).toBe('bca');
	});

	it('claims less without a period line, nothing without the table header or for an unrelated CSV', () => {
		const noPeriod = bcaPages(BCA_SEPTEMBER).map((p) => p.replace(/PERIODE : .*/, ''));
		expect(BCA.detect(pdf(noPeriod))).toBe(0.6);
		const noHeader = bcaPages(BCA_SEPTEMBER).map((p) =>
			p.replace('TANGGAL KETERANGAN CBG MUTASI SALDO', 'TANGGAL KETERANGAN')
		);
		expect(BCA.detect(pdf(noHeader))).toBe(0);
		expect(BCA.detect({ format: 'csv', rows: [['TANGGAL', 'KETERANGAN', 'MUTASI']] })).toBe(0);
		expect(BCA.parse({ format: 'csv', rows: [] }).rows).toEqual([]);
	});

	it('does not claim another statement, and another layout does not become BCA', () => {
		const other = pdf([Object.values(FICTIONAL_LINES).flat().join('\n')]);
		expect(BCA.detect(other)).toBe(0);
		expect(detectInstitution(other, STATEMENT_PARSERS).institution).toBeNull();
	});
});

/** A one-page September statement around `lines`, opening 1,000,000.00. */
const single = (lines: string[], closing: string | null, totals?: BcaFixture['totals']) =>
	parse({ period: 'SEPTEMBER 2026', opening: '1,000,000.00', closing, totals, pages: [lines] });

describe('BCA rows', () => {
	it('reads every row across three pages in order: DB debits, unmarked credits, wrapped descriptions', () => {
		const r = parse(BCA_SEPTEMBER);
		expect(values(r.rows)).toEqual(BCA_SEPTEMBER_ROWS.map((x) => [...x]));
		expect(r.rows.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(r.inconsistent).toBe(false);
	});

	it('keeps the opening line, running balances, page headers, footers and closing block out of the rows', () => {
		const r = parse(BCA_SEPTEMBER);
		expect(r.openingBalanceMinor).toBe(100_000_000);
		expect(r.closingBalanceMinor).toBe(321_548_715);
		const titles = r.rows.map((x) => (x.ok ? x.value.title : ''));
		expect(titles.join(' ')).not.toMatch(/SALDO|Bersambung|REKENING|PERIODE|HALAMAN|MUTASI/);
	});

	it('reconciles exactly: opening + credits − debits = closing, running balances and totals agree', () => {
		const r = parse(BCA_SEPTEMBER);
		expect(balanceCheck(r)).toEqual({ status: 'pass' });
		expect(r.inconsistent).toBe(false);
	});

	it('a dropped row makes the statement inconsistent (refused whole), not a warning', () => {
		const dropped: BcaFixture = {
			...BCA_SEPTEMBER,
			pages: [BCA_SEPTEMBER.pages[0]!, [], BCA_SEPTEMBER.pages[2]!]
		};
		expect(parse(dropped).inconsistent).toBe(true);
	});

	it('a wrong running balance, closing balance or printed total is inconsistent', () => {
		const ok = ['02/09 BUNGA', '100.00 1,000,100.00'];
		expect(single(ok, '1,000,100.00', { credit: '100.00 1', debit: '0.00 0' }).inconsistent).toBe(
			false
		);
		expect(single(['02/09 BUNGA', '100.00 1,000,200.00'], '1,000,100.00').inconsistent).toBe(true);
		expect(single(ok, '1,000,200.00').inconsistent).toBe(true);
		expect(single(ok, '1,000,100.00', { credit: '200.00 1', debit: '0.00 0' }).inconsistent).toBe(
			true
		);
		expect(single(ok, '1,000,100.00', { credit: '100.00 2', debit: '0.00 0' }).inconsistent).toBe(
			true
		);
		expect(single(ok, null).inconsistent).toBe(true);
	});

	it('an amount marked CR is a credit', () => {
		const r = single(['04/09 SETORAN TUNAI', '100,000.00 CR 1,100,000.00'], '1,100,000.00');
		expect(values(r.rows)).toEqual([['2026-09-04', 'income', 10_000_000, 'SETORAN TUNAI']]);
		expect(r.inconsistent).toBe(false);
	});

	it('a wrapped line that starts with a date continues the open row until its amount line', () => {
		// Real layout (BCA March 2026): `TANGGAL :09/03` then `09/03 /ZW7Q1/00000` before the amount line.
		const r = single(
			[
				'10/09 TRSF E-BANKING DB',
				'TANGGAL :09/09',
				'09/09 /ZW7Q1/00000',
				'NAMA CONTOH',
				'400,000.00 DB 600,000.00',
				'11/09 BUNGA 1,000.00'
			],
			'601,000.00',
			{ credit: '1,000.00 1', debit: '400,000.00 1' }
		);
		expect(values(r.rows)).toEqual([
			[
				'2026-09-10',
				'expense',
				40_000_000,
				'TRSF E-BANKING DB TANGGAL :09/09 09/09 /ZW7Q1/00000 NAMA CONTOH'
			],
			['2026-09-11', 'income', 100_000, 'BUNGA']
		]);
		expect(r.inconsistent).toBe(false);
	});

	it('a row cut off at its page end is rejected, and the next page does not continue it', () => {
		const r = parse({
			...BCA_SEPTEMBER,
			pages: [['02/09 KARTU DEBIT TOKO CONTOH', 'TANPA NOMINAL'], ['03/09 BUNGA 1,000.00']]
		});
		expect(reasons(r.rows)).toEqual(['missing_amount', 'ok']);
		expect(values(r.rows)[1]).toEqual(['2026-09-03', 'income', 100_000, 'BUNGA']);
		expect(r.inconsistent).toBe(true);
	});

	it('the closing block ends an open row instead of lending it an amount', () => {
		const r = parse({ ...BCA_SEPTEMBER, pages: [['29/09 KARTU DEBIT TOKO CONTOH']] });
		expect(reasons(r.rows)).toEqual(['missing_amount']);
		expect(r.inconsistent).toBe(true);
	});

	it('wrapped lines join with a space, so a card number split across lines is masked whole', () => {
		const r = single(
			['02/09 KARTU DEBIT 1234 5678', '9012 3456', '50,000.00 DB 950,000.00'],
			'950,000.00'
		);
		const [row] = r.rows;
		expect(row!.ok && maskAccountNumbers(row!.value.title)).toBe('KARTU DEBIT ••••3456');
		// A date before a card number is masked with it (more hidden, never less).
		const [atm] = parse(BCA_SEPTEMBER).rows;
		expect(atm!.ok && maskAccountNumbers(atm!.value.title)).toBe('TARIKAN ATM 02/••••3456');
	});
});

describe('BCA year and period', () => {
	const one = (period: string, line: string): MappedRow[] =>
		parse({ period, opening: '0.00', closing: null, pages: [[line]] }).rows;

	it('takes the year from the printed period across a December → January rollover', () => {
		expect(values(one('DESEMBER 2025', '31/12 BUNGA 1,000.00'))[0]).toEqual([
			'2025-12-31',
			'income',
			100_000,
			'BUNGA'
		]);
		expect(values(one('JANUARI 2026', '01/01 BUNGA 1,000.00'))[0]).toEqual([
			'2026-01-01',
			'income',
			100_000,
			'BUNGA'
		]);
	});

	it('a day outside the printed month, an impossible day, or no period line is an unreadable date', () => {
		expect(reasons(one('JANUARI 2026', '31/12 BUNGA 1,000.00'))).toEqual(['unparseable_date']);
		expect(reasons(one('FEBRUARI 2026', '29/02 BUNGA 1,000.00'))).toEqual(['unparseable_date']);
		expect(reasons(one('FEBRUARI 2028', '29/02 BUNGA 1,000.00'))).toEqual(['ok']);
		expect(reasons(one('BULANLAIN 2026', '01/01 BUNGA 1,000.00'))).toEqual(['unparseable_date']);
		const noPeriod = bcaPages({ ...BCA_SEPTEMBER, pages: [['02/09 BUNGA 1,000.00']] }).map((p) =>
			p.replace(/PERIODE : .*/, '')
		);
		expect(reasons(BCA.parse(pdf(noPeriod)).rows)).toEqual(['unparseable_date']);
	});

	it('pages that disagree on the period are inconsistent', () => {
		const pages = bcaPages(BCA_SEPTEMBER);
		pages[1] = pages[1]!.replace('PERIODE : SEPTEMBER 2026', 'PERIODE : OKTOBER 2026');
		const r = BCA.parse(pdf(pages));
		expect(r.inconsistent).toBe(true);
		expect(new Set(reasons(r.rows))).toEqual(new Set(['unparseable_date']));
	});

	it('an empty month: no rows, the balances still reconcile', () => {
		const r = parse({ ...BCA_SEPTEMBER, totals: undefined, closing: '1,000,000.00', pages: [[]] });
		expect(r.rows).toEqual([]);
		expect(balanceCheck(r)).toEqual({ status: 'pass' });
		expect(r.inconsistent).toBe(false);
	});

	it('without a closing block the opening line still counts, but the statement is not accepted', () => {
		const r = parse({ ...BCA_SEPTEMBER, closing: null });
		expect(r.openingBalanceMinor).toBe(100_000_000);
		expect(balanceCheck(r)).toEqual({ status: 'omitted' });
		expect(r.inconsistent).toBe(true);
	});

	it('a non-IDR account is never read as rupiah — on any page, not just the first', () => {
		const r = parse({ ...BCA_SEPTEMBER, currency: 'USD' });
		expect(new Set(reasons(r.rows))).toEqual(new Set(['unsupported_currency']));
		expect(balanceCheck(r)).toEqual({ status: 'omitted' });
		const pages = bcaPages(BCA_SEPTEMBER);
		pages[2] = pages[2]!.replace('MATA UANG : IDR', 'MATA UANG : USD');
		expect(new Set(reasons(BCA.parse(pdf(pages)).rows))).toEqual(new Set(['unsupported_currency']));
		const odd = bcaPages(BCA_SEPTEMBER);
		odd[1] = odd[1]!.replace('MATA UANG : IDR', 'MATA UANG : RUPIAH');
		expect(new Set(reasons(BCA.parse(pdf(odd)).rows))).toEqual(new Set(['unsupported_currency']));
	});
});

describe('BCA hostile and malformed text (red team M1)', () => {
	it('two remark-forged transfers that cancel out never import and never pass (the red team vector)', () => {
		const r = single(
			[
				'10/09 BI-FAST CR TRANSFER DR',
				'PENGIRIM',
				'1,000,010.00',
				'10.00 1,000,010.00',
				'11/09 BI-FAST CR TRANSFER DR',
				'PENGIRIM',
				'999,990.00 DB',
				'10.00 1,000,020.00'
			],
			'1,000,020.00'
		);
		expect(reasons(r.rows)).toEqual(['unparseable_amount', 'unparseable_amount']);
		expect(r.inconsistent).toBe(true);
	});

	it('a merchant name ending in an amount cannot turn a debit into a credit', () => {
		const r = single(['05/09 KARTU DEBIT KEDAI 900.00', '25,500.50 DB 974,499.50'], '974,499.50');
		expect(reasons(r.rows)).toEqual(['unparseable_amount']);
		expect(r.inconsistent).toBe(true);
	});

	it('a remark line starting with DD/MM cannot open a forged row: it stays in the open row', () => {
		const r = single(
			['10/09 BI-FAST CR TRANSFER DR', '12/09 GAJI', '100.00 1,000,100.00'],
			'1,000,100.00'
		);
		expect(values(r.rows)).toEqual([
			['2026-09-10', 'income', 10_000, 'BI-FAST CR TRANSFER DR 12/09 GAJI']
		]);
		expect(r.inconsistent).toBe(false);
		// A dated remark that also carries an amount is a second amount line: unreadable, refused whole.
		const forged = single(
			['10/09 BI-FAST CR TRANSFER DR', '12/09 GAJI 900,000.00', '100.00 1,000,100.00'],
			'1,000,100.00'
		);
		expect(reasons(forged.rows)).toEqual(['unparseable_amount']);
		expect(forged.inconsistent).toBe(true);
	});

	it('a remark imitating the closing block cannot drop rows or change the closing balance', () => {
		const r = parse({
			...BCA_SEPTEMBER,
			pages: [
				[
					'02/09 BI-FAST CR BIF TRANSFER DR',
					'SALDO AKHIR : 9,999,999.99',
					'100,000.00 1,100,000.00',
					...BCA_SEPTEMBER.pages[0]!
				],
				...BCA_SEPTEMBER.pages.slice(1)
			]
		});
		expect(r.closingBalanceMinor).toBeNull();
		expect(r.inconsistent).toBe(true);
	});

	it('a remark that adds a matching running balance still cannot slip a forged amount past the chain', () => {
		// The forged line comes before the real one: two amount lines, unreadable.
		const r = single(
			['10/09 BI-FAST CR', '900,000.00 1,900,000.00', '10.00 1,000,010.00'],
			'1,900,000.00'
		);
		expect(reasons(r.rows)).toEqual(['unparseable_amount']);
		expect(r.inconsistent).toBe(true);
	});

	it('cycle 2 L1: a remark equal to the table header cannot move amounts between one sender’s rows', () => {
		const header = 'TANGGAL KETERANGAN CBG MUTASI SALDO';
		const r = single(
			[
				'10/09 BI-FAST CR TRANSFER DR',
				'PENGIRIM',
				'5.00',
				header,
				'10.00',
				'10/09 BI-FAST CR TRANSFER DR',
				'PENGIRIM',
				'15.00',
				header,
				'10.00 1,000,020.00'
			],
			'1,000,020.00',
			{ credit: '20.00 2', debit: '0.00 0' }
		);
		// The real amount lines after the forged header belong to no row: the statement is refused whole.
		expect(r.inconsistent).toBe(true);
	});

	it('garbage, unreadable amounts and a table with no header yield no invented rows', () => {
		expect(BCA.parse(pdf(['', '\u0000\u0001', 'TANGGAL KETERANGAN'])).rows).toEqual([]);
		const r = parse({
			...BCA_SEPTEMBER,
			// One page each: a row without its amount line would otherwise take the next dated line as a wrap.
			pages: [
				['02/09 TOKO CONTOH 1.000,00 DB'],
				['03/09 TOKO CONTOH 12,34.00 DB'],
				['99/99 X 1.00']
			]
		});
		expect(reasons(r.rows)).toEqual(['missing_amount', 'missing_amount', 'unparseable_date']);
		expect(r.inconsistent).toBe(true);
	});

	it('an amount past the one-transaction cap is unreadable, never summed', () => {
		const r = single(['02/09 X', '90,071,992,547,409.91 90,071,993,547,409.91'], null);
		expect(reasons(r.rows)).toEqual(['unparseable_amount']);
	});

	it('huge input stays bounded and linear', () => {
		const rows = Array.from({ length: 20_000 }, () => '05/09 KARTU DEBIT TOKO CONTOH 1,000.00 DB');
		const longLine = `05/09 ${'1,000'.repeat(100_000)} ${'9 '.repeat(100_000)}`;
		const started = performance.now();
		const r = parse({ ...BCA_SEPTEMBER, closing: null, pages: [rows, [longLine]] });
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(r.rows).toHaveLength(20_001);
		expect(r.rows.at(-1)).toMatchObject({ ok: false, reason: 'missing_amount' });
		expect(r.inconsistent).toBe(true);
	});
});
