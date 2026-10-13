import { LETTERHEAD_CONFIDENCE } from './detect.ts';
import {
	isRekeningKoran,
	parseRekeningKoran,
	REKENING_KORAN_ROW_START,
	rekeningKoranLetterhead
} from './ocbc-rekening-koran.ts';
import {
	AMOUNT,
	amountOf,
	consistent,
	dateOf,
	linesOf,
	OCBC_MAX_SECTIONS,
	only,
	positionedPages,
	ROW_AMOUNT,
	TRAILING_AMOUNT,
	type Period,
	type PositionedPages,
	type ReadRow
} from './ocbc-text.ts';
import { statementRow } from './rows.ts';
import type {
	StatementDocument,
	StatementParse,
	StatementParser,
	StatementSection
} from './types.ts';

export { OCBC_MAX_SECTIONS } from './ocbc-text.ts';

/**
 * OCBC (PT Bank OCBC NISP) Laporan Konsolidasi / Consolidated Statement (monthly text PDF) — FN-16f, written from
 * the structure of a real sample (no value from it is kept here). What the text layer looks like, one extracted
 * line per line:
 *
 * - every page: `Tanggal …: DD Month YYYY - DD Month YYYY` (the period) and the bank footer
 *   `PT Bank OCBC NISP Tbk …`;
 * - portfolio pages (`LAPORAN PORTOFOLIO / SUMMARY OF ACCOUNT`, the account lists): per product group a heading
 *   such as `REKENING TABUNGAN / …` followed by one line per account, `<product> <account number> <ISO> <balance>`,
 *   ended by `Jumlah …`; deposits, investments, bonds and cards are listed the same way under their own headings.
 *   These pages are a summary, never transactions;
 * - each account's transactions (`LAPORAN MUTASI REKENING / ACCOUNT … TRANSACTION`): `Mata Uang / Currency : IDR`,
 *   `No Rekening / Account Number : <number>-<product>`, the table header ending `Saldo /`, `Balance`, the opening
 *   line `Saldo Awal <saldo>`, then one row per `DD-Mon-YYYY DD-Mon-YYYY <description…>` (transaction date, value
 *   date) whose description wraps over the following lines and whose last line carries `<debet> <kredit> <saldo>`
 *   (one of debet/kredit is `0.00`), and the closing line `Saldo Akhir <saldo>`;
 * - amounts as `1,234,567.89` (comma thousands, dot cents).
 *
 * A transaction section is one account's `LAPORAN MUTASI REKENING`; a later page with the same account number and
 * no opening line continues it. Only accounts the portfolio lists under `REKENING TABUNGAN` or `REKENING GIRO` in
 * IDR are importable; any other section (a deposit, a foreign-currency sub-account, an account the lists do not
 * show) is listed but never read into transactions. The /impor flow imports one section into the chosen wallet.
 *
 * Description lines are partly written by third parties (sender, transfer note), so nothing in them may decide an
 * amount or the structure (red team M1, FN-16b/FN-16e): a row must end with its one amount line (the last three
 * amounts of the line: debet, kredit, saldo), a second amount-shaped line makes it unreadable, a header line
 * inside a table or a table line outside one refuses the file (segment()), and a section is only imported when it
 * checks out against itself — every row's printed running balance, the one opening and one closing balance,
 * exactly one of debet/kredit per row, one printed period that every row date lies in, and one currency, IDR.
 * Otherwise it is `inconsistent` and refused whole.
 *
 * OCBC prints no row numbers and no debit/credit totals, so the row structure also comes from where lines start
 * (red team L1): a `DD-Mon-YYYY DD-Mon-YYYY` line starts a row only in the column the file's row dates start in
 * (`positionedPages`); remark text imitating `<amount line>` + `<row start>` sits in the description column, stays
 * in its own row, and that row's second amount line refuses the section. Without positions (a reader that gives
 * none) the text alone decides, as before.
 */

const ROW_START = /^(\d{2}-[A-Za-z]{3}-\d{4}) (\d{2}-[A-Za-z]{3}-\d{4})(?: (.*))?$/;
const OPENING = new RegExp(String.raw`^Saldo Awal (${AMOUNT})$`);
const CLOSING = new RegExp(String.raw`^Saldo Akhir (${AMOUNT})$`);
const PERIOD =
	/^Tanggal [A-Za-z]+ ?: (\d{1,2} [A-Za-z]+ \d{4}) - (\d{1,2} [A-Za-z]+ \d{4})(?:\s|$)/;
const TRANSACTIONS_TITLE = /^LAPORAN MUTASI REKENING \/ /;
const CURRENCY = /^Mata Uang \/ Currency : ([A-Z]{3})$/;
const ACCOUNT = /^No Rekening \/ Account Number : (\d{6,20})-(.{1,60})$/;
/** A portfolio list heading; only savings and current accounts can hold an importable table. */
const LIST_HEADING = /^REKENING ([A-Z]+) \//;
const LIST_ROW = /^(.{1,60}?) (\d{6,20}) ([A-Z]{3}) [\d,.]+$/;
const FOOTER = /^PT Bank OCBC (?:NISP|Indonesia),? Tbk/;

interface RawSection {
	account: string;
	label: string;
	currency: string;
	openings: (number | null)[];
	closings: (number | null)[];
	/** Each row's lines, the `DD-Mon-YYYY DD-Mon-YYYY` line first. */
	rows: string[][];
	/** A table line outside any row (before the first row, or after a page break cut a row). */
	broken: boolean;
}

interface Segmented {
	sections: RawSection[];
	periods: Set<string>;
	/** `<account>|<ISO>` of every account the portfolio lists under savings or current. */
	transactionAccounts: Set<string>;
	/** The file's structure is in doubt (see segment()): the whole file is refused. */
	broken: boolean;
}

/** Lines that belong to a page or table header: inside a table they can only be remark text imitating one. */
const isHeaderLine = (line: string, next: string | undefined) =>
	TRANSACTIONS_TITLE.test(line) ||
	CURRENCY.test(line) ||
	ACCOUNT.test(line) ||
	LIST_HEADING.test(line) ||
	(line === 'Saldo /' && next === 'Balance');

/** Lines that belong to a table: outside one (on a transaction page) they are rows a forged line cut out. */
const isTableLine = (line: string) =>
	ROW_START.test(line) || ROW_AMOUNT.test(line) || OPENING.test(line) || CLOSING.test(line);

/**
 * Splits the pages into transaction sections and their raw rows, and reads the portfolio lists. Description text
 * can only ever be read inside a table, so the structure fails closed against it: a header line inside a table
 * (red team M1, FN-16e), a table line outside one (what is left after a forged `Saldo Akhir` or footer ended a
 * table early), an opening balance after the first row, or one account and currency printed as two sections
 * refuse the whole file.
 */
function segment({ pages, canStart }: PositionedPages): Segmented {
	const out: Segmented = {
		sections: [],
		periods: new Set(),
		transactionAccounts: new Set(),
		broken: false
	};
	const seen = new Set<string>();
	let current: RawSection | null = null;
	pages.forEach((lines, p) => {
		const transactionsPage = lines.some((l) => TRANSACTIONS_TITLE.test(l));
		let list: string | null = null;
		let pageCurrency: string | null = null;
		let pageAccount: { account: string; label: string } | null = null;
		let inTable = false;
		let row: string[] | null = null;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (inTable && current) {
				if (FOOTER.test(line)) {
					inTable = false;
					continue;
				}
				if (isHeaderLine(line, lines[i + 1])) {
					out.broken = true;
					continue;
				}
				const opening = OPENING.exec(line);
				const closing = CLOSING.exec(line);
				if (opening) {
					if (current.rows.length > 0 || row) out.broken = true;
					current.openings.push(amountOf(opening[1]!));
					row = null;
				} else if (closing) {
					current.closings.push(amountOf(closing[1]!));
					inTable = false;
				} else if (ROW_START.test(line) && canStart(p, i)) {
					row = [line];
					current.rows.push(row);
				} else if (row) row.push(line);
				else current.broken = true;
				continue;
			}
			const period = PERIOD.exec(line);
			if (period) out.periods.add(`${period[1]} - ${period[2]}`);
			if (!transactionsPage) {
				const heading = LIST_HEADING.exec(line);
				if (heading) list = heading[1]!;
				else if (line.startsWith('Jumlah ')) list = null;
				else if (list === 'TABUNGAN' || list === 'GIRO') {
					const listed = LIST_ROW.exec(line);
					if (listed) out.transactionAccounts.add(`${listed[2]}|${listed[3]}`);
				}
				continue;
			}
			if (isTableLine(line)) out.broken = true;
			const currency = CURRENCY.exec(line);
			if (currency) pageCurrency = currency[1]!;
			const account = ACCOUNT.exec(line);
			if (account) pageAccount = { account: account[1]!, label: account[2]!.trim() };
			if (line === 'Balance' && lines[i - 1] === 'Saldo /') {
				if (!pageAccount || !pageCurrency) {
					out.broken = true;
					continue;
				}
				// The same account and currency on a following page, its table not closed yet, continues it.
				const continues =
					current !== null &&
					current.account === pageAccount.account &&
					current.currency === pageCurrency &&
					current.closings.length === 0;
				if (!continues) {
					const key = `${pageAccount.account}|${pageCurrency}`;
					if (seen.has(key) || out.sections.length >= OCBC_MAX_SECTIONS) out.broken = true;
					seen.add(key);
					current = {
						...pageAccount,
						currency: pageCurrency,
						openings: [],
						closings: [],
						rows: [],
						broken: false
					};
					out.sections.push(current);
				}
				inTable = true;
				row = null;
			}
		}
	});
	return out;
}

/** One raw row → its MappedRow and printed balance. */
function readRow(index: number, lines: readonly string[], period: Period | null): ReadRow {
	const reject = (reason: 'missing_amount' | 'unparseable_amount' | 'unparseable_date') => ({
		row: { index, ok: false as const, reason },
		balance: null
	});
	const start = ROW_START.exec(lines[0]!)!;
	// The start line's own text, then the wrapped lines: the last one must be the row's one amount line.
	const texts = [...(start[3] ? [start[3]] : []), ...lines.slice(1)];
	const amounts = texts.filter((t) => ROW_AMOUNT.test(t));
	if (amounts.length === 0) return reject('missing_amount');
	// A description imitating an amount line is third-party text: unreadable, never "the last one wins".
	if (amounts.length > 1 || !ROW_AMOUNT.test(texts[texts.length - 1]!))
		return reject('unparseable_amount');
	const amount = ROW_AMOUNT.exec(texts[texts.length - 1]!)!;
	// The three amounts are anchored to the line's end; a description tail ending in a fourth amount is ambiguous.
	if (amount[1] && TRAILING_AMOUNT.test(amount[1])) return reject('unparseable_amount');
	const date = dateOf(start[1]!);
	if (!date || !dateOf(start[2]!) || !period || date < period.from || date > period.to)
		return reject('unparseable_date');
	const debit = amountOf(amount[2]!);
	const credit = amountOf(amount[3]!);
	// Exactly one side carries the amount; both or neither is unreadable.
	if (debit === null || credit === null || (debit === 0) === (credit === 0))
		return reject('unparseable_amount');
	const description = [...texts.slice(0, -1), ...(amount[1] ? [amount[1]] : [])].join(' ');
	return {
		row: statementRow(index, {
			date,
			direction: debit > 0 ? 'debit' : 'credit',
			amount: debit > 0 ? amount[2]! : amount[3]!,
			description
		}),
		balance: amountOf(amount[4]!)
	};
}

function readSection(
	raw: RawSection,
	period: Period | null,
	transactionAccounts: ReadonlySet<string>,
	nextIndex: number
): StatementSection {
	const read = raw.rows.map((lines, i) => readRow(nextIndex + i, lines, period));
	const foreign = raw.currency !== 'IDR';
	const opening = raw.openings.length === 1 ? raw.openings[0]! : null;
	const closing = raw.closings.length === 1 ? raw.closings[0]! : null;
	let refusal: StatementSection['refusal'] = null;
	if (foreign) refusal = 'unsupported_currency';
	else if (!transactionAccounts.has(`${raw.account}|IDR`)) refusal = 'not_transaction_account';
	else if (raw.broken || !consistent(read, opening, closing)) refusal = 'inconsistent';
	return {
		label: raw.label,
		accountLast4: raw.account.slice(-4),
		refusal,
		parse: {
			rows: foreign
				? read.map((r) => ({ index: r.row.index, ok: false, reason: 'unsupported_currency' }))
				: read.map((r) => r.row),
			openingBalanceMinor: foreign ? null : opening,
			closingBalanceMinor: foreign ? null : closing,
			inconsistent: refusal !== null
		}
	};
}

function parsePdf(positioned: PositionedPages): StatementParse {
	const segmented = segment(positioned);
	const [from, to] = (only(segmented.periods) ?? '').split(' - ').map(dateOf);
	const period = from && to && from <= to ? { from, to } : null;
	const sections: StatementSection[] = [];
	let nextIndex = 0;
	for (const raw of segmented.sections.slice(0, OCBC_MAX_SECTIONS)) {
		sections.push(readSection(raw, period, segmented.transactionAccounts, nextIndex));
		nextIndex += raw.rows.length;
	}
	return {
		rows: [],
		openingBalanceMinor: null,
		closingBalanceMinor: null,
		// Pages disagreeing on the period, a doubtful structure (see segment()) or too many sections refuse the file.
		inconsistent: segmented.broken || period === null || sections.length === 0,
		sections
	};
}

/** The Laporan Konsolidasi letterhead: the bank footer and its report title. */
const konsolidasiLetterhead = (lines: readonly string[]) =>
	lines.some((l) => FOOTER.test(l)) &&
	lines.some(
		(l) => TRANSACTIONS_TITLE.test(l) || l.startsWith('LAPORAN KONSOLIDASI / CONSOLIDATED')
	);

/**
 * One user-facing OCBC parser for both of the bank's statement layouts (FN-16h owner decision A): the Laporan
 * Konsolidasi above and the single-account Rekening Koran (ocbc-rekening-koran.ts). A file carrying both layouts'
 * marks is neither: it claims nothing and is refused, never read by one layout while the other's text is in it.
 */
export const OCBC: StatementParser = {
	id: 'ocbc',
	label: 'OCBC',
	formats: ['pdf_text'],
	detect(doc: StatementDocument) {
		if (doc.format !== 'pdf_text') return 0;
		const pages = doc.pages.map(linesOf);
		const konsolidasi = konsolidasiLetterhead(pages.flat());
		const rekeningKoran = rekeningKoranLetterhead(pages);
		return konsolidasi !== rekeningKoran ? LETTERHEAD_CONFIDENCE : 0;
	},
	parse(doc: StatementDocument) {
		if (doc.format !== 'pdf_text')
			return { rows: [], openingBalanceMinor: null, closingBalanceMinor: null, inconsistent: true };
		const pages = doc.pages.map(linesOf);
		if (!isRekeningKoran(pages)) return parsePdf(positionedPages(doc, ROW_START));
		if (
			pages.flat().some((l) => TRANSACTIONS_TITLE.test(l) || l.startsWith('LAPORAN KONSOLIDASI /'))
		)
			return { rows: [], openingBalanceMinor: null, closingBalanceMinor: null, inconsistent: true };
		return parseRekeningKoran(positionedPages(doc, REKENING_KORAN_ROW_START));
	}
};
