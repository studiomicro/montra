import { buildPdf, textContent } from '../../helpers/pdf';

/**
 * A synthetic BCA e-Statement (FN-16b): the layout of the myBCA monthly text PDF — page header, table header,
 * `DD/MM` rows whose description wraps and whose last line carries `<mutasi> [DB] [<saldo>]`, the closing block —
 * with every name, account number, description and amount invented. Nothing here comes from a real statement.
 */

export interface BcaFixture {
	/** `PERIODE : …` value, e.g. `SEPTEMBER 2026`. */
	period: string;
	currency?: string;
	/** Printed opening balance (`1,000,000.00`). */
	opening: string;
	/** Printed closing balance; null: the closing block is left out. */
	closing: string | null;
	/** The table lines of each page (rows and their wrapped description lines), in order. */
	pages: readonly (readonly string[])[];
	/** The closing block's `MUTASI CR`/`MUTASI DB` values (`<total> <count>`); left out when absent. */
	totals?: { credit: string; debit: string };
	/** Lines after the table on every page but the last (a page counter, "Bersambung …"). */
	footer?: readonly string[];
}

function header(f: BcaFixture, page: number): string[] {
	return [
		'REKENING TAHAPAN',
		'KCU CONTOH FIKTIF',
		'NAMA NASABAH FIKTIF',
		'JL CONTOH FIKTIF NO 1',
		'KOTA CONTOH 12345',
		'INDONESIA',
		'NO. REKENING : 1234567890',
		'HALAMAN :',
		`PERIODE : ${f.period}`,
		`MATA UANG : ${f.currency ?? 'IDR'}`,
		'CATATAN :',
		'Teks pemberitahuan fiktif yang tidak berisi transaksi.',
		'TANGGAL KETERANGAN CBG MUTASI SALDO',
		`${page} / ${f.pages.length}`
	];
}

/** Each page's text as the PDF text layer reads it (one line per line). */
export function bcaPages(f: BcaFixture): string[] {
	return f.pages.map((lines, i) => {
		const last = i === f.pages.length - 1;
		const opening = i === 0 ? [`01/${monthNumber(f.period)} SALDO AWAL ${f.opening}`] : [];
		const tail = last
			? f.closing === null
				? []
				: [
						`SALDO AWAL : ${f.opening}`,
						...(f.totals
							? [`MUTASI CR : ${f.totals.credit}`, `MUTASI DB : ${f.totals.debit}`]
							: []),
						`SALDO AKHIR : ${f.closing}`
					]
			: (f.footer ?? ['Bersambung ke Halaman berikut']);
		return [...header(f, i + 1), ...opening, ...lines, ...tail].join('\n');
	});
}

const MONTHS = [
	'JANUARI',
	'FEBRUARI',
	'MARET',
	'APRIL',
	'MEI',
	'JUNI',
	'JULI',
	'AGUSTUS',
	'SEPTEMBER',
	'OKTOBER',
	'NOVEMBER',
	'DESEMBER'
];
const monthNumber = (period: string) =>
	String(MONTHS.indexOf(period.split(' ')[0]!) + 1).padStart(2, '0');

/** The same statement as a text PDF, one PDF page per fixture page. */
export function bcaPdf(f: BcaFixture): Uint8Array {
	return buildPdf(bcaPages(f).map((p) => ({ content: textContent(p.split('\n')) })));
}

/**
 * Three pages, September 2026: debits marked `DB`, unmarked credits, wrapped descriptions, a date inside a
 * description, `CR` inside a description, a branch code, running balances on some rows only.
 * 1,000,000.00 + 2,501,234.56 − 285,747.41 = 3,215,487.15.
 */
export const BCA_SEPTEMBER: BcaFixture = {
	period: 'SEPTEMBER 2026',
	opening: '1,000,000.00',
	closing: '3,215,487.15',
	totals: { credit: '2,501,234.56 2', debit: '285,747.41 5' },
	pages: [
		[
			'02/09 TARIKAN ATM 02/09',
			'1234567890123456',
			'200,000.00 DB 800,000.00',
			'03/09 BIAYA ADM 0001 10,000.00 DB 790,000.00',
			'05/09 KARTU DEBIT TOKO CONTOH',
			'1234567890123456',
			'50,000.00 DB'
		],
		['05/09 KARTU DEBIT KEDAI FIKTIF', 'KOTA CONTOH', '25,500.50 DB 714,499.50'],
		[
			'10/09 BI-FAST CR BIF TRANSFER DR',
			'014',
			'PT CONTOH FIKTIF',
			'2,500,000.00 3,214,499.50',
			'30/09 BUNGA 1,234.56',
			'30/09 PAJAK BUNGA 246.91 DB 3,215,487.15'
		]
	]
};

/** The rows BCA_SEPTEMBER must read to: date, type, integer minor units, description. */
export const BCA_SEPTEMBER_ROWS = [
	['2026-09-02', 'expense', 20_000_000, 'TARIKAN ATM 02/09 1234567890123456'],
	['2026-09-03', 'expense', 1_000_000, 'BIAYA ADM 0001'],
	['2026-09-05', 'expense', 5_000_000, 'KARTU DEBIT TOKO CONTOH 1234567890123456'],
	['2026-09-05', 'expense', 2_550_050, 'KARTU DEBIT KEDAI FIKTIF KOTA CONTOH'],
	['2026-09-10', 'income', 250_000_000, 'BI-FAST CR BIF TRANSFER DR 014 PT CONTOH FIKTIF'],
	['2026-09-30', 'income', 123_456, 'BUNGA'],
	['2026-09-30', 'expense', 24_691, 'PAJAK BUNGA']
] as const;
