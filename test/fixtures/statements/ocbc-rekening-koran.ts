import { buildPdf, textContent } from '../../helpers/pdf';
import { usd } from './ocbc';

/**
 * A synthetic OCBC NISP "REKENING KORAN" single-account e-statement (FN-16h): the layout of the text PDF as its
 * text layer reads — every page's address block, title, branch, period, split labels and account number, the
 * upper-case table header, `Currency Code`/`Beginning Balance` blocks, rows of `DD/MM/YYYY DD/MM/YYYY` with the
 * amounts on the start line or a wrapped line and `Berita : …` notes after them, the legal text and the bank's tax
 * block, and a last summary page — with every name, number, description and amount invented. Nothing here comes
 * from a real statement.
 */

export interface RkRow {
	/** `DD/MM/YYYY`; the value date is the same unless `valueDate` is given. */
	date: string;
	valueDate?: string;
	/** The bank's transaction type, printed on the row's start line. */
	type: string;
	/** Lines the description wraps onto before the amounts; the amounts go at the end of the last one. */
	wrap?: readonly string[];
	/** The note after the amount line (`Berita : …` and its wrapped lines). */
	after?: readonly string[];
	/** `1,234.56`; exactly one of debit/credit for a real row (the other prints `0.00`). */
	debit?: string;
	credit?: string;
	/** Printed running balance; default: the correct one. */
	balance?: string;
	/** Print no amounts at all (a cut row). */
	noAmounts?: boolean;
}

/** Opens a currency block: `Currency Code : <ISO>` and `Beginning Balance <opening>`. */
interface RkBlock {
	currency: string;
	opening: string;
	/** Summary rate, three decimals (`12,000.000`); IDR prints `1.000`. */
	rate?: string;
}

/** A table item: a block start, a row, or raw lines inserted as printed. */
export type RkItem = RkBlock | RkRow | readonly string[];

export interface RkFixture {
	period?: string;
	/** Per page: its period line, when it differs from `period` (null: none printed). */
	pagePeriods?: Readonly<Record<number, string | null>>;
	account?: string;
	product?: string;
	/** Table items per transaction page (a page break between arrays). */
	pages: readonly (readonly RkItem[])[];
	/** Summary rows replaced (raw lines), and the total line's amount replaced. */
	summaryRows?: readonly string[];
	total?: string;
	/** Leave the bank's tax line off every page. */
	noFooter?: boolean;
	/** Leave the legal text off this page (0-based). */
	noLegalOnPage?: number;
	/** Print the summary after the last table page's rows (before its legal text), not on a page of its own. */
	summaryAfterRows?: boolean;
}

const toMinor = (printed: string) => Number(printed.replace(/[,.]/g, ''));
const rateMilli = (rate: string) => Number(rate.replace(/[,.]/g, ''));

const TABLE_HEADER = [
	'TGL',
	'TRANS /',
	'TRANS',
	'DATE',
	'TGL',
	'VALUTA',
	'/ VALUE',
	'DATE',
	'URAIAN /',
	'DESCRIPTION',
	'DEBET /',
	'DEBIT',
	'KREDIT /',
	'CREDIT',
	'SALDO /',
	'BALANCE'
];

const LEGAL = [
	'BILAMANA DALAM 14 HARI KALENDER TERHITUNG SEJAK TANGGAL TEKS PERNYATAAN FIKTIF',
	'TEKS PERNYATAAN FIKTIF LANJUTAN.',
	'T E K S F I K T I F Y A N G D I C E T A K B E R J A R A K',
	'IN THE EVENT THAT FICTIONAL DISCLAIMER TEXT',
	'Nama',
	'NPWP',
	'Alamat',
	':',
	':',
	':'
];
const FOOTER = [
	'PT. Bank OCBC NISP Tbk',
	'0000 0000 0000 0000',
	'Jalan Contoh Fiktif No. 1, Kota Contoh 12345'
];

const isBlock = (item: RkItem): item is RkBlock => 'currency' in item;
const isRow = (item: RkItem): item is RkRow => 'type' in item;

/** Each page's text as the PDF text layer reads it (one line per line), the summary page last. */
export function rkPages(f: RkFixture): string[] {
	const period = f.period ?? '01 July 2026 - 31 July 2026';
	const account = f.account ?? '700100200300';
	const product = f.product ?? 'Tabungan Fiktif';
	const total = f.summaryAfterRows ? f.pages.length : f.pages.length + 1;
	const header = (n: number) => {
		const printed = f.pagePeriods && n in f.pagePeriods ? f.pagePeriods[n] : period;
		return [
			'00001',
			'Kepada Yth:',
			'NASABAH FIKTIF',
			'JALAN CONTOH FIKTIF NO 1',
			'KOTA CONTOH 12345',
			'00001',
			`07/26-${n + 1}/${total}-0300 REKENING KORAN`,
			'CABANG / BRANCH : 00001 - CABANG FIKTIF',
			...(printed === null ? [] : [`PERIODE / PERIOD : ${printed}`]),
			'TANGGAL PERCETAKAN',
			'/ PRINTING DATE',
			': 31 July 2026',
			'MATA UANG /',
			'CURRENCY',
			': IDR',
			`HALAMAN / PAGE : ${n + 1} of ${total}`,
			'NOMOR REKENING /',
			'ACCOUNT NUMBER',
			`: ${account} - ${product}`
		];
	};
	const tail = (n: number) => [
		...(f.noLegalOnPage === n ? [] : LEGAL),
		...(f.noFooter ? ['PT Bank Lain'] : FOOTER)
	];
	const blocks: { currency: string; rate: string; running: number }[] = [];
	const out: string[] = [];
	const pageLines: string[][] = [];
	f.pages.forEach((items, n) => {
		const lines = [...header(n), ...TABLE_HEADER];
		for (const item of items) {
			if (isBlock(item)) {
				blocks.push({
					currency: item.currency,
					rate: item.rate ?? '1.000',
					running: toMinor(item.opening)
				});
				lines.push(`Currency Code : ${item.currency}`, `Beginning Balance ${item.opening}`);
			} else if (isRow(item)) {
				const block = blocks[blocks.length - 1]!;
				const debit = item.debit ?? '0.00';
				const credit = item.credit ?? '0.00';
				block.running += toMinor(credit) - toMinor(debit);
				const amounts = item.noAmounts
					? ''
					: ` ${debit} ${credit} ${item.balance ?? usd(block.running)}`;
				const printed = [
					`${item.date} ${item.valueDate ?? item.date} ${item.type}`,
					...(item.wrap ?? [])
				];
				printed[printed.length - 1] += amounts;
				lines.push(...printed, ...(item.after ?? []));
			} else lines.push(...item);
		}
		pageLines.push(lines);
	});
	const summary =
		f.summaryRows ??
		blocks.map((b) => {
			const idr = Math.round((b.running * rateMilli(b.rate)) / 1000);
			return `${b.currency} ${b.rate} ${usd(b.running)} ${usd(idr)}`;
		});
	const idrTotal = blocks.reduce(
		(sum, b) => sum + Math.round((b.running * rateMilli(b.rate)) / 1000),
		0
	);
	const summaryLines = [
		'Mata Uang /',
		'Currency',
		'Tunggakan Bunga /',
		'Overdue Interest',
		'Tunggakan Denda /',
		"Overdue Penalty Overdue Other's",
		'Liabilities',
		'Total Tunggakan /',
		'Total Overdue Amount',
		...blocks.map((b) => `${b.currency} 0.00 0.00 0.00 0.00`),
		'Mata Uang /',
		'Currency',
		'Kurs Valas IDR /',
		'IDR Exchange Rate',
		'Saldo /',
		'Balance',
		'Saldo Dalam IDR /',
		'Balance in IDR',
		...summary,
		`Total Saldo Dalam IDR / Balance Total in IDR ${f.total ?? usd(idrTotal)}`,
		'Catatan : Teks catatan kurs fiktif.'
	];
	if (f.summaryAfterRows) pageLines[pageLines.length - 1]!.push(...summaryLines);
	pageLines.forEach((lines, n) => out.push([...lines, ...tail(n)].join('\n')));
	if (!f.summaryAfterRows) {
		const last = f.pages.length;
		out.push([...header(last), ...summaryLines, ...tail(last)].join('\n'));
	}
	return out;
}

/** The same statement as a text PDF, one PDF page per fixture page. */
export function rkPdf(f: RkFixture): Uint8Array {
	return buildPdf(rkPages(f).map((p) => ({ content: textContent(p.split('\n')) })));
}

/**
 * July 2026, one account: an IDR block over two pages (the amounts on the start line, on a wrapped line, a
 * `Berita` note with a wrapped line, a plain note line, a note carried onto page 2) and an SGD block.
 * IDR: 5,000,000.00 − 1,000,000.00 − 150,000.00 + 2,500,000.00 − 300,000.00 − 75,000.00 + 1,000,000.00
 * = 6,975,000.00. SGD: 100.00 − 99.50 = 0.50 (6,000.00 in IDR at 12,000.000). Total in IDR 6,981,000.00.
 */
export const RK_JULY: RkFixture = {
	pages: [
		[
			{ currency: 'IDR', opening: '5,000,000.00' },
			{
				date: '01/07/2026',
				type: 'Transfer Keluar BI Fast/',
				after: ['Berita : PENERIMA FIKTIF/-'],
				debit: '1,000,000.00'
			},
			{
				date: '02/07/2026',
				type: 'Pos Sales Debit/Post Sales Debit',
				after: ['Berita : 0001 TOKO CONTOH FIKTIF', 'KOTA FIKTIF'],
				debit: '150,000.00'
			},
			{
				date: '05/07/2026',
				type: 'Transfer Masuk/Incoming Transfer',
				after: ['Berita : 0002 014 7001002009 NASABAH', 'FIKTIF'],
				credit: '2,500,000.00'
			},
			{ date: '12/07/2026', type: 'Transfer Keluar BI Fast/', debit: '300,000.00' }
		],
		[
			['Berita : NASABAH FIKTIF/-'],
			{
				date: '20/07/2026',
				type: 'Bill payment Dr customer acct/Bill payment Dr',
				wrap: ['customer acct'],
				after: ['Berita : 0003 081200000000 VA FIKTIF'],
				debit: '75,000.00'
			},
			{
				date: '29/07/2026',
				type: 'OVERBOOKING SI/OVERBOOKING SI',
				after: ['NASABAH FIKTIF/31'],
				credit: '1,000,000.00'
			},
			{ currency: 'SGD', opening: '100.00', rate: '12,000.000' },
			{
				date: '29/07/2026',
				type: 'OVERBOOKING SI/OVERBOOKING SI',
				after: ['NASABAH FIKTIF/31'],
				debit: '99.50'
			}
		]
	]
};

/** The IDR rows RK_JULY reads to: date, type, minor units, description. */
export const RK_JULY_ROWS = [
	['2026-07-01', 'expense', 100_000_000, 'Transfer Keluar BI Fast/ Berita : PENERIMA FIKTIF/-'],
	[
		'2026-07-02',
		'expense',
		15_000_000,
		'Pos Sales Debit/Post Sales Debit Berita : 0001 TOKO CONTOH FIKTIF KOTA FIKTIF'
	],
	[
		'2026-07-05',
		'income',
		250_000_000,
		'Transfer Masuk/Incoming Transfer Berita : 0002 014 7001002009 NASABAH FIKTIF'
	],
	['2026-07-12', 'expense', 30_000_000, 'Transfer Keluar BI Fast/ Berita : NASABAH FIKTIF/-'],
	[
		'2026-07-20',
		'expense',
		7_500_000,
		'Bill payment Dr customer acct/Bill payment Dr customer acct Berita : 0003 081200000000 VA FIKTIF'
	],
	['2026-07-29', 'income', 100_000_000, 'OVERBOOKING SI/OVERBOOKING SI NASABAH FIKTIF/31']
] as const;

/** RK_JULY with one IDR row's note (`after`) replaced, and optionally more of the row. */
export function rkWithAfter(
	page: number,
	item: number,
	after: readonly string[],
	over: Partial<RkRow> = {}
): RkFixture {
	const pages = RK_JULY.pages.map((p) => [...p]);
	pages[page]![item] = { ...(pages[page]![item] as RkRow), after, ...over };
	return { ...RK_JULY, pages };
}
