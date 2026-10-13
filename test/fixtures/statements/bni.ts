import { buildPdf, textContent } from '../../helpers/pdf';

/**
 * A synthetic BNI "Laporan Mutasi Rekening" (FN-16d): the layout of BNI's mutasi PDF — a header on every page
 * ending with the `<n> dari <total>` page counter, the page 1 holder block and summary, the table header, dated
 * rows of date / time / kind / detail-with-`<±nominal> <saldo>`, the closing row and notes on the last page — with
 * every name, account number, description and amount invented. Nothing here comes from a real statement.
 */

export interface BniFixture {
	/** `Periode:` value, e.g. `1 - 30 Juni 2026`. */
	period: string;
	currency?: string;
	/** Printed opening balance (`1,000,000`). */
	opening: string;
	/** Printed closing balance; null: the summary value and the closing row are left out. */
	closing: string | null;
	/** Summary `Total Pemasukan` / `Total Pengeluaran` values without sign; left out when absent. */
	totals?: { credit: string; debit: string };
	/** The table lines of each page (rows), in order. */
	pages: readonly (readonly string[])[];
	/** Page counter total printed on every page (default: the real page count). */
	counterTotal?: number;
}

/** One transaction row as BNI prints it: date, time, kind, then the detail line ending in the amounts. */
export const bniRow = (date: string, kind: string, detail: string, time = '09:30:00') => [
	date,
	`${time} WIB`,
	kind,
	detail
];

function header(f: BniFixture, page: number): string[] {
	return [
		'Laporan Mutasi Rekening',
		`Periode: ${f.period}`,
		'PT Bank Negara Indonesia (Persero) Tbk. berizin dan diawasi oleh Otoritas Jasa Keuangan (OJK) serta merupakan',
		`peserta penjaminan Lembaga Penjamin Simpanan (LPS). ${page} dari ${f.counterTotal ?? f.pages.length}`
	];
}

function summary(f: BniFixture): string[] {
	return [
		'NAMA NASABAH FIKTIF',
		'JL CONTOH FIKTIF NO 1 RT 01 RW 02, KEL. CONTOH',
		'KOTA CONTOH, PROV. CONTOH',
		'TAPLUS - 1234567890',
		`Kantor Cabang: CONTOH FIKTIF - Mata Uang: ${f.currency ?? 'IDR'}`,
		'Saldo Awal',
		f.opening,
		...(f.totals
			? ['Total Pemasukan', `+${f.totals.credit}`, 'Total Pengeluaran', `-${f.totals.debit}`]
			: []),
		...(f.closing === null ? [] : ['Saldo Akhir', f.closing])
	];
}

const TABLE_HEADER = 'Tanggal & Waktu Rincian Transaksi Nominal (IDR) Saldo (IDR)';
const NOTES = [
	'Informasi Penting',
	'1. Laporan ini fiktif dan hanya untuk pengujian, bukan bukti transaksi 2 dari 3',
	'2. Data pada laporan ini tidak berasal dari rekening mana pun.'
];

/** Each page's text as the PDF text layer reads it (one line per line). */
export function bniPages(f: BniFixture): string[] {
	return f.pages.map((lines, i) => {
		const first = i === 0;
		const last = i === f.pages.length - 1;
		return [
			...header(f, i + 1),
			...(first ? summary(f) : []),
			TABLE_HEADER,
			...(first ? [`Saldo Awal ${f.opening}`] : []),
			...lines,
			...(last && f.closing !== null ? [`Saldo Akhir ${f.closing}`, ...NOTES] : [])
		].join('\n');
	});
}

/** The same statement as a text PDF, one PDF page per fixture page; `password` encrypts it (RC4). */
export function bniPdf(f: BniFixture, password?: string): Uint8Array {
	return buildPdf(
		bniPages(f).map((p) => ({ content: textContent(p.split('\n')) })),
		password === undefined ? {} : { password }
	);
}

/**
 * Three pages, June 2026: QRIS and virtual-account debits, transfers in and out, a fee, interest, single-digit
 * days, account numbers in descriptions. 1,000,000 + 2,501,250 − 698,500 = 2,802,750.
 */
export const BNI_JUNE: BniFixture = {
	period: '1 - 30 Juni 2026',
	opening: '1,000,000',
	closing: '2,802,750',
	totals: { credit: '2,501,250', debit: '698,500' },
	pages: [
		[
			...bniRow(
				'1 Jun 2026',
				'Pembayaran Qris',
				'KEDAI FIKTIF - KOTA CONTOH -25,000 975,000',
				'08:15:00'
			),
			...bniRow('2 Jun 2026', 'Transfer', '- PT CONTOH FIKTIF +2,500,000 3,475,000'),
			...bniRow(
				'05 Jun 2026',
				'Virtual Account',
				'TOKO DARING FIKTIF - 8808123456789012 -150,000 3,325,000'
			)
		],
		[
			...bniRow('10 Jun 2026', 'Pembayaran Qris', 'QRIS WARUNG FIKTIF ID -12,500 3,312,500'),
			...bniRow('15 Jun 2026', 'Transfer', 'BNI KE BANK LAIN - 1234567890123 -500,000 2,812,500')
		],
		[
			...bniRow('30 Jun 2026', 'Biaya', 'Administrasi Rekening -11,000 2,801,500', '23:59:59'),
			...bniRow('30 Jun 2026', 'Bunga', 'Bunga Tabungan +1,250 2,802,750', '23:59:59')
		]
	]
};

/** The rows BNI_JUNE must read to: date, type, integer minor units, description. */
export const BNI_JUNE_ROWS = [
	['2026-06-01', 'expense', 2_500_000, 'Pembayaran Qris KEDAI FIKTIF - KOTA CONTOH'],
	['2026-06-02', 'income', 250_000_000, 'Transfer - PT CONTOH FIKTIF'],
	['2026-06-05', 'expense', 15_000_000, 'Virtual Account TOKO DARING FIKTIF - 8808123456789012'],
	['2026-06-10', 'expense', 1_250_000, 'Pembayaran Qris QRIS WARUNG FIKTIF ID'],
	['2026-06-15', 'expense', 50_000_000, 'Transfer BNI KE BANK LAIN - 1234567890123'],
	['2026-06-30', 'expense', 1_100_000, 'Biaya Administrasi Rekening'],
	['2026-06-30', 'income', 125_000, 'Bunga Bunga Tabungan']
] as const;
