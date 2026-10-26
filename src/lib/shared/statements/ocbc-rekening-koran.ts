import { isDateString } from '../dates.ts';
import {
	AMOUNT,
	amountOf,
	consistent,
	dateOf,
	OCBC_MAX_SECTIONS,
	only,
	ROW_AMOUNT,
	TRAILING_AMOUNT,
	type Period,
	type PositionedPages,
	type ReadRow
} from './ocbc-text.ts';
import { statementRow } from './rows.ts';
import type { StatementParse, StatementSection } from './types.ts';

/**
 * OCBC NISP "REKENING KORAN" — the single-account e-statement (FN-16h), written from the structure of a real
 * sample (no value from it is kept here). Read by the same `ocbc` parser as the Laporan Konsolidasi (ocbc.ts
 * dispatches). What the text layer looks like, one extracted line per line:
 *
 * - every page: the address block, `<document code> REKENING KORAN`, `CABANG / BRANCH : …`,
 *   `PERIODE / PERIOD : DD Month YYYY - DD Month YYYY` (one line), split labels (`TANGGAL PERCETAKAN`,
 *   `MATA UANG /`, …), `HALAMAN / PAGE : n of m`, `NOMOR REKENING /`, `ACCOUNT NUMBER`,
 *   `: <account number> - <product>`; transaction pages then carry the table header ending `SALDO /`, `BALANCE`
 *   (upper case); every page ends with the legal text (its first line `BILAMANA DALAM 14 HARI KALENDER …`, some
 *   lines letter-spaced) and a tax block naming the bank, `PT. Bank OCBC NISP Tbk`;
 * - the table holds one block per currency of the one account: `Currency Code : <ISO>`, `Beginning Balance
 *   <amount>`, then rows `DD/MM/YYYY DD/MM/YYYY <description…>` (transaction date, value date). A row's one amount
 *   line `<debet> <kredit> <saldo>` is its start line or a wrapped line after it, and is followed by the row's
 *   `Berita : …` note and its wrapped lines; the note can continue at the top of the next page's table;
 * - no closing line in the table: the last page's summary prints per currency `<ISO> <rate, 3 decimals>
 *   <balance> <balance in IDR>` and `Total Saldo Dalam IDR / Balance Total in IDR <amount>`. The summary opens
 *   with `Mata Uang /`, `Currency`, `Tunggakan Bunga /` (the overdue table). It sits on a page of its own when
 *   the rows fill the previous page, or right after the last row on the last table page, before the legal text;
 *   there that opening closes the table;
 * - amounts as `1,234,567.89` (the Konsolidasi grammar, ocbc-text.ts).
 *
 * A section is one currency block; only the IDR one is importable, any other is listed (`unsupported_currency`).
 * Descriptions and notes are third-party text, so nothing in them may decide an amount or the structure (red
 * team M1, FN-16b/e/f): a row has exactly one amount-shaped line anywhere in its lines; a page or table header,
 * a currency block, a summary line or the bank's tax line inside a table, a table line outside one, a second
 * legal text on a page, or one currency printed as two blocks refuses the whole file. A section is only imported
 * when it checks out against itself: every row's printed running balance from `Beginning Balance` to the
 * summary's own-currency balance (never the IDR column), exactly one of debet/kredit per row, the one printed
 * period every row date lies in. The summary must list every currency of the file (it may list more: a currency
 * with no movement prints no table block), IDR at rate 1.000, and its total must equal its IDR column; a foreign
 * block must also check out. Otherwise the file is refused whole.
 * The rate and the IDR column are read for these checks only, never stored (owner decision C).
 *
 * As for the Konsolidasi layout (red team L1), a `DD/MM/YYYY DD/MM/YYYY` line starts a row only in the column the
 * file's row dates start in (`positionedPages`): a note imitating `<row start with amounts>` sits further right,
 * stays in its own row, and that row's second amount line refuses the section.
 */

const ROW_START = /^(\d{2}\/\d{2}\/\d{4}) (\d{2}\/\d{2}\/\d{4})(?: (.*))?$/;
/** What a row's first line looks like (for the row-start column, ocbc.ts). */
export const REKENING_KORAN_ROW_START = ROW_START;
const CURRENCY_CODE = /^Currency Code : ([A-Z]{3})$/;
const BEGINNING = new RegExp(String.raw`^Beginning Balance (${AMOUNT})$`);
/** The title line: a per-print document code, then the title. */
const TITLE = /(?:^|\s)REKENING KORAN$/;
const BRANCH = /^CABANG \/ BRANCH : /;
const PERIOD = /^PERIODE \/ PERIOD : (\d{1,2} [A-Za-z]+ \d{4}) - (\d{1,2} [A-Za-z]+ \d{4})$/;
const PAGE = /^HALAMAN \/ PAGE : \d+ of \d+$/;
const ACCOUNT_VALUE = /^: (\d{6,20}) - (.{1,60})$/;
/** The tax block's bank line as the sample prints it (period after `PT`); only this exact line, never spaced text. */
const FOOTER = /^PT\. Bank OCBC NISP Tbk$/;
/** The first line of the legal text every page ends with: it closes the page's table. */
const LEGAL = /^BILAMANA DALAM 14 HARI KALENDER /;
const RATE = String.raw`\d{1,3}(?:,\d{3})*\.\d{3}`;
const SUMMARY_ROW = new RegExp(String.raw`^([A-Z]{3}) (${RATE}) (${AMOUNT}) (${AMOUNT})$`);
const SUMMARY_TOTAL = new RegExp(
	String.raw`^Total Saldo Dalam IDR \/ Balance Total in IDR (${AMOUNT})$`
);

const isAccountLabel = (line: string, next: string | undefined) =>
	line === 'NOMOR REKENING /' && next === 'ACCOUNT NUMBER';
const isTableHeaderEnd = (line: string, next: string | undefined) =>
	line === 'SALDO /' && next === 'BALANCE';
/** The summary's opening: the overdue table's first labels. Inside a table it ends the table. */
const isSummaryStart = (lines: readonly string[], i: number) =>
	lines[i] === 'Mata Uang /' && lines[i + 1] === 'Currency' && lines[i + 2] === 'Tunggakan Bunga /';

/** A page carries this layout's own header: the title, the branch line and the account number label. */
const headerPage = (lines: readonly string[]) =>
	lines.some((l) => TITLE.test(l)) &&
	lines.some((l) => BRANCH.test(l)) &&
	lines.some((l, i) => isAccountLabel(l, lines[i + 1]));

/** Some page is a Rekening Koran page (the parse dispatch; detection also needs the bank line). */
export const isRekeningKoran = (pages: readonly (readonly string[])[]) => pages.some(headerPage);

/** The full letterhead: a Rekening Koran page header and the bank's own line. */
export const rekeningKoranLetterhead = (pages: readonly (readonly string[])[]) =>
	isRekeningKoran(pages) && pages.some((lines) => lines.some((l) => FOOTER.test(l)));

/** `05/07/2026` (day first) → `2026-07-05`, or null. */
function slashDate(printed: string): string | null {
	const [day, month, year] = printed.split('/');
	const date = `${year}-${month}-${day}`;
	return isDateString(date) ? date : null;
}

interface RawBlock {
	currency: string;
	opening: number | null;
	/** Each row's lines, the `DD/MM/YYYY DD/MM/YYYY` line first. */
	rows: string[][];
	/** A table line before the block's first row. */
	broken: boolean;
}

interface SummaryRow {
	rate: string;
	balance: number | null;
	idr: number | null;
}

interface Segmented {
	blocks: RawBlock[];
	periods: Set<string>;
	accounts: Set<string>;
	summary: Map<string, SummaryRow>;
	totals: (number | null)[];
	/** The file's structure is in doubt (see segment()): the whole file is refused. */
	broken: boolean;
}

/** Lines of a page header, a table header, the summary or the bank line: inside a table only forged text. */
const isHeaderLine = (line: string, next: string | undefined) =>
	TITLE.test(line) ||
	BRANCH.test(line) ||
	PERIOD.test(line) ||
	PAGE.test(line) ||
	FOOTER.test(line) ||
	SUMMARY_ROW.test(line) ||
	SUMMARY_TOTAL.test(line) ||
	isAccountLabel(line, next) ||
	isTableHeaderEnd(line, next);

/**
 * Splits the pages into currency blocks and their raw rows, and reads the header and summary. Description text
 * can only be read inside a table (from a page's `SALDO /`, `BALANCE` to its legal text), so the structure fails
 * closed against it: see the module comment. A row stays open across a page break: the next page's first table
 * lines before a row start continue it.
 */
function segment({ pages, canStart }: PositionedPages): Segmented {
	const out: Segmented = {
		blocks: [],
		periods: new Set(),
		accounts: new Set(),
		summary: new Map(),
		totals: [],
		broken: false
	};
	let current: RawBlock | null = null;
	let row: string[] | null = null;
	pages.forEach((lines, p) => {
		let periods = 0;
		let accounts = 0;
		let legal = 0;
		let inTable = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			const next = lines[i + 1];
			if (inTable) {
				if (LEGAL.test(line)) {
					legal++;
					inTable = false;
				} else if (isSummaryStart(lines, i)) {
					// The summary right after the last row: the table ends here. A note imitating it cuts its own
					// row, and any row after it then sits outside a table, which refuses the whole file below.
					inTable = false;
					row = null;
				} else if (isHeaderLine(line, next) || BEGINNING.test(line)) out.broken = true;
				else if (CURRENCY_CODE.test(line)) {
					const currency = CURRENCY_CODE.exec(line)![1]!;
					const opening = next === undefined ? null : BEGINNING.exec(next);
					if (
						!opening ||
						out.blocks.some((b) => b.currency === currency) ||
						out.blocks.length >= OCBC_MAX_SECTIONS
					)
						out.broken = true;
					current = {
						currency,
						opening: opening ? amountOf(opening[1]!) : null,
						rows: [],
						broken: false
					};
					out.blocks.push(current);
					row = null;
					if (opening) i++;
				} else if (ROW_START.test(line) && canStart(p, i)) {
					if (!current) out.broken = true;
					else {
						row = [line];
						current.rows.push(row);
					}
				} else if (row) row.push(line);
				else if (current) current.broken = true;
				else out.broken = true;
				continue;
			}
			const period = PERIOD.exec(line);
			const summary = SUMMARY_ROW.exec(line);
			const total = SUMMARY_TOTAL.exec(line);
			if (period) {
				periods++;
				out.periods.add(`${period[1]} - ${period[2]}`);
			} else if (isAccountLabel(line, next)) {
				const account = ACCOUNT_VALUE.exec(lines[i + 2] ?? '');
				if (account) {
					accounts++;
					out.accounts.add(`${account[1]}|${account[2]!.trim()}`);
				} else out.broken = true;
			} else if (LEGAL.test(line)) legal++;
			else if (summary) {
				const [, currency, rate, balance, idr] = summary;
				if (out.summary.has(currency!)) out.broken = true;
				out.summary.set(currency!, {
					rate: rate!,
					balance: amountOf(balance!),
					idr: amountOf(idr!)
				});
			} else if (total) out.totals.push(amountOf(total[1]!));
			else if (isTableHeaderEnd(line, next)) {
				inTable = true;
				i++;
			} else if (ROW_START.test(line) || CURRENCY_CODE.test(line) || BEGINNING.test(line))
				out.broken = true;
		}
		// Every page prints its period and account once; a table ends at the page's one legal text.
		if (periods !== 1 || accounts !== 1 || legal > 1 || inTable) out.broken = true;
	});
	return out;
}

/** One raw row → its MappedRow and printed balance; the amount line may be any of its lines, but only one. */
function readRow(index: number, lines: readonly string[], period: Period | null): ReadRow {
	const reject = (reason: 'missing_amount' | 'unparseable_amount' | 'unparseable_date') => ({
		row: { index, ok: false as const, reason },
		balance: null
	});
	const start = ROW_START.exec(lines[0]!)!;
	const texts = [...(start[3] ? [start[3]] : []), ...lines.slice(1)];
	const at = texts.flatMap((t, i) => (ROW_AMOUNT.test(t) ? [i] : []));
	if (at.length === 0) return reject('missing_amount');
	// A note imitating an amount line is third-party text: unreadable, never "the first one wins".
	if (at.length > 1) return reject('unparseable_amount');
	const amount = ROW_AMOUNT.exec(texts[at[0]!]!)!;
	if (amount[1] && TRAILING_AMOUNT.test(amount[1])) return reject('unparseable_amount');
	const date = slashDate(start[1]!);
	if (!date || !slashDate(start[2]!) || !period || date < period.from || date > period.to)
		return reject('unparseable_date');
	const debit = amountOf(amount[2]!);
	const credit = amountOf(amount[3]!);
	if (debit === null || credit === null || (debit === 0) === (credit === 0))
		return reject('unparseable_amount');
	// Every other line, before and after the amount line, in order: the note stays whole (FN-48 reads it).
	const description = texts
		.map((t, i) => (i === at[0] ? (amount[1] ?? '') : t))
		.filter((t) => t !== '')
		.join(' ');
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

/**
 * The summary lists every currency block of the file, IDR at 1.000 to itself, and its total is its IDR column.
 * It may list more: a currency sub-account with no movement in the period prints no table block, only its
 * summary line (a September 2026 sample: an SGD line, no SGD table).
 */
function summaryChecksOut(s: Segmented): boolean {
	if (s.totals.length !== 1 || s.totals[0] === null) return false;
	if (!s.blocks.every((b) => s.summary.has(b.currency))) return false;
	let idrTotal = 0;
	for (const [currency, row] of s.summary) {
		if (row.balance === null || row.idr === null) return false;
		if (currency === 'IDR' && (row.rate !== '1.000' || row.balance !== row.idr)) return false;
		idrTotal += row.idr;
	}
	return Number.isSafeInteger(idrTotal) && idrTotal === s.totals[0];
}

export function parseRekeningKoran(positioned: PositionedPages): StatementParse {
	const segmented = segment(positioned);
	const [from, to] = (only(segmented.periods) ?? '').split(' - ').map(dateOf);
	const period = from && to && from <= to ? { from, to } : null;
	const account = only(segmented.accounts);
	const [number, product] = account?.split('|') ?? [];
	const sections: StatementSection[] = [];
	let broken = segmented.broken || !summaryChecksOut(segmented);
	let nextIndex = 0;
	for (const raw of segmented.blocks.slice(0, OCBC_MAX_SECTIONS)) {
		const read = raw.rows.map((lines, i) => readRow(nextIndex + i, lines, period));
		nextIndex += raw.rows.length;
		const closing = segmented.summary.get(raw.currency)?.balance ?? null;
		const checksOut = !raw.broken && consistent(read, raw.opening, closing);
		const foreign = raw.currency !== 'IDR';
		// A foreign block has no refusal of its own to show a failed check: its doubt is the file's.
		if (foreign && !checksOut) broken = true;
		const refusal: StatementSection['refusal'] = foreign
			? 'unsupported_currency'
			: checksOut
				? null
				: 'inconsistent';
		sections.push({
			label: `${product ?? ''} ${raw.currency}`.trim(),
			accountLast4: number ? number.slice(-4) : null,
			refusal,
			parse: {
				rows: foreign
					? read.map((r) => ({ index: r.row.index, ok: false, reason: 'unsupported_currency' }))
					: read.map((r) => r.row),
				openingBalanceMinor: foreign ? null : raw.opening,
				closingBalanceMinor: foreign ? null : closing,
				inconsistent: refusal !== null
			}
		});
	}
	return {
		rows: [],
		openingBalanceMinor: null,
		closingBalanceMinor: null,
		// One period, one account, a sound structure and summary, or the whole file is refused.
		inconsistent: broken || period === null || account === null || sections.length === 0,
		sections
	};
}
