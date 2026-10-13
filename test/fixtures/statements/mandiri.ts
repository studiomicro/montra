import { buildPdf, textContent } from '../../helpers/pdf';

/**
 * A synthetic Bank Mandiri consolidated e-Statement (FN-16e): the layout of the Livin' monthly text PDF as its
 * text layer reads — page header labels then values, an account block (number, currency, the opening / dana
 * masuk / dana keluar / closing summary, the product heading) where an account starts, the table header on every
 * page, rows of remark lines + `<saldo><No> <±nominal>` + `HH:MM:SS WIB` + `DD Mon YYYY`, the bank footer — with
 * every name, account number, remark and amount invented. Nothing here comes from a real statement.
 */

export interface MandiriRow {
	remarks: readonly string[];
	/** Signed nominal as printed: `+25.000,00` or `-10.000,00`. */
	amount: string;
	/** `DD Mon YYYY`. */
	date: string;
	/** Print the last remark on the amount line (as long remarks often do). */
	tail?: boolean;
	/** Printed running balance (`1.025.000,00`); default: the correct one. */
	balance?: string;
	/** Printed row number; default: the next one. */
	no?: number;
}

export interface MandiriAccount {
	product: string;
	currency?: string;
	/** Fictional account number. */
	account: string;
	/** Printed opening balance, `1.000.000,00`. */
	opening: string;
	/** Printed summary values; default: computed from the rows. */
	credit?: string;
	debit?: string;
	closing?: string;
	/** Rows per page (a page break between arrays); a `string[]` is inserted as raw lines. */
	pages: readonly (readonly (MandiriRow | readonly string[])[])[];
	/** Start on the same page as the previous account's last page instead of a new page. */
	samePage?: boolean;
}

export interface MandiriFixture {
	period?: string;
	accounts: readonly MandiriAccount[];
	/** Account blocks with no table (a card or investment summary), printed on their own page before the rest. */
	summaryOnly?: readonly { product: string; account: string; opening: string; closing: string }[];
}

const toMinor = (printed: string) => Number(printed.replace(/[+\-. ]/g, '').replace(',', ''));
/** Integer minor units → `1.234.567,89` (test code only; the app formats with its shared formatter). */
export const idr = (minor: number) => {
	const whole = Math.floor(minor / 100)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
	return `${whole},${String(minor % 100).padStart(2, '0')}`;
};

const FOOTER = [
	'PT Bank Mandiri (Persero) Tbk. berizin dan diawasi oleh Otoritas Jasa Keuangan (OJK) dan Bank Indonesia (BI),',
	'serta merupakan peserta penjamin Lembaga Penjamin Simpanan (LPS) Mandiri Call 14000'
];

function pageHeader(period: string, page: number, total: number, block: string[]): string[] {
	return [
		'Gedung Contoh Fiktif 1 Jalan Contoh Fiktif Kav. 1-2, Kota Contoh 12345, Indonesia',
		'e-Statement',
		'Nama/Name',
		'Cabang/Branch',
		':',
		': Diterbitkan pada/Issued on',
		'Periode/Period',
		':',
		':',
		...(block.length > 0
			? [
					'Nomor Rekening/Account Number',
					'Mata Uang/Currency',
					':Saldo Awal/Initial Balance',
					'Dana Masuk/Incoming Transactions :',
					'Dana Keluar/Outgoing Transactions :',
					'Saldo Akhir/Closing Balance :'
				]
			: []),
		'NAMA NASABAH FIKTIF',
		'KCP CONTOH FIKTIF',
		period,
		'01 Sep 2026',
		...block.slice(0, 2),
		`${page} of ${total}`,
		...block.slice(2)
	];
}

function tableHeader(currency: string): string[] {
	return [
		'1 dari',
		'No',
		'No',
		'Date',
		`Tanggal Saldo (${currency})`,
		`Balance (${currency})`,
		`Nominal (${currency})`,
		`Amount (${currency})`,
		'Keterangan',
		'Remarks'
	];
}

/** The account block lines: `<number>:`, `: <ccy>`, opening, `+ in`, `- out`, closing, heading. */
function accountBlock(a: {
	product: string;
	currency: string;
	account: string;
	opening: string;
	credit: string;
	debit: string;
	closing: string;
}): string[] {
	return [
		`${a.account}:`,
		`: ${a.currency}`,
		a.opening,
		`+ ${a.credit}`,
		`- ${a.debit}`,
		a.closing,
		`${a.product} ${a.currency}`
	];
}

/** Each page's text as the PDF text layer reads it (one line per line). */
export function mandiriPages(f: MandiriFixture): string[] {
	const period = f.period ?? '01 Aug 2026 - 31 Aug 2026';
	const pages: string[][] = [];
	for (const s of f.summaryOnly ?? [])
		pages.push(
			accountBlock({
				...s,
				currency: 'IDR',
				credit: '0,00',
				debit: '0,00'
			})
		);
	for (const a of f.accounts) {
		const currency = a.currency ?? 'IDR';
		let running = toMinor(a.opening);
		let credit = 0;
		let debit = 0;
		let no = 0;
		const tables = a.pages.map((rows) =>
			rows.flatMap((row) => {
				if (!('remarks' in row)) return [...row];
				const minor = toMinor(row.amount);
				const isCredit = row.amount.startsWith('+');
				running += isCredit ? minor : -minor;
				if (isCredit) credit += minor;
				else debit += minor;
				no++;
				const remarks = [...row.remarks];
				const tail = row.tail ? `${remarks.pop()} ` : '';
				return [
					...remarks,
					`${tail}${row.balance ?? idr(running)}${row.no ?? no} ${row.amount}`,
					'10:15:00 WIB',
					row.date
				];
			})
		);
		const block = accountBlock({
			product: a.product,
			currency,
			account: a.account,
			opening: a.opening,
			credit: a.credit ?? idr(credit),
			debit: a.debit ?? idr(debit),
			closing: a.closing ?? idr(running)
		});
		tables.forEach((table, i) => {
			const lines = [...tableHeader(currency), ...table];
			if (i === 0 && a.samePage && pages.length > 0) {
				// A second account on the same page: its block labels, values and heading follow the first table.
				pages[pages.length - 1]!.push('Nomor Rekening/Account Number', ...block, ...lines);
			} else pages.push(i === 0 ? [...block, '\u0000', ...lines] : ['\u0000', ...lines]);
		});
	}
	const total = pages.length;
	return pages.map((body, i) => {
		const split = body.indexOf('\u0000');
		const block = split > 0 ? body.slice(0, split) : split < 0 ? body : [];
		const rest = split >= 0 ? body.slice(split + 1) : [];
		return [...pageHeader(period, i + 1, total, block), ...rest, ...FOOTER].join('\n');
	});
}

/** The same statement as a text PDF, one PDF page per fixture page. */
export function mandiriPdf(f: MandiriFixture, password?: string): Uint8Array {
	return buildPdf(
		mandiriPages(f).map((p) => ({ content: textContent(p.split('\n')) })),
		password ? { password } : undefined
	);
}

/**
 * Two savings accounts and a credit-card summary, August 2026. The first account runs over two pages (a
 * continuation page with no account block) and has a remark printed on the amount line.
 * Tabungan: 1.000.000,00 + 2.500.000,00 − 260.500,50 = 3.239.499,50. Giro: 500.000,00 − 125.000,00 + 10.000,00.
 */
export const MANDIRI_AUGUST: MandiriFixture = {
	summaryOnly: [
		{
			product: 'Kartu Kredit Fiktif',
			account: '4111000011112222',
			opening: '0,00',
			closing: '0,00'
		}
	],
	accounts: [
		{
			product: 'Tabungan Fiktif',
			account: '1230009876543',
			opening: '1.000.000,00',
			pages: [
				[
					{
						remarks: ['Transfer dari BANK FIKTIF', 'DARI PENGIRIM FIKTIF', 'Gaji fiktif'],
						amount: '+2.500.000,00',
						date: '01 Aug 2026'
					},
					{
						remarks: ['Biaya transfer BI Fast'],
						amount: '-2.500,00',
						date: '03 Aug 2026',
						tail: true
					}
				],
				[
					{
						remarks: ['Transfer ke BANK MANDIRI', 'PENERIMA FIKTIF 1110002223334'],
						amount: '-250.000,00',
						date: '15 Agu 2026'
					},
					{ remarks: ['Pajak rekening'], amount: '-8.000,50', date: '31 Aug 2026', tail: true }
				]
			]
		},
		{
			product: 'Giro Fiktif',
			account: '1230005556667',
			opening: '500.000,00',
			pages: [
				[
					{
						remarks: ['QR fiktif', 'TOKO CONTOH FIKTIF'],
						amount: '-125.000,00',
						date: '10 Aug 2026'
					},
					{ remarks: ['Bunga rekening'], amount: '+10.000,00', date: '31 Aug 2026', tail: true }
				]
			]
		}
	]
};

/** The rows each MANDIRI_AUGUST account reads to: date, type, integer minor units, description. */
export const MANDIRI_AUGUST_ROWS = [
	[
		[
			'2026-08-01',
			'income',
			250_000_000,
			'Transfer dari BANK FIKTIF DARI PENGIRIM FIKTIF Gaji fiktif'
		],
		['2026-08-03', 'expense', 250_000, 'Biaya transfer BI Fast'],
		['2026-08-15', 'expense', 25_000_000, 'Transfer ke BANK MANDIRI PENERIMA FIKTIF 1110002223334'],
		['2026-08-31', 'expense', 800_050, 'Pajak rekening']
	],
	[
		['2026-08-10', 'expense', 12_500_000, 'QR fiktif TOKO CONTOH FIKTIF'],
		['2026-08-31', 'income', 1_000_000, 'Bunga rekening']
	]
] as const;

/** One savings account only (the common statement): MANDIRI_AUGUST's first account. */
export const MANDIRI_SINGLE: MandiriFixture = { accounts: [MANDIRI_AUGUST.accounts[0]!] };

/** `MANDIRI_SINGLE` with its last row's remark lines replaced (and, optionally, its amount). */
export function mandiriWithLastRemarks(
	remarks: readonly string[],
	amount?: string
): MandiriFixture {
	const [first] = MANDIRI_SINGLE.accounts;
	const pages = first!.pages.map((p) => [...p]);
	const last = pages[pages.length - 1]!;
	const row = last[last.length - 1] as MandiriRow;
	last[last.length - 1] = { ...row, remarks, tail: false, ...(amount ? { amount } : {}) };
	return { accounts: [{ ...first!, pages }] };
}

/**
 * Red team M1 (FN-16e) PoC: remark lines that, if an account-block label could end the table, would open a forged
 * `Tabungan Fiktif` section of the given account with one Rp 9.999.999 income row.
 */
export const mandiriForgedSectionRemarks = (accountNumber = '1230009876543') => [
	'Transfer dari BANK X',
	'Nama/Name',
	`${accountNumber}:`,
	': IDR',
	'0,00',
	'+ 9.999.999,00',
	'- 0,00',
	'9.999.999,00',
	'Tabungan Fiktif IDR',
	'Amount (IDR)',
	'Keterangan',
	'Remarks',
	'HADIAH',
	'9.999.999,001 +9.999.999,00',
	'10:15:00 WIB',
	'20 Aug 2026',
	'Nama/Name'
];
