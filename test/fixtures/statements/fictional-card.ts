import {
	buildCardStatement,
	type CardPhraseTable,
	type CardRowCells,
	type CardStatementCells,
	type DayMonth
} from '#lib/shared/statements/card-rows';
import type {
	StatementDocument,
	StatementParse,
	StatementParser
} from '#lib/shared/statements/types';
import { buildPdf, textContent } from '../../helpers/pdf';

/**
 * "Kartu Kredit Contoh Fiktif": an invented card issuer, used only by tests (FN-55b) to prove the card statement
 * pipeline end to end while no real card sample exists. It is never listed in `STATEMENT_PARSERS` (a test asserts
 * it), and no real issuer's layout is copied or guessed: this layout was made up for the tests. It also shows the
 * shape a real card parser takes — detect from a stable letterhead, a strict reading of the issuer's own structure
 * (`structureBroken` on anything unexpected), amounts in one fixed grammar, and every check left to
 * `buildCardStatement`. Every name, card number and amount below is fictional.
 */

const LETTERHEAD = 'KARTU KREDIT CONTOH FIKTIF';
const TABLE_START = 'RINCIAN TRANSAKSI';
const TABLE_END = 'AKHIR RINCIAN';
/** The summary lines (page 1 only, each once) and the per-page lines (every page, each once per page). */
const SUMMARY_KEYS = [
	'TANGGAL JATUH TEMPO ',
	'PERIODE ',
	'LIMIT KREDIT ',
	'TAGIHAN SEBELUMNYA ',
	'TOTAL PEMBAYARAN ',
	'TOTAL PEMBELIAN ',
	'TOTAL BIAYA ',
	'TOTAL BUNGA ',
	'TAGIHAN BARU ',
	'PEMBAYARAN MINIMUM '
] as const;
const PAGE_KEYS = ['NOMOR KARTU ', 'TANGGAL TAGIHAN '] as const;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ROW_START = /^\d{2}\/\d{2} /;
const ROW = /^(\d{2})\/(\d{2}) (\d{2})\/(\d{2}) (.+?) (\S+)( CR)?$/;
/** An amount-shaped token anywhere in a line (the B5 count). */
const AMOUNT_TOKEN = /(?:^|\s)(?:Rp ?)?\d{1,3}(?:\.\d{3})*,\d{2}(?=\s|$)/g;
const FOREIGN = /^[A-Z]{3} \d{1,3}(?:\.\d{3})*,\d{2}$/;
const INSTALLMENT = /^CICILAN \d{1,2}\/\d{1,2}$/;
const FOOTER = /^HALAMAN \d+ DARI \d+$/;

const PHRASES: CardPhraseTable = {
	fee: ['BIAYA '],
	interest: ['BUNGA '],
	tax: ['BEA METERAI', 'PPN '],
	installment: ['CICILAN '],
	payment: ['PEMBAYARAN ']
};

const isoOf = (printed: string) => {
	const m = DATE.exec(printed);
	return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const dayMonth = (day: string, month: string): DayMonth => ({
	day: Number(day),
	month: Number(month)
});

function readPages(pages: readonly string[]): StatementParse {
	const summary = new Map<string, string>();
	const statementDates = new Set<string>();
	const cardNumbers: string[] = [];
	const rows: CardRowCells[] = [];
	let broken = pages.length === 0;
	pages.forEach((page, p) => {
		const lines = page
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		const perPage = new Set<string>();
		let state: 'header' | 'table' | 'after' = 'header';
		for (const line of lines) {
			if (state === 'header') {
				if (line === LETTERHEAD) continue;
				if (line === TABLE_START) {
					state = 'table';
					continue;
				}
				const pageKey = PAGE_KEYS.find((k) => line.startsWith(k));
				const summaryKey = SUMMARY_KEYS.find((k) => line.startsWith(k));
				if (pageKey) {
					if (perPage.has(pageKey)) broken = true;
					perPage.add(pageKey);
					const value = line.slice(pageKey.length);
					if (pageKey === 'NOMOR KARTU ') cardNumbers.push(value);
					else statementDates.add(value);
				} else if (summaryKey && p === 0 && !summary.has(summaryKey)) {
					summary.set(summaryKey, line.slice(summaryKey.length));
				} else broken = true;
			} else if (state === 'table') {
				if (line === TABLE_END) {
					state = 'after';
					continue;
				}
				const last = rows.at(-1);
				if (ROW_START.test(line)) {
					const m = ROW.exec(line);
					rows.push({
						transactionDate: m ? dayMonth(m[1]!, m[2]!) : null,
						postingDate: m ? dayMonth(m[3]!, m[4]!) : null,
						description: m?.[5] ?? '',
						amount: m?.[6] ?? '',
						direction: m ? (m[7] ? 'credit' : 'debit') : null,
						amountCells: line.match(AMOUNT_TOKEN)?.length ?? 0
					});
				} else if (last && FOREIGN.test(line) && last.foreignAmount === undefined) {
					last.foreignAmount = line;
				} else if (last && INSTALLMENT.test(line) && last.installment === undefined) {
					last.installment = line;
				} else {
					// A header, total, legal or any other line inside the table: the structure is not the issuer's.
					broken = true;
					if (last && AMOUNT_TOKEN.test(line)) last.amountCells++;
					AMOUNT_TOKEN.lastIndex = 0;
				}
			} else if (!FOOTER.test(line)) broken = true;
		}
		// Each page: its letterhead block, one table, closed.
		if (state !== 'after' || !perPage.has('TANGGAL TAGIHAN ') || !perPage.has('NOMOR KARTU '))
			broken = true;
	});
	if (statementDates.size !== 1) broken = true;
	const field = (key: (typeof SUMMARY_KEYS)[number]) => summary.get(key);
	const optional = (key: (typeof SUMMARY_KEYS)[number]) =>
		summary.has(key) ? (summary.get(key) ?? null) : undefined;
	const period = field('PERIODE ');
	const [from, to] = period ? period.split(' - ') : [];
	const due = optional('TANGGAL JATUH TEMPO ');
	const cells: CardStatementCells = {
		statementDate: statementDates.size === 1 ? isoOf([...statementDates][0]!) : null,
		dueDate: due === undefined ? undefined : due === null ? null : isoOf(due),
		period:
			period === undefined
				? undefined
				: from && to && isoOf(from) && isoOf(to)
					? { from: isoOf(from)!, to: isoOf(to)! }
					: null,
		previousBalance: field('TAGIHAN SEBELUMNYA ') ?? null,
		newBalance: field('TAGIHAN BARU ') ?? null,
		minimumPayment: optional('PEMBAYARAN MINIMUM '),
		creditLimit: optional('LIMIT KREDIT '),
		cardNumbers: [...new Set(cardNumbers)],
		totals: {
			payments: optional('TOTAL PEMBAYARAN '),
			purchases: optional('TOTAL PEMBELIAN '),
			fees: optional('TOTAL BIAYA '),
			interest: optional('TOTAL BUNGA ')
		},
		rows,
		structureBroken: broken,
		grammar: 'id',
		phrases: PHRASES
	};
	return buildCardStatement(cells);
}

/** The test-only card parser (kind `card`). Never registered in production code. */
export const FICTIONAL_CARD: StatementParser = {
	id: 'fiktif-kartu',
	label: 'Kartu Contoh Fiktif',
	kind: 'card',
	formats: ['pdf_text'],
	detect(doc: StatementDocument) {
		return doc.format === 'pdf_text' && doc.pages[0]?.includes(LETTERHEAD) ? 0.9 : 0;
	},
	parse(doc: StatementDocument) {
		return doc.format === 'pdf_text' ? readPages(doc.pages) : buildCardStatement(EMPTY);
	}
};

const EMPTY: CardStatementCells = {
	statementDate: null,
	previousBalance: null,
	newBalance: null,
	cardNumbers: [],
	totals: {},
	rows: [],
	structureBroken: true,
	grammar: 'id',
	phrases: PHRASES
};

/** The fictional statement's figures (AC 19), as printed. */
export interface FictionalCardSpec {
	card: string;
	statementDate: string;
	dueDate: string | null;
	period: string | null;
	limit: string | null;
	previous: string;
	payments: string | null;
	purchases: string | null;
	fees: string | null;
	interest: string | null;
	next: string;
	minimum: string | null;
	rows: string[];
}

/**
 * AC 19's statement: previous 2.000.000,00, one payment 2.000.000,00, purchases 1.250.000,50 (one foreign, one
 * installment), a fee 75.000,00, new 1.325.000,50, minimum 100.000,00, limit 15.000.000,00. Period 26/09–25/10/2026.
 */
export const FICTIONAL_CARD_SPEC: FictionalCardSpec = {
	card: '4111 11** **** 0001',
	statementDate: '25/10/2026',
	dueDate: '12/11/2026',
	period: '26/09/2026 - 25/10/2026',
	limit: '15.000.000,00',
	previous: '2.000.000,00',
	payments: '2.000.000,00',
	purchases: '1.250.000,50',
	fees: '75.000,00',
	interest: '0,00',
	next: '1.325.000,50',
	minimum: '100.000,00',
	rows: [
		'27/09 28/09 TOKO BUKU CONTOH 800.000,50',
		'30/09 01/10 PEMBAYARAN TERIMA KASIH 2.000.000,00 CR',
		'05/10 06/10 LANGGANAN FIKTIF ONLINE 205.000,00',
		'USD 12,50',
		'10/10 11/10 CICILAN TOKO ELEKTRONIK FIKTIF 245.000,00',
		'CICILAN 3/12',
		'25/10 25/10 BIAYA TAHUNAN 75.000,00'
	]
};

/** The statement's pages as text lines: page 1 with the summary and the first `split` table lines, then page 2. */
export function fictionalCardPages(over: Partial<FictionalCardSpec> = {}, split = 4): string[][] {
	const s = { ...FICTIONAL_CARD_SPEC, ...over };
	const head = [LETTERHEAD, `NOMOR KARTU ${s.card}`, `TANGGAL TAGIHAN ${s.statementDate}`];
	const summary = [
		...(s.dueDate === null ? [] : [`TANGGAL JATUH TEMPO ${s.dueDate}`]),
		...(s.period === null ? [] : [`PERIODE ${s.period}`]),
		...(s.limit === null ? [] : [`LIMIT KREDIT ${s.limit}`]),
		`TAGIHAN SEBELUMNYA ${s.previous}`,
		...(s.payments === null ? [] : [`TOTAL PEMBAYARAN ${s.payments}`]),
		...(s.purchases === null ? [] : [`TOTAL PEMBELIAN ${s.purchases}`]),
		...(s.fees === null ? [] : [`TOTAL BIAYA ${s.fees}`]),
		...(s.interest === null ? [] : [`TOTAL BUNGA ${s.interest}`]),
		`TAGIHAN BARU ${s.next}`,
		...(s.minimum === null ? [] : [`PEMBAYARAN MINIMUM ${s.minimum}`])
	];
	return [
		[...head, ...summary, TABLE_START, ...s.rows.slice(0, split), TABLE_END, 'HALAMAN 1 DARI 2'],
		[...head, TABLE_START, ...s.rows.slice(split), TABLE_END, 'HALAMAN 2 DARI 2']
	];
}

/** A text PDF of `pages` (optionally password-protected). */
export function fictionalCardPdf(
	pages: readonly (readonly string[])[] = fictionalCardPages(),
	options: { password?: string } = {}
): Uint8Array {
	return buildPdf(
		pages.map((lines) => ({ content: textContent(lines) })),
		{ password: options.password }
	);
}
