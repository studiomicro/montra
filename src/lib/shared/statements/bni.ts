import { isDateString } from '../dates.ts';
import { parseMoneyAmount } from '../money-parse.ts';
import { statementRow, type StatementPeriod } from './rows.ts';
import type { MappedRow, StatementDocument, StatementParse, StatementParser } from './types.ts';

/**
 * BNI "Laporan Mutasi Rekening" (BNI's e-statement / mutasi PDF) — FN-16d, written from the structure of a real
 * multi-page sample (no value from it is kept here). What the text layer looks like, one extracted line per line:
 *
 * - every page starts with `Laporan Mutasi Rekening`, `Periode: <d> - <d> <Bulan> <yyyy>` and BNI's legal notice
 *   (`PT Bank Negara Indonesia (Persero) Tbk. …`), whose last line ends with the page counter `<n> dari <total>`;
 * - page 1 then has the holder's name and address, the product and account number, `… Cabang: … • Mata Uang:
 *   IDR`, and a summary of label/value line pairs: `Saldo Awal` / `<saldo>`, `Total Pemasukan` / `+<total>`,
 *   `Total Pengeluaran` / `-<total>`, `Saldo Akhir` / `<saldo>`;
 * - the table header `Tanggal & Waktu Rincian Transaksi Nominal (IDR) Saldo (IDR)`, then (page 1 only) the
 *   opening row `Saldo Awal <saldo>`;
 * - one transaction per `<d> <Mon> <yyyy>` line, followed by `<hh:mm:ss> WIB`, the kind (`Pembayaran Qris`,
 *   `Transfer`, `Biaya`, …) and the detail line ending with `<±nominal> <saldo>` — the sign is the direction
 *   (`-` money out, `+` money in), and every row prints its running balance;
 * - amounts as `1,234,567` (comma thousands; no cents in the sample, `.dd` accepted);
 * - the last page closes the table with `Saldo Akhir <saldo>`, then an `Informasi …` notes block.
 *
 * Dates print their own year; each must fall inside the printed period. The period's start takes its month and
 * year from the end when it omits them (`1 - 30 Juni 2026`), and a start month after the end month is in the
 * previous year (`16 Desember - 15 Januari 2027`).
 *
 * The kind and detail lines carry third-party text (merchant, sender), so nothing in them may decide an amount
 * (FN-16b red team M1): a row with more than one amount-shaped line is unreadable, and the statement is only
 * accepted when it checks out against itself — every running balance follows from the opening balance and the
 * rows, the summary and table opening/closing balances agree, the in/out totals match the rows, every page
 * carries the same period and its own `<n> dari <total>` counter, and the currency is IDR. Otherwise it is
 * `inconsistent` and refused as a whole, never imported with a warning.
 */

const TITLE = /^Laporan Mutasi Rekening$/;
const BANK = /^PT Bank Negara Indonesia \(Persero\) Tbk\./;
const TABLE_HEADER = /^Tanggal & Waktu Rincian Transaksi Nominal \(IDR\) Saldo \(IDR\)$/;
const PERIOD = /^Periode\s*:\s*(.+)$/;
const PERIOD_RANGE =
	/^(\d{1,2})(?:\s+([A-Za-z]+)(?:\s+(\d{4}))?)?\s*-\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/;
const PAGE_COUNTER = /(?:^|\s)(\d{1,3}) dari (\d{1,3})$/;
const CURRENCY = /\bMata Uang\s*:\s*(\S+)/;
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})*(?:\.\d{2})?`;
/** A row's amount line: the signed nominal, then the running balance, at the end of the line. */
const AMOUNT_TAIL = new RegExp(String.raw`(?:^|\s)([+-])(${AMOUNT})\s+(${AMOUNT})$`);
const ROW_DATE = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/;
const ROW_TIME = /^\d{2}:\d{2}:\d{2} WIB$/;
const TABLE_OPENING = new RegExp(String.raw`^Saldo Awal (${AMOUNT})$`);
const TABLE_CLOSING = new RegExp(String.raw`^Saldo Akhir (${AMOUNT})$`);
/** Page 1 summary: the label line, then a line holding only the value (with the sign shown here). */
const SUMMARY: Readonly<Record<string, { key: keyof SummaryValues; value: RegExp }>> = {
	'Saldo Awal': { key: 'openings', value: new RegExp(String.raw`^(${AMOUNT})$`) },
	'Saldo Akhir': { key: 'closings', value: new RegExp(String.raw`^(${AMOUNT})$`) },
	'Total Pemasukan': { key: 'credits', value: new RegExp(String.raw`^\+(${AMOUNT})$`) },
	'Total Pengeluaran': { key: 'debits', value: new RegExp(String.raw`^-(${AMOUNT})$`) }
};

const MONTHS = [
	'januari',
	'februari',
	'maret',
	'april',
	'mei',
	'juni',
	'juli',
	'agustus',
	'september',
	'oktober',
	'november',
	'desember'
];
/**
 * Row month abbreviations. Older statements print them in Indonesian (August as `Agu` or `Agt`); newer ones print
 * English (`01 Aug 2026`), while the `Periode:` line stays Indonesian. Both are accepted; the four that differ are
 * `May`, `Aug`, `Oct` and `Dec`.
 */
const MONTH_ABBR: Readonly<Record<string, number>> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	mei: 5,
	may: 5,
	jun: 6,
	jul: 7,
	agu: 8,
	agt: 8,
	aug: 8,
	sep: 9,
	okt: 10,
	oct: 10,
	nov: 11,
	des: 12,
	dec: 12
};

const pad = (n: number) => String(n).padStart(2, '0');

/** A page's text as trimmed, single-spaced, non-empty lines. */
const linesOf = (page: string) =>
	page
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter((l) => l !== '');

const amountOf = (text: string) => parseMoneyAmount(text)?.minor ?? null;

/** `1 - 30 Juni 2026` (a `Periode:` value) → its WIB dates, or null. */
export function bniPeriod(printed: string): StatementPeriod | null {
	const m = PERIOD_RANGE.exec(printed);
	if (!m) return null;
	const toMonth = MONTHS.indexOf(m[5]!.toLowerCase()) + 1;
	const fromMonth = m[2] === undefined ? toMonth : MONTHS.indexOf(m[2].toLowerCase()) + 1;
	if (toMonth === 0 || fromMonth === 0) return null;
	const toYear = Number(m[6]);
	const fromYear = m[3] !== undefined ? Number(m[3]) : fromMonth > toMonth ? toYear - 1 : toYear;
	const from = `${fromYear}-${pad(fromMonth)}-${pad(Number(m[1]))}`;
	const to = `${toYear}-${pad(toMonth)}-${pad(Number(m[4]))}`;
	return isDateString(from) && isDateString(to) && from <= to ? { from, to } : null;
}

/** `5 Jun 2026` → `2026-06-05`, or null for an unknown month or an impossible day. */
function rowDate(day: string, month: string, year: string): string | null {
	const n = MONTH_ABBR[month.toLowerCase()];
	if (!n) return null;
	const date = `${year}-${pad(n)}-${pad(Number(day))}`;
	return isDateString(date) ? date : null;
}

/** One dated row: its lines (time, kind, detail…) up to the next row, the closing row or the page end. */
interface RawRow {
	date: string | null;
	lines: string[];
	/** The amount line has been seen (a later `Saldo Awal/Akhir …` line may then end the table). */
	complete: boolean;
}

interface SummaryValues {
	/** Opening balances: the page 1 summary and the table's opening row. */
	openings: (number | null)[];
	closings: (number | null)[];
	credits: (number | null)[];
	debits: (number | null)[];
}

/** What the statement prints about itself; every occurrence is kept, so a disagreement is visible. */
interface Printed extends SummaryValues {
	periods: Set<string>;
	currencies: Set<string>;
	/** Each page's `<n> dari <total>` counters, in page order. */
	counters: string[][];
}

/** Splits the pages' tables into raw rows and collects the printed header, summary and closing values. */
function segment(pages: readonly string[]): { rows: RawRow[]; printed: Printed } {
	const printed: Printed = {
		periods: new Set(),
		currencies: new Set(),
		counters: [],
		openings: [],
		closings: [],
		credits: [],
		debits: []
	};
	const rows: RawRow[] = [];
	for (const lines of pages.map(linesOf)) {
		const counters: string[] = [];
		printed.counters.push(counters);
		// Above the table: page header and (page 1) the holder block and summary. The closing row ends it.
		let inTable = false;
		let open: RawRow | null = null;
		let pending: (typeof SUMMARY)[string] | null = null;
		let closed = false;
		for (const line of lines) {
			// After the closing row only BNI's notes follow on that page.
			if (closed) break;
			if (!inTable) {
				if (pending) {
					const value = pending.value.exec(line);
					if (value) printed[pending.key].push(amountOf(value[1]!));
					pending = null;
					if (value) continue;
				}
				if (TABLE_HEADER.test(line)) {
					inTable = true;
					continue;
				}
				const period = PERIOD.exec(line);
				if (period) printed.periods.add(period[1]!);
				const currency = CURRENCY.exec(line);
				if (currency) printed.currencies.add(currency[1]!);
				const counter = PAGE_COUNTER.exec(line);
				if (counter) counters.push(`${counter[1]} dari ${counter[2]}`);
				pending = Object.hasOwn(SUMMARY, line) ? SUMMARY[line]! : null;
				continue;
			}
			// Opening/closing rows only between rows, never inside an unfinished one (a remark imitating them).
			if (!open || open.complete) {
				const opening = TABLE_OPENING.exec(line);
				if (opening) {
					printed.openings.push(amountOf(opening[1]!));
					open = null;
					continue;
				}
				const closing = TABLE_CLOSING.exec(line);
				if (closing) {
					printed.closings.push(amountOf(closing[1]!));
					closed = true;
					continue;
				}
			}
			const start = ROW_DATE.exec(line);
			if (start) {
				open = { date: rowDate(start[1]!, start[2]!, start[3]!), lines: [], complete: false };
				rows.push(open);
			} else if (open) {
				open.lines.push(line);
				if (AMOUNT_TAIL.test(line)) open.complete = true;
			}
		}
	}
	return { rows, printed };
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

function only<T>(set: Set<T>): T | null {
	return set.size === 1 ? [...set][0]! : null;
}

function parsePdf(pages: readonly string[]): StatementParse {
	const { rows: raw, printed } = segment(pages);
	const onePeriod = only(printed.periods);
	const period = onePeriod === null ? null : bniPeriod(onePeriod);
	const rows: MappedRow[] = [];
	const balances: (number | null)[] = [];
	for (const r of raw) {
		const index = rows.length;
		balances.push(null);
		// The time line comes right after the date; a date outside the printed period is unreadable, never moved.
		const dated =
			r.date !== null &&
			period !== null &&
			r.date >= period.from &&
			r.date <= period.to &&
			ROW_TIME.test(r.lines[0] ?? '');
		const found = amountLine(r.lines);
		if (!found || found.ambiguous) {
			rows.push({ index, ok: false, reason: found ? 'unparseable_amount' : 'missing_amount' });
			continue;
		}
		const detail = r.lines[found.at]!.slice(0, found.match.index).trim();
		const description = [...r.lines.slice(1, found.at), detail, ...r.lines.slice(found.at + 1)]
			.filter((l) => l !== '')
			.join(' ');
		balances[index] = amountOf(found.match[3]!);
		rows.push(
			statementRow(index, {
				date: dated ? r.date : 'unreadable',
				direction: found.match[1] === '-' ? 'debit' : 'credit',
				amount: found.match[2]!,
				description
			})
		);
	}

	if ([...printed.currencies].some((c) => c !== 'IDR'))
		return {
			rows: rows.map((r) => ({ index: r.index, ok: false, reason: 'unsupported_currency' })),
			openingBalanceMinor: null,
			closingBalanceMinor: null
		};
	const opening = agreed(printed.openings, 2);
	const closing = agreed(printed.closings, 2);
	return {
		rows,
		openingBalanceMinor: opening,
		closingBalanceMinor: closing,
		inconsistent: !consistent(rows, balances, printed, period, opening, closing)
	};
}

/** The single value printed exactly `times` times (all equal), else null. */
function agreed(values: readonly (number | null)[], times: number): number | null {
	if (values.length !== times || values.some((v) => v === null || v !== values[0])) return null;
	return values[0]!;
}

/** The statement checks out against itself (see the module comment); any doubt is false. */
function consistent(
	rows: readonly MappedRow[],
	balances: readonly (number | null)[],
	printed: Printed,
	period: StatementPeriod | null,
	opening: number | null,
	closing: number | null
): boolean {
	if (period === null || only(printed.currencies) !== 'IDR') return false;
	const total = printed.counters.length;
	if (printed.counters.some((c, i) => c.length !== 1 || c[0] !== `${i + 1} dari ${total}`))
		return false;
	const credits = agreed(printed.credits, 1);
	const debits = agreed(printed.debits, 1);
	if (opening === null || closing === null || credits === null || debits === null) return false;
	let running = opening;
	let inSum = 0;
	let outSum = 0;
	for (const r of rows) {
		if (!r.ok) return false;
		const credit = r.value.type === 'income';
		running += credit ? r.value.amountMinor : -r.value.amountMinor;
		if (credit) inSum += r.value.amountMinor;
		else outSum += r.value.amountMinor;
		if (!Number.isSafeInteger(running) || balances[r.index] !== running) return false;
	}
	return running === closing && inSum === credits && outSum === debits;
}

export const BNI: StatementParser = {
	id: 'bni',
	label: 'BNI',
	formats: ['pdf_text'],
	detect(doc: StatementDocument) {
		if (doc.format !== 'pdf_text') return 0;
		const lines = doc.pages.flatMap(linesOf);
		if (!lines.some((l) => TABLE_HEADER.test(l))) return 0;
		return lines.some((l) => TITLE.test(l)) && lines.some((l) => BANK.test(l)) ? 0.9 : 0.6;
	},
	parse(doc: StatementDocument) {
		return doc.format === 'pdf_text'
			? parsePdf(doc.pages)
			: { rows: [], openingBalanceMinor: null, closingBalanceMinor: null, inconsistent: true };
	}
};
