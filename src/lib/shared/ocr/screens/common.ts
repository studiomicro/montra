import { isDateString, parseRelativeIndonesianDate } from '../../dates.ts';
import { parseMoneyAmount } from '../../money-parse.ts';
import { dateInPeriod, statementRow, type StatementPeriod } from '../../statements/rows.ts';
import type { MappedRow, RowReview } from '../../csv.ts';
import {
	needsNumericReview,
	OCR_MIN_NUMERIC_CONF,
	OCR_REVIEW_NUMERIC_CONF,
	pageUnclear,
	UNREADABLE
} from '../confidence.ts';
import type { OcrDocument, OcrLine } from '../lines.ts';

/**
 * The list reader behind the screenshot families (FN-16g, PRD Scope 5.4): e-wallet history lists and
 * mobile-banking mutation lists share one shape — optional day-group headers, a row per transaction with a
 * title and an amount (same line or the next), optional time, status and running balance lines. Pure: it reads
 * an `OcrDocument` whose low-confidence figures are already poisoned (confidence.ts).
 *
 * UNVERIFIED AGAINST REAL SCREENSHOTS: written from the PRD's description and tested with fictional fixtures
 * only, until the owner's redacted samples have been run through `npm run compat:ocr`.
 *
 * Rules that never bend: amounts come only from `statementRow` (the shared money parser) and only from
 * statement-shaped figures (`Rp`/`IDR` or thousands grouping; never `25rb`); direction only from an explicit,
 * confidently read sign or DB/CR/D/K mark (never from words like "Top Up"); a year only from the screen itself,
 * else assumed and marked for review; never a future date; nothing is corrected.
 */

/** One screenshot family's reader (an app, or a bank's mobile app). */
export interface ScreenParser {
	/** Stable id (`gopay`, `m-bca`): the picker value and the harness column. */
	id: string;
	/** The app's own name (nominative; no brand asset is used). */
	label: string;
	family: 'ewallet' | 'mobile_banking';
	/** True when the app's own words appear in a page's header lines. */
	claims(header: string): boolean;
}

/** Lines at the top of a page that count as its header (status bar, app bar, screen title). */
export const HEADER_LINES = 6;

/** Status words of a row that did not complete: skipped and counted, never imported. */
const NOT_COMPLETED = /\b(gagal|dibatalkan|batal|menunggu|failed|cancel(?:l)?ed|pending)\b/i;
/** Status words of a completed row (dropped from the title). */
const COMPLETED = /\b(berhasil|sukses|selesai|success(?:ful)?|completed)\b/i;

/** A line as single-spaced text with each word's span (for the confidence of what a pattern matched). */
interface LineView {
	page: number;
	text: string;
	words: { t: string; c: number; start: number; end: number }[];
}

function viewOf(line: OcrLine, page: number): LineView {
	let text = '';
	const words: LineView['words'] = [];
	for (const w of line.words) {
		if (text !== '') text += ' ';
		words.push({ t: w.t, c: w.c, start: text.length, end: text.length + w.t.length });
		text += w.t;
	}
	return { page, text, words };
}

const wordsIn = (view: LineView, start: number, end: number) =>
	view.words.filter((w) => w.end > start && w.start < end);

const minConf = (view: LineView, start: number, end: number) =>
	Math.min(100, ...wordsIn(view, start, end).map((w) => w.c));

/** A statement-shaped amount: signed or not, with `Rp`/`IDR` or thousands grouping, with an optional mark. */
const AMOUNT =
	/(?<![\p{L}\p{Nd}.,:/])([+\-−]\s?)?(Rp\.?|IDR)?\s?([+\-−]\s?)?(\d{1,3}(?:([.,])\d{3})(?:\5\d{3})*(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)(?:\s?(DB|CR|D|K)(?![\p{L}\p{Nd}]))?(?![\p{L}\p{Nd}]|[.,]\d)/gu;

export interface AmountMatch {
	start: number;
	end: number;
	/** The figure only (`25.000`, `1,250,000.00`): what the money parser reads. */
	figure: string;
	direction: 'debit' | 'credit' | null;
	/** A sign or mark was printed but not read confidently: the direction is unknown. */
	unsureDirection: boolean;
}

/** Every statement-shaped amount on a line, in reading order. */
export function amountsIn(view: { text: string; words: LineView['words'] }): AmountMatch[] {
	const out: AmountMatch[] = [];
	for (const m of view.text.matchAll(AMOUNT)) {
		const [, sign1, currency, sign2, figure = '', separator, mark] = m;
		if (!currency && !separator && !/[.,]\d{2}$/.test(figure)) continue;
		if (!currency && !separator && !mark && !sign1 && !sign2) continue;
		const start = m.index;
		const end = start + m[0].length;
		const sign = (sign1 ?? sign2 ?? '').trim();
		let direction: AmountMatch['direction'] = null;
		if (sign === '+') direction = 'credit';
		else if (sign !== '') direction = 'debit';
		else if (mark === 'DB' || mark === 'D') direction = 'debit';
		else if (mark === 'CR' || mark === 'K') direction = 'credit';
		const unsureDirection =
			direction !== null && minConf(view as LineView, start, end) < OCR_MIN_NUMERIC_CONF;
		out.push({
			start,
			end,
			figure,
			direction: unsureDirection ? null : direction,
			unsureDirection
		});
	}
	return out;
}

const MONTHS: Readonly<Record<string, number>> = {
	jan: 1,
	januari: 1,
	january: 1,
	feb: 2,
	februari: 2,
	february: 2,
	peb: 2,
	mar: 3,
	maret: 3,
	march: 3,
	apr: 4,
	april: 4,
	mei: 5,
	may: 5,
	jun: 6,
	juni: 6,
	june: 6,
	jul: 7,
	juli: 7,
	july: 7,
	agu: 8,
	agt: 8,
	ags: 8,
	aug: 8,
	agustus: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	okt: 10,
	oct: 10,
	oktober: 10,
	october: 10,
	nov: 11,
	nop: 11,
	november: 11,
	des: 12,
	dec: 12,
	desember: 12,
	december: 12
};

const WEEKDAY = String.raw`(?:senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s`;
const NUMERIC_DATE =
	/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?(?=[\s,]|$)|^(\d{1,2})\.(\d{1,2})\.(\d{4})(?=[\s,]|$)/;
const NAMED_DATE = new RegExp(
	String.raw`^(?:${WEEKDAY})?(\d{1,2})\s([a-z]{3,9})\.?(?:\s(\d{4}))?(?=[\s,]|$)`,
	'i'
);
const RELATIVE_DATE = /^(hari ini|kemarin)(?=[\s,]|$)/i;
const TIME = /(?<![\p{Nd}:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?:\s?WIB)?(?![\p{Nd}:])/u;

export type PrintedDate =
	| { kind: 'dated'; day: number; month: number; year: number | null; length: number; conf: number }
	| { kind: 'relative'; phrase: string; length: number; conf: number };

/** A date at the start of a line (`10/10`, `10/10/2026`, `10 Okt 2026`, `Senin, 10 Okt`, `Hari ini`). */
export function dateAtStart(view: { text: string; words: LineView['words'] }): PrintedDate | null {
	const conf = (length: number) => minConf(view as LineView, 0, length);
	const relative = RELATIVE_DATE.exec(view.text);
	if (relative)
		return {
			kind: 'relative',
			phrase: relative[1]!.toLowerCase(),
			length: relative[0].length,
			conf: conf(relative[0].length)
		};
	const numeric = NUMERIC_DATE.exec(view.text);
	if (numeric) {
		const day = Number(numeric[1] ?? numeric[4]);
		const month = Number(numeric[2] ?? numeric[5]);
		const y = numeric[3] ?? numeric[6];
		const year = y === undefined ? null : y.length === 2 ? 2000 + Number(y) : Number(y);
		if (month < 1 || month > 12 || day < 1 || day > 31) return null;
		return {
			kind: 'dated',
			day,
			month,
			year,
			length: numeric[0].length,
			conf: conf(numeric[0].length)
		};
	}
	const named = NAMED_DATE.exec(view.text);
	if (named) {
		const month = MONTHS[named[2]!.toLowerCase()];
		const day = Number(named[1]);
		if (!month || day < 1 || day > 31) return null;
		return {
			kind: 'dated',
			day,
			month,
			year: named[3] ? Number(named[3]) : null,
			length: named[0].length,
			conf: conf(named[0].length)
		};
	}
	return null;
}

/** A printed period (`Periode 01/10/2026 - 10/10/2026`, `1 Okt 2026 - 10 Okt 2026`), else null. */
export function periodIn(text: string): StatementPeriod | null {
	const body = text.replace(/^.*?(?:periode|period)\s*:?\s*/i, '');
	const [a = '', b = ''] = body.split(/\s[-–]\s|\s(?:s\/d|sd|sampai|to)\s/i);
	const view = (t: string) => ({ text: t.trim(), words: [] });
	const from = dateAtStart(view(a));
	const to = dateAtStart(view(b));
	if (from?.kind !== 'dated' || to?.kind !== 'dated' || !from.year || !to.year) return null;
	const iso = (d: { year: number | null; month: number; day: number }) =>
		`${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
	const period = { from: iso(from), to: iso(to) };
	return isDateString(period.from) && isDateString(period.to) && period.from <= period.to
		? period
		: null;
}

/** What one row was read from, before the money parser and the date rules. */
interface RawScreenRow {
	page: number;
	date: PrintedDate | null;
	/** Date from a group header above the row (when the row prints none itself). */
	groupDate: PrintedDate | null;
	amount: AmountMatch;
	balanceMinor: number | null;
	title: string;
	time: string | null;
	notCompleted: boolean;
	lowConfidence: boolean;
	/** More figures on the row line than an amount and its balance: which is the amount is not guessed. */
	ambiguous: boolean;
}

export interface ScreenRow {
	row: MappedRow;
	page: number;
	/** The dedupe key's distinguishing part: printed balance after the row, else its time, else ''. */
	keyPart: string;
	/** For the cross-image overlap check: the title as read. */
	title: string;
}

export interface ScreenParse {
	rows: ScreenRow[];
	/** Rows whose status says failed, cancelled or pending: skipped. */
	notCompleted: number;
	/** A figure in the list could not be read confidently: the whole reading is refused. */
	inconsistent: boolean;
}

export interface ScreenContext {
	/** WIB date of the import (relative days, assumed years, the no-future rule). */
	todayWib: string;
}

/** A line that only carries a time and/or a status (and maybe a date): it belongs to the row above. */
function isRowDetail(text: string): boolean {
	const rest = text
		.replace(TIME, ' ')
		.replace(NOT_COMPLETED, ' ')
		.replace(COMPLETED, ' ')
		.replace(/[·•,|-]/g, ' ')
		.trim();
	return rest === '' || dateAtStart({ text: rest, words: [] })?.length === rest.length;
}

const cleanTitle = (t: string) =>
	t.replace(TIME, ' ').replace(COMPLETED, ' ').replace(/[·•|]/g, ' ').replace(/\s+/g, ' ').trim();

const SALDO = /^(?:saldo|sisa saldo|balance)\b\s*:?\s*/i;

function segment(doc: OcrDocument): {
	raw: RawScreenRow[];
	poisoned: boolean;
	period: StatementPeriod | null;
	years: Set<number>;
} {
	const raw: RawScreenRow[] = [];
	let poisoned = false;
	let period: StatementPeriod | null = null;
	const years = new Set<number>();
	let groupDate: PrintedDate | null = null;
	doc.pages.forEach((page, p) => {
		let pendingTitle: string | null = null;
		/** The row's own date when it starts on a line of its own (`07/10 DESCRIPTION`, amount below). */
		let pendingLead: PrintedDate | null = null;
		let open: RawScreenRow | null = null;
		let started = false;
		const views = page.lines.map((l) => viewOf(l, p));
		views.forEach((view, i) => {
			const text = view.text;
			const header = i < HEADER_LINES && !started;
			const printedPeriod = /periode|period/i.test(text) ? periodIn(text) : null;
			if (printedPeriod) {
				period ??= printedPeriod;
				return;
			}
			const lead = dateAtStart(view);
			if (lead?.kind === 'dated' && lead.year) years.add(lead.year);
			const rest = lead ? text.slice(lead.length).replace(/^[\s,·•|-]+/, '') : text;
			const restOffset = text.length - rest.length;
			const amounts = amountsIn({ text, words: view.words }).filter((a) => a.start >= restOffset);
			// A figure the engine could not read anywhere below the status bar: the list cannot be trusted (a
			// poisoned day header would otherwise put the rows below it on the previous day).
			if (i > 0 && text.includes(UNREADABLE)) poisoned = true;
			const lowConfidence = view.words.some(needsNumericReview);

			// "Saldo Rp …" under a row: that row's running balance.
			if (SALDO.test(text) && amounts.length === 1) {
				if (open && open.balanceMinor === null && open.page === p) {
					open.balanceMinor = parseMoneyAmount(amounts[0]!.figure)?.minor ?? null;
					open.lowConfidence ||= lowConfidence;
				}
				return;
			}
			if (amounts.length === 0) {
				if (lead && rest === '') {
					// A day-group header.
					groupDate = lead;
					pendingTitle = null;
					pendingLead = null;
					open = null;
					started = true;
					return;
				}
				if (open && isRowDetail(text)) {
					const time = TIME.exec(text);
					if (time && !open.time) open.time = `${time[1]!.padStart(2, '0')}:${time[2]}`;
					if (NOT_COMPLETED.test(text)) open.notCompleted = true;
					if (lead && !open.date) open.date = lead;
					open.lowConfidence ||= lowConfidence;
					return;
				}
				if (header && !lead) return;
				pendingTitle = lead ? rest : text;
				pendingLead = lead;
				return;
			}
			started = true;
			const [mutation, second] = amounts as [AmountMatch, AmountMatch | undefined];
			// Two figures read as amount + running balance only when the second is unsigned and unmarked; anything
			// else (a figure planted in a remark next to the amount, three figures) leaves the row unreadable.
			const ambiguous =
				amounts.length > 2 ||
				(second !== undefined && (second.direction !== null || second.unsureDirection));
			const before = text.slice(restOffset, mutation.start).trim();
			// A description wrapped below its dated first line continues it; a lone title line above names the row.
			const titleSource =
				pendingLead && pendingTitle
					? `${pendingTitle} ${before}`.trim()
					: before !== ''
						? before
						: (pendingTitle ?? '');
			const time = TIME.exec(text);
			open = {
				page: p,
				date: lead ?? pendingLead,
				groupDate,
				amount: mutation,
				balanceMinor:
					second && !ambiguous ? (parseMoneyAmount(second.figure)?.minor ?? null) : null,
				title: cleanTitle(titleSource),
				time: time ? `${time[1]!.padStart(2, '0')}:${time[2]}` : null,
				notCompleted: NOT_COMPLETED.test(text) || NOT_COMPLETED.test(titleSource),
				lowConfidence,
				ambiguous
			};
			raw.push(open);
			pendingTitle = null;
			pendingLead = null;
		});
	});
	return { raw, poisoned, period, years };
}

/** The row's WIB date and why it needs review, or the reject reason. */
function resolveDate(
	printed: PrintedDate | null,
	ctx: ScreenContext,
	period: StatementPeriod | null,
	years: ReadonlySet<number>
):
	| { date: string; review: RowReview | null }
	| { date: null; reason: 'missing_date' | 'unparseable_date' } {
	if (!printed) return { date: null, reason: 'missing_date' };
	if (printed.kind === 'relative') {
		const date = parseRelativeIndonesianDate(printed.phrase, ctx.todayWib);
		return date ? { date, review: 'relative_date' } : { date: null, reason: 'unparseable_date' };
	}
	const iso = (y: number) =>
		`${y}-${String(printed.month).padStart(2, '0')}-${String(printed.day).padStart(2, '0')}`;
	let date: string | null;
	let review: RowReview | null = null;
	if (printed.year) date = iso(printed.year);
	else if (period) date = dateInPeriod(printed.day, printed.month, period);
	else if (years.size === 1) date = iso([...years][0]!);
	else {
		date = iso(Number(ctx.todayWib.slice(0, 4)));
		review = 'year_assumed';
	}
	if (!date || !isDateString(date) || date > ctx.todayWib)
		return { date: null, reason: 'unparseable_date' };
	return { date, review };
}

/** Rows whose amount disagrees with the printed balance difference to their neighbour: both reviewed. */
function balanceMismatches(
	rows: readonly { page: number; signed: number | null; balance: number | null }[]
): Set<number> {
	const flagged = new Set<number>();
	for (let i = 0; i + 1 < rows.length; i++) {
		const a = rows[i]!;
		const b = rows[i + 1]!;
		if (a.page !== b.page || a.balance === null || b.balance === null) continue;
		if (a.signed === null || b.signed === null) continue;
		// Newest first (a is after b) or oldest first (b is after a): either reading must hold.
		const newestFirst = a.balance === b.balance + a.signed;
		const oldestFirst = b.balance === a.balance + b.signed;
		if (!newestFirst && !oldestFirst) {
			flagged.add(i);
			flagged.add(i + 1);
		}
	}
	return flagged;
}

/** Most important review reason first: a row shows one. */
const REVIEW_ORDER: readonly RowReview[] = [
	'direction_unknown',
	'balance_mismatch',
	'low_confidence',
	'photo_unclear',
	'year_assumed',
	'relative_date',
	'overlap',
	'no_balance_check'
];

export const firstReview = (reasons: ReadonlySet<RowReview>): RowReview | undefined =>
	REVIEW_ORDER.find((r) => reasons.has(r));

/** Reads a screenshot list (low-confidence figures already poisoned) into rows. */
export function parseScreenList(doc: OcrDocument, ctx: ScreenContext): ScreenParse {
	const { raw, poisoned, period, years } = segment(doc);
	const unclear = new Set(doc.pages.flatMap((p, i) => (pageUnclear(p) ? [i] : [])));
	const completed = raw.filter((r) => !r.notCompleted);
	const signed = completed.map((r) => {
		const minor = parseMoneyAmount(r.amount.figure)?.minor ?? null;
		return {
			page: r.page,
			balance: r.balanceMinor,
			signed:
				minor === null || !r.amount.direction
					? null
					: r.amount.direction === 'debit'
						? -minor
						: minor
		};
	});
	const mismatched = balanceMismatches(signed);
	const seen = new Map<string, number>();
	const rows = completed.map((r, index): ScreenRow => {
		const reasons = new Set<RowReview>();
		const resolved = resolveDate(r.date ?? r.groupDate, ctx, period, years);
		const direction = r.amount.direction ?? 'debit';
		if (!r.amount.direction) reasons.add('direction_unknown');
		if (resolved.date !== null && resolved.review) reasons.add(resolved.review);
		const printed = r.date ?? r.groupDate;
		if (r.lowConfidence || (printed && printed.conf < OCR_REVIEW_NUMERIC_CONF))
			reasons.add('low_confidence');
		if (mismatched.has(index)) reasons.add('balance_mismatch');
		if (unclear.has(r.page)) reasons.add('photo_unclear');
		const row: MappedRow = r.ambiguous
			? { index, ok: false, reason: 'unparseable_amount' }
			: resolved.date === null
				? { index, ok: false, reason: resolved.reason }
				: statementRow(index, {
						date: resolved.date,
						direction,
						amount: r.amount.figure,
						description: r.title
					});
		const keyPart = r.balanceMinor !== null ? `b${r.balanceMinor}` : r.time ? `t${r.time}` : '';
		// The same row on an earlier image (scroll overlap): flagged, never merged.
		if (row.ok) {
			const id = `${row.value.date}|${direction}|${row.value.amountMinor}|${keyPart}|${r.title.toLowerCase()}`;
			const firstPage = seen.get(id);
			if (firstPage !== undefined && firstPage !== r.page) reasons.add('overlap');
			else if (firstPage === undefined) seen.set(id, r.page);
		}
		const review = firstReview(reasons);
		return {
			row: row.ok && review ? { ...row, review } : row,
			page: r.page,
			keyPart,
			title: r.title
		};
	});
	return { rows, notCompleted: raw.length - completed.length, inconsistent: poisoned };
}

/** Which of `parsers` claim the document by the words in its pages' header lines. */
export function screenClaims(doc: OcrDocument, parsers: readonly ScreenParser[]): ScreenParser[] {
	const header = doc.pages
		.map((p) =>
			p.lines
				.slice(0, HEADER_LINES)
				.map((l) => l.words.map((w) => w.t).join(' '))
				.join('\n')
		)
		.join('\n');
	return parsers.filter((p) => p.claims(header));
}
