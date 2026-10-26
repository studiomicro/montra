import {
	addDays,
	daysBetween,
	formatMonthLabel,
	formatShortMonth,
	isMonthString,
	monthOf,
	monthRange,
	monthsBetween,
	shiftMonth
} from './dates.ts';
import type { Translator } from './i18n.ts';
import { LAPORAN_MIN_YEAR } from './laporan-query.ts';

/**
 * The period a report shows (FN-53): one WIB calendar month, quarter or year. Quarters are calendar quarters by
 * the WIB date: Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec. Shared by /alur-uang and /kekayaan/laporan; Laporan
 * keeps its own `LaporanView`. Pure, so the client and the Worker agree.
 */
export type ReportKind = 'bulan' | 'kuartal' | 'tahun';
type Quarter = 1 | 2 | 3 | 4;
export type ReportPeriod =
	| { kind: 'bulan'; month: string }
	| { kind: 'kuartal'; year: string; quarter: Quarter }
	| { kind: 'tahun'; year: string };

const YEAR = /^\d{4}$/;
const QUARTER = /^(\d{4})-Q([1-4])$/;

const quarterOf = (month: string): Quarter =>
	(Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1) as Quarter;
/** The first month `YYYY-MM` of a quarter. */
const quarterStart = (year: string, quarter: Quarter) =>
	`${year}-${String(quarter * 3 - 2).padStart(2, '0')}`;
const quarterEnd = (year: string, quarter: Quarter) =>
	`${year}-${String(quarter * 3).padStart(2, '0')}`;

/** This WIB period of `kind` on the WIB date `today`. */
function currentPeriod(kind: ReportKind, today: string): ReportPeriod {
	const month = monthOf(today);
	if (kind === 'bulan') return { kind, month };
	if (kind === 'kuartal') return { kind, year: today.slice(0, 4), quarter: quarterOf(month) };
	return { kind, year: today.slice(0, 4) };
}

/** A sortable key of the period's first month, to compare against the floor and the current period. */
const firstMonth = (p: ReportPeriod) =>
	p.kind === 'bulan'
		? p.month
		: p.kind === 'kuartal'
			? quarterStart(p.year, p.quarter)
			: `${p.year}-01`;

/** A future period becomes the current one; one before LAPORAN_MIN_YEAR the earliest of its kind. */
function clamp(p: ReportPeriod, today: string): ReportPeriod {
	const current = currentPeriod(p.kind, today);
	if (firstMonth(p) > firstMonth(current)) return current;
	if (Number(firstMonth(p).slice(0, 4)) < LAPORAN_MIN_YEAR) return floorPeriod(p.kind);
	return p;
}

function floorPeriod(kind: ReportKind): ReportPeriod {
	const year = String(LAPORAN_MIN_YEAR);
	if (kind === 'bulan') return { kind, month: `${year}-01` };
	if (kind === 'kuartal') return { kind, year, quarter: 1 };
	return { kind, year };
}

/**
 * The period a URL asks for: `?k=YYYY-Qn` (quarter), then `?y=YYYY` (year), then `?p=YYYY-MM` (month); an
 * unparsable value is skipped and the next one tried; none valid means the current period of `defaultKind`. A
 * future period clamps to the current one, one before 2000 to 2000. `?m=bulan|kuartal|tahun` (the switcher's form
 * field, no JavaScript needed) then converts the period into that kind. Never throws.
 */
export function parseReportPeriod(
	params: URLSearchParams,
	today: string,
	defaultKind: ReportKind
): ReportPeriod {
	const period = parsePeriod(params, today) ?? currentPeriod(defaultKind, today);
	const kind = params.get('m');
	return kind === 'bulan' || kind === 'kuartal' || kind === 'tahun'
		? switchReportKind(period, kind, today)
		: period;
}

function parsePeriod(params: URLSearchParams, today: string): ReportPeriod | null {
	const k = QUARTER.exec(params.get('k') ?? '');
	if (k)
		return clamp(
			{ kind: 'kuartal', year: k[1] as string, quarter: Number(k[2]) as Quarter },
			today
		);
	const y = params.get('y') ?? '';
	if (YEAR.test(y)) return clamp({ kind: 'tahun', year: y }, today);
	const p = params.get('p') ?? '';
	if (isMonthString(p)) return clamp({ kind: 'bulan', month: p }, today);
	return null;
}

/** `path?…` for `period`; the current period of `defaultKind` is the plain path. */
export function reportPeriodHref(
	path: string,
	period: ReportPeriod,
	today: string,
	defaultKind: ReportKind
): string {
	if (samePeriod(period, currentPeriod(defaultKind, today))) return path;
	if (period.kind === 'bulan') return `${path}?p=${period.month}`;
	if (period.kind === 'kuartal') return `${path}?k=${period.year}-Q${period.quarter}`;
	return `${path}?y=${period.year}`;
}

function samePeriod(a: ReportPeriod, b: ReportPeriod): boolean {
	return a.kind === b.kind && firstMonth(a) === firstMonth(b);
}

/** The period before or after `period` (same kind); null in the future or before the 2000 floor. */
export function stepReportPeriod(
	period: ReportPeriod,
	delta: -1 | 1,
	today: string
): ReportPeriod | null {
	const next = shifted(period, delta);
	if (firstMonth(next) > firstMonth(currentPeriod(period.kind, today))) return null;
	if (Number(firstMonth(next).slice(0, 4)) < LAPORAN_MIN_YEAR) return null;
	return next;
}

function shifted(period: ReportPeriod, delta: number): ReportPeriod {
	if (period.kind === 'bulan') return { kind: 'bulan', month: shiftMonth(period.month, delta) };
	if (period.kind === 'tahun') return { kind: 'tahun', year: String(Number(period.year) + delta) };
	const month = shiftMonth(quarterStart(period.year, period.quarter), delta * 3);
	return { kind: 'kuartal', year: month.slice(0, 4), quarter: quarterOf(month) };
}

/**
 * The same time in another kind (Laporan's `switchMode` rule): a month opens its quarter or year; a quarter its
 * last month so far or its year; a year its last quarter or month so far.
 */
export function switchReportKind(
	period: ReportPeriod,
	kind: ReportKind,
	today: string
): ReportPeriod {
	if (kind === period.kind) return period;
	const thisMonth = monthOf(today);
	const lastMonth =
		period.kind === 'bulan'
			? period.month
			: period.kind === 'kuartal'
				? quarterEnd(period.year, period.quarter)
				: `${period.year}-12`;
	const month = lastMonth > thisMonth ? thisMonth : lastMonth;
	if (kind === 'bulan') return { kind, month };
	if (kind === 'tahun') return { kind, year: month.slice(0, 4) };
	return { kind, year: month.slice(0, 4), quarter: quarterOf(month) };
}

export interface PeriodDates {
	/** First and last WIB date (inclusive) the report sums. */
	from: string;
	to: string;
	/** Every month `YYYY-MM` of the period so far, oldest first. */
	months: string[];
	/** `months.length`: the divisor of an average per month (the current month counts as one). */
	elapsedMonths: number;
	/** The period contains `today` (still running). */
	partial: boolean;
}

/**
 * The dates a period covers. A current quarter or year runs through `today` (Laporan's year rule, so a Tahun
 * total here equals Laporan's); a past one uses its full dates. A month is always the whole calendar month, even
 * the current one (FN-35's behaviour).
 */
export function periodDates(period: ReportPeriod, today: string): PeriodDates {
	const full = fullRange(period);
	const partial = full.from <= today && today <= full.to;
	if (period.kind === 'bulan')
		return { ...full, months: [period.month], elapsedMonths: 1, partial };
	const to = partial ? today : full.to;
	const months = monthsBetween(monthOf(full.from), monthOf(to));
	return { from: full.from, to, months, elapsedMonths: months.length, partial };
}

function fullRange(period: ReportPeriod): { from: string; to: string } {
	if (period.kind === 'bulan') return monthRange(period.month);
	if (period.kind === 'tahun') return { from: `${period.year}-01-01`, to: `${period.year}-12-31` };
	return {
		from: `${quarterStart(period.year, period.quarter)}-01`,
		to: monthRange(quarterEnd(period.year, period.quarter)).to
	};
}

/**
 * The previous period of the same kind, compared like with like: while `period` is still running (the current
 * month included, capped at today for this purpose only) the previous one is cut at the same day offset from its
 * start, clamped to its own end (`cut`); a complete period is compared with the whole previous one. Null at the
 * 2000 floor: the previous period would lie in 1999, outside every bounded query (red team L1).
 */
export function previousPeriodDates(
	period: ReportPeriod,
	today: string
): { period: ReportPeriod; from: string; to: string; cut: boolean } | null {
	const previous = shifted(period, -1);
	if (Number(firstMonth(previous).slice(0, 4)) < LAPORAN_MIN_YEAR) return null;
	const full = fullRange(period);
	const range = fullRange(previous);
	if (!(full.from <= today && today <= full.to)) return { period: previous, ...range, cut: false };
	const cutAt = addDays(range.from, daysBetween(full.from, today));
	const to = cutAt < range.to ? cutAt : range.to;
	return { period: previous, from: range.from, to, cut: to !== range.to };
}

/** The stepper's label, the same in both languages: `Okt '26` (`Oct '26`), `Q3 '26`, `2026`. */
export function periodStepLabel(period: ReportPeriod, locale: Translator['locale']): string {
	if (period.kind === 'bulan')
		return `${formatShortMonth(period.month, locale)} '${period.month.slice(2, 4)}`;
	if (period.kind === 'kuartal') return `Q${period.quarter} '${period.year.slice(2)}`;
	return period.year;
}

/** The page subtitle: "Oktober 2026", "Kuartal 3 · Jul–Sep 2026", "Tahun 2026". */
export function periodTitle(period: ReportPeriod, t: Translator): string {
	if (period.kind === 'bulan') return formatMonthLabel(period.month, t.locale);
	if (period.kind === 'tahun') return t.trf('Tahun {tahun}', { tahun: period.year });
	const first = formatShortMonth(quarterStart(period.year, period.quarter), t.locale);
	const last = formatShortMonth(quarterEnd(period.year, period.quarter), t.locale);
	return t.trf('Kuartal {n} · {bulan}', {
		n: period.quarter,
		bulan: `${first}–${last} ${period.year}`
	});
}

/** The period inside a sentence ("… dari {periode}"): "September 2026", "Q2 2026", "2025". */
export function periodName(period: ReportPeriod, locale: Translator['locale']): string {
	if (period.kind === 'bulan') return formatMonthLabel(period.month, locale);
	if (period.kind === 'kuartal') return `Q${period.quarter} ${period.year}`;
	return period.year;
}
