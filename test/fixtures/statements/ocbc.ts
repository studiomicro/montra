import { buildPdf, textContent } from '../../helpers/pdf';

/**
 * A synthetic OCBC consolidated statement (FN-16f): the layout of the monthly text PDF as its text layer reads —
 * a summary page, the portfolio lists (`REKENING TABUNGAN / …` with one `<product> <account> <ISO> <balance>` line
 * per account), then one `LAPORAN MUTASI REKENING` table per account (currency and account lines, the column
 * header ending `Saldo /`, `Balance`, `Saldo Awal`, rows of `DD-Mon-YYYY DD-Mon-YYYY <type>` + wrapped description
 * lines + `<debet> <kredit> <saldo>`, `Saldo Akhir`), a disclaimer page and the bank footer on every page — with
 * every name, account number, description and amount invented. Nothing here comes from a real statement.
 */

export interface OcbcRow {
	/** `DD-Mon-YYYY`; the value date is the same unless `valueDate` is given. */
	date: string;
	valueDate?: string;
	/** The bank's transaction type, printed on the row's first line. */
	type: string;
	/** Wrapped description lines after the first line. */
	remarks?: readonly string[];
	/** `1,234.56`; exactly one of debit/credit for a real row (the other prints `0.00`). */
	debit?: string;
	credit?: string;
	/** Print the amounts on the row's last description line instead of a line of their own. */
	tail?: boolean;
	/** Printed running balance; default: the correct one. */
	balance?: string;
}

export interface OcbcAccount {
	product: string;
	/** Fictional account number. */
	account: string;
	currency?: string;
	/** The portfolio list it is printed under; null: not listed at all. Default `TABUNGAN`. */
	group?: 'TABUNGAN' | 'GIRO' | 'DEPOSITO' | null;
	/** Printed opening balance, `1,000,000.00`. */
	opening: string;
	/** Printed closing balance; default: computed from the rows. */
	closing?: string;
	/** Rows per page (a page break between arrays); a `string[]` is inserted as raw lines. */
	pages: readonly (readonly (OcbcRow | readonly string[])[])[];
}

export interface OcbcFixture {
	period?: string;
	accounts: readonly OcbcAccount[];
}

const toMinor = (printed: string) => Number(printed.replace(/[,.]/g, ''));
/** Integer minor units → `1,234,567.89` (test code only; the app formats with its shared formatter). */
export const usd = (minor: number) => {
	const whole = Math.floor(minor / 100)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `${whole}.${String(minor % 100).padStart(2, '0')}`;
};

const FOOTER = [
	'PT Bank OCBC NISP Tbk berizin',
	'dan diawasi oleh Otoritas Jasa Keuangan & Bank Indonesia,',
	'Alamat : Jalan Contoh Fiktif No. 1, Kota Contoh 12345'
];

const TABLE_HEADER = [
	'Trans Date',
	'Tgl Trans / Tgl Efektif /',
	'Value Date',
	'Deskripsi /',
	'Description',
	'Debet /',
	'Debit',
	'Kredit /',
	'Credit',
	'Saldo /',
	'Balance'
];

const GROUP_HEADINGS = {
	TABUNGAN: [
		'REKENING TABUNGAN / SAVING',
		'Jumlah Rekening Tabungan /Total Saving Ekuivalen IDR 0'
	],
	GIRO: ['REKENING GIRO / CURRENT', 'Jumlah Rekening Giro /Total Current Ekuivalen IDR 0'],
	DEPOSITO: [
		'REKENING DEPOSITO / TIME DEPOSIT',
		'Jumlah Rekening Deposito /Total Time Deposit Ekuivalen IDR 0'
	]
} as const;

/** One row → its printed lines, given the balance before it; returns the lines and the balance after. */
function rowLines(row: OcbcRow, before: number): { lines: string[]; after: number } {
	const debit = row.debit ?? '0.00';
	const credit = row.credit ?? '0.00';
	const after = before - toMinor(debit) + toMinor(credit);
	const amounts = `${debit} ${credit} ${row.balance ?? usd(after)}`;
	const lines = [`${row.date} ${row.valueDate ?? row.date} ${row.type}`, ...(row.remarks ?? [])];
	if (row.tail) lines[lines.length - 1] = `${lines[lines.length - 1]} ${amounts}`;
	else lines.push(amounts);
	return { lines, after };
}

/** Each page's text as the PDF text layer reads it (one line per line). */
export function ocbcPages(f: OcbcFixture): string[] {
	const period = f.period ?? '01 July 2026 - 31 July 2026';
	const bodies: { kind: 'summary' | 'list' | 'table' | 'disclaimer'; lines: string[] }[] = [];
	bodies.push({
		kind: 'summary',
		lines: [
			'LAPORAN PORTOFOLIO / SUMMARY OF ACCOUNT',
			'NASABAH FIKTIF',
			'Pribadi & Rahasia / Private & Confidential',
			'LAPORAN KONSOLIDASI / CONSOLIDATED STATEMENT',
			`Tanggal Pelaporan : ${period}`,
			'Halaman / Page : 1 dari',
			'Rekening Tabungan',
			'Rekening Giro',
			'0.00',
			'Jumlah / Total Deposits'
		]
	});
	const list: string[] = [
		'NASABAH FIKTIF',
		'Nama Produk /',
		'Product Name',
		'No Rekening /',
		'Account Number',
		'Mata Uang /',
		'Currency',
		'Saldo /',
		'Balance'
	];
	for (const group of ['TABUNGAN', 'GIRO', 'DEPOSITO'] as const) {
		const listed = f.accounts.filter(
			(a) => (a.group === undefined ? 'TABUNGAN' : a.group) === group
		);
		if (listed.length === 0) continue;
		const [heading, total] = GROUP_HEADINGS[group];
		list.push(heading);
		for (const a of listed)
			list.push(`${a.product} ${a.account} ${a.currency ?? 'IDR'} ${a.opening.split('.')[0]}`);
		list.push(total);
	}
	bodies.push({ kind: 'list', lines: list });
	for (const a of f.accounts) {
		let running = toMinor(a.opening);
		a.pages.forEach((rows, i) => {
			const lines = [
				'LAPORAN MUTASI REKENING / ACCOUNT HISTORICAL TRANSACTION',
				'NASABAH FIKTIF',
				'\u0000',
				`Mata Uang / Currency : ${a.currency ?? 'IDR'}`,
				`No Rekening / Account Number : ${a.account}-${a.product}`,
				'Cabang / Branch : 00001-CABANG FIKTIF',
				...TABLE_HEADER
			];
			if (i === 0) lines.push(`Saldo Awal ${a.opening}`);
			for (const row of rows) {
				if (!('type' in row)) {
					lines.push(...row);
					continue;
				}
				const printed = rowLines(row, running);
				running = printed.after;
				lines.push(...printed.lines);
			}
			if (i === a.pages.length - 1) lines.push(`Saldo Akhir ${a.closing ?? usd(running)}`);
			bodies.push({ kind: 'table', lines });
		});
	}
	bodies.push({
		kind: 'disclaimer',
		lines: ['PERNYATAAN PENGECUALIAN LAPORAN KONSOLIDASI', 'Teks pernyataan fiktif.']
	});
	const total = bodies.length;
	return bodies.map(({ kind, lines }, i) => {
		const counter = `/ofHalaman / Page : ${i + 1} dari ${total}`;
		// The summary page prints the period in its own lines, a table page next to its title (the `\u0000` line).
		const head =
			kind === 'list' || kind === 'disclaimer' ? [`Tanggal Pelaporan: ${period}`, counter] : [];
		const body = lines.map((l) => (l === '\u0000' ? `Tanggal Pelaporan: ${period} ${counter}` : l));
		return [...head, ...body, ...FOOTER].join('\n');
	});
}

/** The same statement as a text PDF, one PDF page per fixture page. */
export function ocbcPdf(f: OcbcFixture, password?: string): Uint8Array {
	return buildPdf(
		ocbcPages(f).map((p) => ({ content: textContent(p.split('\n')) })),
		password ? { password } : undefined
	);
}

/**
 * July 2026: a savings account over two pages (its IDR table), the same account's USD sub-account (listed, never
 * importable) and a current account.
 * Tabungan: 2,000,000.00 + 5,000,000.00 − 1,250,000.00 − 87,500.50 + 1,234.00 − 246.80 = 5,663,486.70.
 * USD: 10.00 + 0.37. Giro: 500,000.00 − 125,000.00 + 100.00 = 375,100.00.
 */
export const OCBC_JULY: OcbcFixture = {
	accounts: [
		{
			product: 'Tabungan Fiktif',
			account: '700100200300',
			opening: '2,000,000.00',
			pages: [
				[
					{
						date: '02-Jul-2026',
						type: 'Transfer Masuk Fiktif/',
						remarks: ['- PENGIRIM FIKTIF/'],
						credit: '5,000,000.00'
					},
					{
						date: '05-Jul-2026',
						type: 'Transfer Keluar Fiktif/',
						remarks: ['- Berita : PENERIMA FIKTIF/', 'Sewa fiktif'],
						debit: '1,250,000.00'
					}
				],
				[
					{
						date: '15-Jul-2026',
						type: 'Belanja Kartu Fiktif',
						remarks: ['- Berita : TOKO CONTOH FIKTIF'],
						debit: '87,500.50'
					},
					{
						date: '31-Jul-2026',
						type: 'Bunga Rekening Fiktif',
						remarks: ['-'],
						credit: '1,234.00'
					},
					{ date: '31-Jul-2026', type: 'Pajak Bunga Fiktif -', debit: '246.80', tail: true }
				]
			]
		},
		{
			product: 'Tabungan Fiktif',
			account: '700100200300',
			currency: 'USD',
			opening: '10.00',
			pages: [[{ date: '31-Jul-2026', type: 'Bunga Fiktif', remarks: ['-'], credit: '0.37' }]]
		},
		{
			product: 'Giro Fiktif',
			account: '700100200999',
			group: 'GIRO',
			opening: '500,000.00',
			pages: [
				[
					{
						date: '10-Jul-2026',
						type: 'Transfer Keluar Fiktif/',
						remarks: ['- Berita : PEMASOK FIKTIF/', 'Bahan fiktif'],
						debit: '125,000.00',
						tail: true
					},
					{
						date: '31-Jul-2026',
						type: 'Bunga Rekening Fiktif',
						remarks: ['-'],
						credit: '100.00'
					}
				]
			]
		}
	]
};

/** The rows each OCBC_JULY section reads to (the USD one reads none): date, type, minor units, description. */
export const OCBC_JULY_ROWS = [
	[
		['2026-07-02', 'income', 500_000_000, 'Transfer Masuk Fiktif/ - PENGIRIM FIKTIF/'],
		[
			'2026-07-05',
			'expense',
			125_000_000,
			'Transfer Keluar Fiktif/ - Berita : PENERIMA FIKTIF/ Sewa fiktif'
		],
		['2026-07-15', 'expense', 8_750_050, 'Belanja Kartu Fiktif - Berita : TOKO CONTOH FIKTIF'],
		['2026-07-31', 'income', 123_400, 'Bunga Rekening Fiktif -'],
		['2026-07-31', 'expense', 24_680, 'Pajak Bunga Fiktif -']
	],
	[],
	[
		[
			'2026-07-10',
			'expense',
			12_500_000,
			'Transfer Keluar Fiktif/ - Berita : PEMASOK FIKTIF/ Bahan fiktif'
		],
		['2026-07-31', 'income', 10_000, 'Bunga Rekening Fiktif -']
	]
] as const;

/** One savings account only (the common statement): OCBC_JULY's first account. */
export const OCBC_SINGLE: OcbcFixture = { accounts: [OCBC_JULY.accounts[0]!] };

/** `OCBC_SINGLE` with its last row's description lines replaced (and, optionally, its amounts). */
export function ocbcWithLastRemarks(
	remarks: readonly string[],
	over: Partial<OcbcRow> = {}
): OcbcFixture {
	const [first] = OCBC_SINGLE.accounts;
	const pages = first!.pages.map((p) => [...p]);
	const last = pages[pages.length - 1]!;
	const row = last[last.length - 1] as OcbcRow;
	last[last.length - 1] = { ...row, remarks, tail: false, ...over };
	return { accounts: [{ ...first!, pages }] };
}
