import { isMonthString, monthRange } from '../dates.ts';
import { detectBcaCsv, parseBcaCsv } from './bca-csv.ts';
import { parseMoneyAmount } from '../money-parse.ts';
import { dateInPeriod, statementRow, type StatementPeriod } from './rows.ts';
import type { MappedRow, StatementDocument, StatementParse, StatementParser } from './types.ts';

/**
 * BCA e-Statement (myBCA › e-Statement, monthly text PDF) — FN-16b, written from the structure of a real sample
 * (no value from it is kept here). What the text layer looks like, one extracted line per line:
 *
 * - a page header with `NO. REKENING :`, `HALAMAN :`, `PERIODE : <BULAN> <YYYY>` and `MATA UANG : <ISO>`, repeated on
 *   every page, then the table header `TANGGAL KETERANGAN CBG MUTASI SALDO`;
 * - an opening line `DD/MM SALDO AWAL <saldo>` (not a transaction);
 * - one transaction per `DD/MM <keterangan…>` line, its description wrapping over the following lines and the
 *   row ending with the line carrying the amount: `<mutasi> [DB] [<saldo>]` — `DB` marks a debit, an unmarked
 *   amount is a credit, the running balance is printed only on some rows. A wrapped line may itself start with a
 *   date (`TANGGAL :09/03` then `09/03 /ZW7Q1/00000`), so a `DD/MM` line only starts a new row once the open row
 *   has its amount line;
 * - amounts as `1,234,567.89` (comma thousands, dot cents);
 * - the closing block on the last page: `SALDO AWAL : …`, `MUTASI CR : … <n>`, `MUTASI DB : … <n>`,
 *   `SALDO AKHIR : …`.
 *
 * The year of each `DD/MM` comes from the printed period, never from "this year".
 *
 * Wrapped description lines (sender, transfer remark, merchant name) are written by third parties, so nothing in
 * them may decide an amount (red team M1, FN-16b): a row with more than one amount-shaped line is unreadable, and
 * the statement is only accepted when it checks out against itself — every printed running balance, the printed
 * opening and closing balances and the `MUTASI CR/DB` totals and counts match the rows exactly, in integer minor
 * units, every row is readable and every page agrees on period and currency. Otherwise it is `inconsistent` and
 * refused as a whole (nothing imported), never imported with a warning.
 *
 * The same institution's CSV mutation export (KlikBCA / myBCA, FN-16c) is read by `bca-csv.ts`.
 */

const TABLE_HEADER = /^TANGGAL KETERANGAN CBG MUTASI SALDO$/;
const PERIOD = /^PERIODE\s*:\s*([A-Z]+)\s+(\d{4})$/;
const CURRENCY = /^MATA UANG\s*:?\s*(.*)$/;
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})*\.\d{2}`;
/** A row's amount line: the mutation, an optional DB/CR mark, an optional running balance. */
const AMOUNT_TAIL = new RegExp(String.raw`(?:^|\s)(${AMOUNT})(?:\s+(DB|CR))?(?:\s+(${AMOUNT}))?$`);
const ROW_START = /^(\d{2})\/(\d{2})\s+(\S.*)$/;
const OPENING_ROW = new RegExp(String.raw`^SALDO AWAL\s+(${AMOUNT})$`);
const SUMMARY_OPENING = new RegExp(String.raw`^SALDO AWAL\s*:\s*(${AMOUNT})$`);
const SUMMARY_CLOSING = new RegExp(String.raw`^SALDO AKHIR\s*:\s*(${AMOUNT})$`);
const SUMMARY_TOTAL = new RegExp(String.raw`^MUTASI (CR|DB)\s*:\s*(${AMOUNT})\s+(\d{1,6})$`);

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

/** A page's text as trimmed, single-spaced, non-empty lines. */
const linesOf = (page: string) =>
	page
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter((l) => l !== '');

const amountOf = (text: string) => parseMoneyAmount(text)?.minor ?? null;

/** `SEPTEMBER 2026` (a `PERIODE :` value) → that calendar month (WIB dates), or null. */
function periodOf(printed: string): StatementPeriod | null {
	const [name = '', year = ''] = printed.split(' ');
	const month = MONTHS.indexOf(name) + 1;
	const value = `${year}-${String(month).padStart(2, '0')}`;
	return month > 0 && isMonthString(value) ? monthRange(value) : null;
}

/** One `DD/MM` row: its lines up to the next row, the closing block or the page end. */
interface RawRow {
	day: number;
	month: number;
	/** The `DD/MM` as printed. */
	printed: string;
	lines: string[];
	/** One of `lines` has the amount shape: the row is complete and the next `DD/MM` line starts a new one. */
	hasAmount: boolean;
}

/** What a statement prints about itself; each distinct value seen is kept, so a disagreement is visible. */
interface Printed {
	periods: Set<string>;
	currencies: Set<string>;
	openings: Set<number | null>;
	closings: Set<number | null>;
	totals: Map<'CR' | 'DB', Set<string>>;
}

/**
 * Splits the pages' tables into raw rows and collects the printed header and closing values. `broken`: a line in a
 * table ends in an amount while no row is open, which only happens after remark text imitated the table header
 * (red team cycle 2 L1): the row's real amount line would otherwise be dropped silently.
 */
function segment(pages: readonly string[]): { rows: RawRow[]; printed: Printed; broken: boolean } {
	const printed: Printed = {
		periods: new Set(),
		currencies: new Set(),
		openings: new Set(),
		closings: new Set(),
		totals: new Map([
			['CR', new Set()],
			['DB', new Set()]
		])
	};
	const rows: RawRow[] = [];
	let broken = false;
	for (const lines of pages.map(linesOf)) {
		// Only the table: the page header and notices above it are not rows; the closing block ends it.
		let inTable = false;
		let open: RawRow | null = null;
		for (const line of lines) {
			const period = PERIOD.exec(line);
			if (period) printed.periods.add(`${period[1]} ${period[2]}`);
			const currency = CURRENCY.exec(line);
			if (currency) printed.currencies.add(currency[1]!.trim());
			const total = SUMMARY_TOTAL.exec(line);
			if (total) printed.totals.get(total[1] as 'CR' | 'DB')!.add(`${total[2]} ${total[3]}`);
			const summaryOpening = SUMMARY_OPENING.exec(line);
			const summaryClosing = SUMMARY_CLOSING.exec(line);
			if (summaryOpening || summaryClosing) {
				if (summaryOpening) printed.openings.add(amountOf(summaryOpening[1]!));
				if (summaryClosing) printed.closings.add(amountOf(summaryClosing[1]!));
				inTable = false;
				open = null;
				continue;
			}
			if (TABLE_HEADER.test(line)) {
				inTable = true;
				open = null;
				continue;
			}
			if (!inTable) continue;
			const start = ROW_START.exec(line);
			// A dated line before the open row's amount is a wrapped description line, not a new row.
			if (start && !(open && !open.hasAmount)) {
				const opened = OPENING_ROW.exec(start[3]!);
				if (opened) {
					printed.openings.add(amountOf(opened[1]!));
					open = null;
					continue;
				}
				open = {
					day: Number(start[1]),
					month: Number(start[2]),
					printed: `${start[1]}/${start[2]}`,
					lines: [start[3]!],
					hasAmount: AMOUNT_TAIL.test(start[3]!)
				};
				rows.push(open);
			} else if (open) {
				open.lines.push(line);
				if (AMOUNT_TAIL.test(line)) open.hasAmount = true;
			} else if (AMOUNT_TAIL.test(line)) broken = true;
		}
	}
	return { rows, printed, broken };
}

/** A raw row's amount line, when exactly one of its lines has the amount shape; null when none or several. */
function amountLine(lines: readonly string[]) {
	let found: { at: number; match: RegExpExecArray } | null = null;
	for (let at = 0; at < lines.length; at++) {
		const match = AMOUNT_TAIL.exec(lines[at]!);
		if (!match) continue;
		// A second amount-shaped line means third-party text imitates one: unreadable, never "the first wins".
		if (found) return { ambiguous: true as const };
		found = { at, match };
	}
	return found ? { ambiguous: false as const, ...found } : null;
}

function parsePdf(pages: readonly string[]): StatementParse {
	const { rows: raw, printed, broken } = segment(pages);
	// Pages disagreeing on the period leave every date unreadable (and the statement inconsistent).
	const onePeriod = only(printed.periods);
	const period = onePeriod === null ? null : periodOf(onePeriod);
	const rows: MappedRow[] = [];
	/** Printed running balance per row index (only on some rows). */
	const balances = new Map<number, number | null>();
	for (const r of raw) {
		const index = rows.length;
		// A day outside the printed month (or no single printed month) is an unreadable date, never moved.
		const date = (period && dateInPeriod(r.day, r.month, period)) ?? r.printed;
		const found = amountLine(r.lines);
		if (!found || found.ambiguous) {
			rows.push({
				index,
				ok: false,
				reason: found ? 'unparseable_amount' : 'missing_amount'
			});
			continue;
		}
		// Lines after the amount line (footers, page counters) are not part of the description.
		const last = r.lines[found.at]!.slice(0, found.match.index).trim();
		const description = [...r.lines.slice(0, found.at), ...(last ? [last] : [])].join(' ');
		if (found.match[3]) balances.set(index, amountOf(found.match[3]));
		rows.push(
			statementRow(index, {
				date,
				direction: found.match[2] === 'DB' ? 'debit' : 'credit',
				amount: found.match[1]!,
				description
			})
		);
	}

	const currencies = [...printed.currencies];
	if (currencies.some((c) => c !== 'IDR'))
		return {
			rows: rows.map((r) => ({ index: r.index, ok: false, reason: 'unsupported_currency' })),
			openingBalanceMinor: null,
			closingBalanceMinor: null
		};
	const opening = only(printed.openings);
	const closing = only(printed.closings);
	return {
		rows,
		openingBalanceMinor: opening,
		closingBalanceMinor: closing,
		inconsistent: broken || !consistent(rows, balances, printed, opening, closing)
	};
}

/** The statement checks out against itself (see the module comment); any doubt is false. */
function consistent(
	rows: readonly MappedRow[],
	balances: ReadonlyMap<number, number | null>,
	printed: Printed,
	opening: number | null,
	closing: number | null
): boolean {
	if (printed.periods.size !== 1 || printed.currencies.size > 1) return false;
	if (opening === null || closing === null) return false;
	let running = opening;
	const sums = { CR: { total: 0, count: 0 }, DB: { total: 0, count: 0 } };
	for (const r of rows) {
		if (!r.ok) return false;
		const credit = r.value.type === 'income';
		running += credit ? r.value.amountMinor : -r.value.amountMinor;
		const sum = sums[credit ? 'CR' : 'DB'];
		sum.total += r.value.amountMinor;
		sum.count++;
		if (!Number.isSafeInteger(running)) return false;
		if (balances.has(r.index) && balances.get(r.index) !== running) return false;
	}
	if (running !== closing) return false;
	for (const kind of ['CR', 'DB'] as const) {
		const seen = printed.totals.get(kind)!;
		if (seen.size === 0) continue;
		const [total = '', count = ''] = (only(seen) ?? '').split(' ');
		if (amountOf(total) !== sums[kind].total || Number(count) !== sums[kind].count) return false;
	}
	return true;
}

function only<T>(set: Set<T>): T | null {
	return set.size === 1 ? [...set][0]! : null;
}

export const BCA: StatementParser = {
	id: 'bca',
	label: 'BCA',
	formats: ['pdf_text', 'csv'],
	detect(doc: StatementDocument) {
		if (doc.format === 'csv') return detectBcaCsv(doc.rows);
		const lines = doc.pages.flatMap(linesOf);
		if (!lines.some((l) => TABLE_HEADER.test(l))) return 0;
		return lines.some((l) => PERIOD.test(l)) ? 0.9 : 0.6;
	},
	parse(doc: StatementDocument) {
		return doc.format === 'csv' ? parseBcaCsv(doc.rows) : parsePdf(doc.pages);
	}
};
