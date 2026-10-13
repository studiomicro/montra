import { describe, expect, it } from 'vitest';
import { BCA_SEPTEMBER, bcaPages } from '../../../../test/fixtures/statements/bca';
import {
	BNI_JUNE,
	BNI_JUNE_ROWS,
	bniPages,
	bniRow,
	type BniFixture
} from '../../../../test/fixtures/statements/bni';
import { FICTIONAL_LINES } from '../../../../test/fixtures/statements/fictional-bank';
import { BCA } from './bca';
import { BNI, bniPeriod } from './bni';
import { detectInstitution } from './detect';
import { STATEMENT_PARSERS } from './parsers';
import { balanceCheck } from './rows';
import type { MappedRow, StatementDocument } from './types';

const doc = (f: BniFixture): StatementDocument => ({ format: 'pdf_text', pages: bniPages(f) });
const parse = (f: BniFixture) => BNI.parse(doc(f));
const pdf = (pages: string[]): StatementDocument => ({ format: 'pdf_text', pages });
const values = (rows: MappedRow[]) =>
	rows.map((r) => (r.ok ? [r.value.date, r.value.type, r.value.amountMinor, r.value.title] : r));
const reasons = (rows: MappedRow[]) => rows.map((r) => (r.ok ? 'ok' : r.reason));

/** A one-page June statement around `rows`, opening 1,000,000. */
const single = (
	rows: string[],
	closing: string,
	totals: { credit: string; debit: string },
	over: Partial<BniFixture> = {}
): BniFixture => ({
	period: '1 - 30 Juni 2026',
	opening: '1,000,000',
	closing,
	totals,
	pages: [rows],
	...over
});

describe('BNI detection', () => {
	it('is detected from its title, bank line and table header, and is in the shipped registry', () => {
		expect(BNI.detect(doc(BNI_JUNE))).toBe(0.9);
		expect(detectInstitution(doc(BNI_JUNE), STATEMENT_PARSERS).institution?.id).toBe('bni');
	});

	it('claims less without the title, nothing without the table header, never a CSV', () => {
		const noTitle = bniPages(BNI_JUNE).map((p) => p.replace('Laporan Mutasi Rekening', ''));
		expect(BNI.detect(pdf(noTitle))).toBe(0.6);
		const noHeader = bniPages(BNI_JUNE).map((p) =>
			p.replace('Tanggal & Waktu Rincian Transaksi Nominal (IDR) Saldo (IDR)', 'Tanggal')
		);
		expect(BNI.detect(pdf(noHeader))).toBe(0);
		expect(BNI.detect({ format: 'csv', rows: [['Tanggal', 'Nominal', 'Saldo']] })).toBe(0);
		expect(BNI.parse({ format: 'csv', rows: [] })).toMatchObject({ inconsistent: true });
	});

	it('BCA and BNI never claim each other, and another layout is neither', () => {
		expect(BCA.detect(doc(BNI_JUNE))).toBe(0);
		expect(BNI.detect(pdf(bcaPages(BCA_SEPTEMBER)))).toBe(0);
		expect(detectInstitution(pdf(bcaPages(BCA_SEPTEMBER)), STATEMENT_PARSERS).institution?.id).toBe(
			'bca'
		);
		const other = pdf([Object.values(FICTIONAL_LINES).flat().join('\n')]);
		expect(BNI.detect(other)).toBe(0);
	});
});

describe('BNI period', () => {
	it('takes the start month and year from the end, or the previous year across New Year', () => {
		expect(bniPeriod('1 - 30 Juni 2026')).toEqual({ from: '2026-06-01', to: '2026-06-30' });
		expect(bniPeriod('16 Mei - 15 Juni 2026')).toEqual({ from: '2026-05-16', to: '2026-06-15' });
		expect(bniPeriod('16 Desember - 15 Januari 2027')).toEqual({
			from: '2026-12-16',
			to: '2027-01-15'
		});
		expect(bniPeriod('1 Desember 2025 - 31 Januari 2026')).toEqual({
			from: '2025-12-01',
			to: '2026-01-31'
		});
	});

	it('an impossible, reversed or unknown period is null', () => {
		for (const p of ['31 - 30 Juni 2026', '1 - 31 Juni 2026', '1 - 30 June 2026', 'Juni 2026', ''])
			expect(bniPeriod(p)).toBeNull();
	});
});

describe('BNI rows', () => {
	it('reads every row across three pages in order: signed nominal is the direction', () => {
		const r = parse(BNI_JUNE);
		expect(values(r.rows)).toEqual(BNI_JUNE_ROWS.map((x) => [...x]));
		expect(r.rows.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(r.inconsistent).toBe(false);
	});

	it('keeps headers, the summary, opening/closing rows, counters and notes out of the rows', () => {
		const r = parse(BNI_JUNE);
		expect(r.openingBalanceMinor).toBe(100_000_000);
		expect(r.closingBalanceMinor).toBe(280_275_000);
		const titles = r.rows.map((x) => (x.ok ? x.value.title : '')).join(' ');
		expect(titles).not.toMatch(/Saldo|Laporan|Periode|OJK|dari|Informasi|TAPLUS|WIB|NASABAH/);
	});

	it('reconciles exactly: opening + credits − debits = closing, every running balance and total agrees', () => {
		const r = parse(BNI_JUNE);
		expect(balanceCheck(r)).toEqual({ status: 'pass' });
		expect(r.inconsistent).toBe(false);
	});

	it('reads a period across New Year with each printed year', () => {
		const r = parse(
			single(
				[
					...bniRow('20 Des 2026', 'Biaya', 'Administrasi -10,000 990,000'),
					...bniRow('5 Jan 2027', 'Transfer', '- PT CONTOH FIKTIF +20,000 1,010,000')
				],
				'1,010,000',
				{ credit: '20,000', debit: '10,000' },
				{ period: '16 Desember - 15 Januari 2027' }
			)
		);
		expect(values(r.rows).map((v) => (Array.isArray(v) ? v[0] : v))).toEqual([
			'2026-12-20',
			'2027-01-05'
		]);
		expect(r.inconsistent).toBe(false);
	});

	it('accepts cents and keeps them exact', () => {
		const r = parse(
			single(
				bniRow('3 Jun 2026', 'Bunga', 'Bunga Tabungan +1,234.56 1,001,234.56'),
				'1,001,234.56',
				{ credit: '1,234.56', debit: '0' }
			)
		);
		expect(values(r.rows)).toEqual([['2026-06-03', 'income', 123_456, 'Bunga Bunga Tabungan']]);
		expect(r.inconsistent).toBe(false);
	});
});

/** One-row June statements: −25,000 from 1,000,000. */
const OK_ROW = bniRow('1 Jun 2026', 'Pembayaran Qris', 'KEDAI FIKTIF - KOTA -25,000 975,000');
const OK_TOTALS = { credit: '0', debit: '25,000' };

describe('BNI self-checks: anything that does not check out refuses the whole statement', () => {
	it('the sound one-row statement passes (control)', () => {
		expect(parse(single(OK_ROW, '975,000', OK_TOTALS)).inconsistent).toBe(false);
	});

	it('a dropped page, a page counter that does not match, or a period that differs per page', () => {
		const dropped = { ...BNI_JUNE, pages: [BNI_JUNE.pages[0]!, BNI_JUNE.pages[2]!] };
		expect(parse(dropped).inconsistent).toBe(true);
		expect(parse({ ...BNI_JUNE, counterTotal: 4 }).inconsistent).toBe(true);
		const pages = bniPages(BNI_JUNE);
		pages[1] = pages[1]!.replace('1 - 30 Juni 2026', '1 - 31 Juli 2026');
		expect(BNI.parse(pdf(pages)).inconsistent).toBe(true);
		const noCounter = bniPages(BNI_JUNE);
		noCounter[2] = noCounter[2]!.replace(/ 3 dari 3/, '');
		expect(BNI.parse(pdf(noCounter)).inconsistent).toBe(true);
	});

	it('a running balance, a total, the opening or the closing that disagrees', () => {
		const tampered = bniRow('1 Jun 2026', 'Pembayaran Qris', 'KEDAI FIKTIF -25,000 976,000');
		expect(parse(single(tampered, '975,000', OK_TOTALS)).inconsistent).toBe(true);
		expect(parse(single(OK_ROW, '975,000', { credit: '0', debit: '24,000' })).inconsistent).toBe(
			true
		);
		expect(parse(single(OK_ROW, '975,000', { credit: '1', debit: '25,000' })).inconsistent).toBe(
			true
		);
		expect(parse(single(OK_ROW, '970,000', OK_TOTALS)).inconsistent).toBe(true);
		// The table's opening row differs from the summary.
		const pages = bniPages(single(OK_ROW, '975,000', OK_TOTALS));
		expect(
			BNI.parse(pdf([pages[0]!.replace('Saldo Awal 1,000,000', 'Saldo Awal 1,000,001')]))
		).toMatchObject({ inconsistent: true, openingBalanceMinor: null });
	});

	it('a missing summary total, closing or currency line', () => {
		expect(parse({ ...single(OK_ROW, '975,000', OK_TOTALS), totals: undefined }).inconsistent).toBe(
			true
		);
		const noCurrency = bniPages(single(OK_ROW, '975,000', OK_TOTALS)).map((p) =>
			p.replace(/ - Mata Uang: IDR/, '')
		);
		expect(BNI.parse(pdf(noCurrency)).inconsistent).toBe(true);
		const noClosingRow = bniPages(single(OK_ROW, '975,000', OK_TOTALS)).map((p) =>
			p.replace('Saldo Akhir 975,000', '')
		);
		expect(BNI.parse(pdf(noClosingRow)).inconsistent).toBe(true);
	});

	it('a non-IDR statement is refused as unsupported currency', () => {
		const r = parse(single(OK_ROW, '975,000', OK_TOTALS, { currency: 'USD' }));
		expect(reasons(r.rows)).toEqual(['unsupported_currency']);
	});

	it('a date outside the period, an unknown month, an impossible day or no time line', () => {
		for (const date of ['1 Jul 2026', '1 Jun 2025', '1 Jux 2026', '31 Jun 2026']) {
			const r = parse(single(bniRow(date, 'Biaya', 'Biaya -25,000 975,000'), '975,000', OK_TOTALS));
			expect(reasons(r.rows)).toEqual(['unparseable_date']);
			expect(r.inconsistent).toBe(true);
		}
		const noTime = ['1 Jun 2026', 'Biaya', 'Biaya -25,000 975,000'];
		expect(reasons(parse(single(noTime, '975,000', OK_TOTALS)).rows)).toEqual(['unparseable_date']);
	});

	it('a row whose amount is on the next page is unreadable', () => {
		const split: BniFixture = {
			...single([], '975,000', OK_TOTALS),
			pages: [OK_ROW.slice(0, 3), OK_ROW.slice(3)]
		};
		const r = parse(split);
		expect(reasons(r.rows)).toEqual(['missing_amount']);
		expect(r.inconsistent).toBe(true);
	});

	it('a zero amount or one past the cap is unreadable', () => {
		const zero = bniRow('1 Jun 2026', 'Biaya', 'Biaya -0 1,000,000');
		expect(reasons(parse(single(zero, '1,000,000', { credit: '0', debit: '0' })).rows)).toEqual([
			'unparseable_amount'
		]);
		const huge = bniRow('1 Jun 2026', 'Transfer', '- X +100,000,000,000,000 100,000,001,000,000');
		expect(
			parse(single(huge, '100,000,001,000,000', { credit: '100,000,000,000,000', debit: '0' }))
				.inconsistent
		).toBe(true);
	});
});

describe('BNI forged rows (third-party merchant, sender and remark text)', () => {
	it('a merchant name holding a signed amount and balance never decides the amount', () => {
		const row = bniRow(
			'1 Jun 2026',
			'Pembayaran Qris',
			'TOKO -999,000 1,000 - KOTA -25,000 975,000'
		);
		const r = parse(single(row, '975,000', OK_TOTALS));
		expect(values(r.rows)).toEqual([
			['2026-06-01', 'expense', 2_500_000, 'Pembayaran Qris TOKO -999,000 1,000 - KOTA']
		]);
		expect(r.inconsistent).toBe(false);
	});

	it('a remark line shaped like an amount line makes the row ambiguous (two transfers of 10 cancelling)', () => {
		// The FN-16b M1 vector adapted: forged +1,000,010 / −999,990 lines that would sum to the true +20.
		const rows = [
			...['10 Jun 2026', '09:00:00 WIB', 'Transfer', '- PENGIRIM +1,000,010 2,000,010'],
			'- PENGIRIM +10 1,000,010',
			...['11 Jun 2026', '09:00:00 WIB', 'Transfer', '- PENGIRIM -999,990 1,000,020'],
			'- PENGIRIM +10 1,000,020'
		];
		const r = parse(single(rows, '1,000,020', { credit: '20', debit: '0' }));
		expect(reasons(r.rows)).toEqual(['unparseable_amount', 'unparseable_amount']);
		expect(r.inconsistent).toBe(true);
	});

	it('a remark that forges amount and a matching balance on its own line is still ambiguous', () => {
		const rows = [
			...['1 Jun 2026', '09:00:00 WIB', 'Transfer', 'BERITA +500,000 1,500,000'],
			'- PENGIRIM +10 1,000,010'
		];
		const r = parse(single(rows, '1,500,000', { credit: '500,000', debit: '0' }));
		expect(reasons(r.rows)).toEqual(['unparseable_amount']);
		expect(r.inconsistent).toBe(true);
	});

	it('a date-shaped remark line splitting a row is refused', () => {
		const rows = [
			'1 Jun 2026',
			'09:00:00 WIB',
			'Transfer',
			'2 Jun 2026',
			'09:00:00 WIB',
			'- PENGIRIM -25,000 975,000'
		];
		const r = parse(single(rows, '975,000', OK_TOTALS));
		expect(reasons(r.rows)).toEqual(['missing_amount', 'ok']);
		expect(r.inconsistent).toBe(true);
	});

	it('a remark imitating the closing row: inside an unfinished row it is text; after a row it ends the table and is refused', () => {
		const inside = [
			...['1 Jun 2026', '09:00:00 WIB', 'Transfer', 'Saldo Akhir 975,000'],
			'- PENGIRIM -25,000 975,000'
		];
		const a = parse(single(inside, '975,000', OK_TOTALS));
		expect(reasons(a.rows)).toEqual(['ok']);
		expect(a.inconsistent).toBe(false);
		const after = [
			...OK_ROW,
			'Saldo Akhir 975,000',
			...bniRow('2 Jun 2026', 'Biaya', 'X -1 974,999')
		];
		expect(parse(single(after, '974,999', { credit: '0', debit: '25,001' })).inconsistent).toBe(
			true
		);
	});

	it('a remark imitating the opening row between rows adds a third opening and is refused', () => {
		const rows = [...OK_ROW, 'Saldo Awal 975,000'];
		expect(parse(single(rows, '975,000', OK_TOTALS))).toMatchObject({
			inconsistent: true,
			openingBalanceMinor: null
		});
	});

	it('a page counter, period or currency inside the table is ignored (the header decides)', () => {
		const rows = [
			...[
				'1 Jun 2026',
				'09:00:00 WIB',
				'Pembayaran Qris',
				'Periode: 1 - 31 Juli 2026 Mata Uang: USD'
			],
			'KEDAI 9 dari 9 -25,000 975,000'
		];
		const r = parse(single(rows, '975,000', OK_TOTALS));
		expect(reasons(r.rows)).toEqual(['ok']);
		expect(r.inconsistent).toBe(false);
	});
});

describe('BNI on hostile input', () => {
	it('long and repetitive lines are read in bounded time', () => {
		const lines = [
			'-1 '.repeat(100_000),
			`${'1,000'.repeat(50_000)}`,
			` +${'1,000,'.repeat(50_000)}000 1`,
			'1 Jun 2026\n'.repeat(20_000),
			`Saldo Awal\n`.repeat(20_000)
		];
		const started = performance.now();
		for (const l of lines) BNI.parse(pdf([bniPages(single([l], '1', OK_TOTALS))[0]!]));
		expect(performance.now() - started).toBeLessThan(3_000);
	});
});
