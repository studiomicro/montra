import {
	addDays,
	daysBetween,
	monthOf,
	monthRange,
	monthsBetween,
	shiftMonth
} from '#lib/shared/dates';
import { msg } from '#lib/shared/i18n';
import { periodRange, type LaporanView } from '#lib/shared/laporan-query';
import {
	amountIn,
	categorySlices,
	cumulative,
	sumExact,
	type CategorySlice
} from '../budgets/math';
import type { Db } from '../db';
import {
	categoryMonthlyTotals,
	categoryTotals,
	dailyTotals,
	largestTransactions,
	merchantTotals,
	monthlyTotals,
	periodTotals,
	safeMinor,
	type CategoryMonthTotals,
	type DayTotals,
	type MerchantTotal,
	type MonthTotals,
	type PeriodTotals,
	type TransactionFilter,
	type TransactionListRow
} from '../transactions/aggregate';
import { listWallets } from '../wallets/repo';

// Laporan (FN-09, layout parity wave B): every figure comes from the FN-05 aggregates (the same functions and
// filters Riwayat and Beranda use), so a Laporan total equals the Riwayat total for the same period. A figure
// is null when its exact value is past Number.MAX_SAFE_INTEGER ("Total terlalu besar untuk ditampilkan"):
// never rounded, and anything computed from it is null too. Nothing here sums money across currencies:
// the breakdowns are in one currency (the favourite wallet's) and other currencies are only named.

export const LAPORAN_LOAD_FAILED = msg('Laporan tidak bisa dimuat. Coba lagi sebentar lagi.');

/** Places in "Tempat teratas" and rows in "Pengeluaran terbesar". */
export const LAPORAN_TOP = 5;
/** Categories with their own colour in the yearly stacked bars; the rest is one "Lainnya" segment. */
export const STACK_CATEGORIES = 4;
/** Rows of "Kategori dari waktu ke waktu"; the rest is one "Lainnya" row. */
export const GRID_CATEGORIES = 8;
/** Key of the "Lainnya" (everything else) segment and row; '' is "Tanpa kategori". */
export const OTHER_KEY = '*';

/** Money in, out and the difference (in − out) in one currency for the whole period. */
export interface LaporanStat {
	currency: string;
	inMinor: number | null;
	outMinor: number | null;
	netMinor: number | null;
}

export interface LaporanCategory extends CategorySlice {
	/** floor(minor × 100 / the direction's total): never rounded up. Null when a figure is too large. */
	percent: number | null;
	/** floor(minor / elapsed days) in a month view, floor(minor / elapsed months) in a year view. */
	perUnitMinor: number | null;
}

/** One cell of the monthly heatmap calendar. */
export interface HeatDay {
	date: string;
	minor: number | null;
	/** 0 (nothing or in the future) to 4 (the period's largest day); a too-large day is 4. */
	level: 0 | 1 | 2 | 3 | 4;
	future: boolean;
}

/** Running totals of the period against the one before, aligned by day of month (or month of year). */
export interface CumulativeLines {
	/** Through today (or the whole period when it is over). */
	current: (number | null)[];
	/** The whole axis: `days` (month view) or 12 (year view) values. */
	previous: (number | null)[];
	/** current.at(-1) − previous at the same point; null when either is too large. */
	diffMinor: number | null;
}

export interface StackMonth {
	month: string;
	/** Top STACK_CATEGORIES category keys, then OTHER_KEY; each segment's money in the direction. */
	segments: { key: string; minor: number | null }[];
	total: number | null;
}

export interface GridRow {
	key: string;
	tileKey: CategorySlice['tileKey'];
	name: string | null;
	isPreset: boolean;
	cells: { minor: number | null; level: HeatDay['level'] }[];
	total: number | null;
}

export type LaporanDetail =
	| {
			mode: 'bulan';
			month: string;
			previousMonth: string;
			/** Days of the month so far (through today), or all of them for a past month. */
			elapsed: number;
			heatmap: HeatDay[];
			lines: CumulativeLines;
	  }
	| {
			mode: 'tahun';
			year: string;
			previousYear: string;
			/** Months of the year so far (through today's month), or 12 for a past year. */
			months: string[];
			stack: StackMonth[];
			/** The stacked categories in segment order (OTHER_KEY last). */
			stackKeys: Pick<CategorySlice, 'key' | 'tileKey' | 'name' | 'isPreset'>[];
			/** floor(year total / months so far); null when too large. */
			averageMinor: number | null;
			lines: CumulativeLines;
			grid: GridRow[];
	  };

export interface LaporanReport {
	view: LaporanView;
	/** Inclusive WIB dates of the period. */
	from: string;
	to: string;
	/** The breakdowns' currency: the favourite wallet's, IDR without wallets (Beranda's rule). */
	currency: string;
	/** `currency` first (zeros when it has no rows), then every other currency with money in or out. */
	stats: LaporanStat[];
	/** The direction's total in `currency`: what the category list and donut add up to. */
	directionMinor: number | null;
	categories: LaporanCategory[];
	/** Top places of the direction in `currency` (a top list, not exhaustive); month view only. */
	merchants: MerchantTotal[];
	/** Largest single rows of the direction in `currency`; month view only. */
	largest: TransactionListRow[];
	detail: LaporanDetail;
	/** Other currencies with money in the direction: left out of the breakdowns, never added in. */
	otherCurrencies: string[];
}

const filter = (from: string, to: string, type: TransactionFilter['type']): TransactionFilter => ({
	from,
	to,
	type,
	categoryId: null,
	walletId: null,
	q: null
});

/** Per-currency in, out and net; `currency` always present and first. */
export function laporanStats(totals: PeriodTotals, currency: string): LaporanStat[] {
	const rows = totals.totals.some((t) => t.currency === currency)
		? totals.totals
		: [{ currency, inMinor: 0, outMinor: 0 }, ...totals.totals];
	return [...rows]
		.sort((a, b) => (a.currency === currency ? -1 : b.currency === currency ? 1 : 0))
		.map((t) => ({
			currency: t.currency,
			inMinor: t.inMinor,
			outMinor: t.outMinor,
			netMinor:
				t.inMinor === null || t.outMinor === null
					? null
					: safeMinor(BigInt(t.inMinor) - BigInt(t.outMinor))
		}));
}

/** floor(part × 100 / whole), exact in BigInt; null when either is too large or the whole is 0. */
export function floorPercent(part: number | null, whole: number | null): number | null {
	if (part === null || whole === null || whole === 0) return null;
	return Number((BigInt(part) * 100n) / BigInt(whole));
}

/** floor(minor / count), exact in BigInt; null when the figure is too large. */
export function floorPer(minor: number | null, count: number): number | null {
	if (minor === null) return null;
	return Number(BigInt(minor) / BigInt(Math.max(1, count)));
}

const daysIn = (month: string) => {
	const { from, to } = monthRange(month);
	return daysBetween(from, to) + 1;
};

/**
 * The shade of one cell: 0 for nothing, else 1–4 by its share of the largest value (ceil of a quarter), so
 * only the largest values reach 4. A too-large value (null) is the largest there is: 4, and beside it (max
 * null) every other non-zero value is the lightest step. Display only.
 */
export function heatLevel(minor: number | null, max: number | null): HeatDay['level'] {
	if (minor === null) return 4;
	if (minor <= 0) return 0;
	if (max === null) return 1;
	if (max <= 0) return 0;
	return Math.min(4, Math.max(1, Math.ceil((minor / max) * 4))) as HeatDay['level'];
}

/** The largest value; null as soon as one is too large. */
function maxOf(values: readonly (number | null)[]): number | null {
	let max = 0;
	for (const v of values) {
		if (v === null) return null;
		if (v > max) max = v;
	}
	return max;
}

/** Running totals; from the first value that is too large on, every entry is null. */
export function runningTotals(values: readonly (number | null)[]): (number | null)[] {
	let sum: bigint | null = 0n;
	return values.map((v) => {
		sum = sum === null || v === null ? null : sum + BigInt(v);
		return sum === null ? null : safeMinor(sum);
	});
}

function diffAt(current: (number | null)[], previous: (number | null)[]): number | null {
	if (current.length === 0) return 0;
	const a = current.at(-1);
	const b = previous[current.length - 1];
	return a === null || a === undefined || b === null || b === undefined
		? null
		: safeMinor(BigInt(a) - BigInt(b));
}

/**
 * The month against the month before it as running totals by day of month, both on an axis of the month's
 * days. This month runs `elapsed` days (through today, or all of a past month); the month before covers the
 * whole axis, cut at its own length when longer and carrying its last total when shorter.
 */
export function monthLines(
	daily: readonly DayTotals[],
	month: string,
	elapsed: number,
	currency: string,
	key: 'inMinor' | 'outMinor'
): CumulativeLines {
	const days = daysIn(month);
	const previousMonth = shiftMonth(month, -1);
	const byDate = new Map(daily.map((d) => [d.date, amountIn(d.totals, currency, key)]));
	const current = cumulative(byDate, `${month}-01`, elapsed);
	const last = cumulative(byDate, `${previousMonth}-01`, Math.min(days, daysIn(previousMonth)));
	const carried = last.at(-1) ?? 0;
	const previous = [...last, ...Array.from({ length: days - last.length }, () => carried)];
	return { current, previous, diffMinor: diffAt(current, previous) };
}

/** Every day of `month` with its money in the direction and shade; days after `today` are future (blank). */
export function heatmapDays(
	daily: readonly DayTotals[],
	month: string,
	today: string,
	currency: string,
	key: 'inMinor' | 'outMinor'
): HeatDay[] {
	const byDate = new Map(daily.map((d) => [d.date, amountIn(d.totals, currency, key)]));
	const dates = Array.from({ length: daysIn(month) }, (_, i) => addDays(`${month}-01`, i));
	const minors = dates.map((date) => {
		const v = byDate.get(date);
		return v === undefined ? 0 : v;
	});
	const max = maxOf(minors);
	return dates.map((date, i) => {
		const minor = minors[i] as number | null;
		const future = date > today;
		return { date, minor, future, level: future ? 0 : heatLevel(minor, max) };
	});
}

/** One value per month of `months` from `monthly`: 0 for a month without rows, null when too large. */
function perMonth(
	monthly: readonly MonthTotals[],
	months: readonly string[],
	currency: string,
	key: 'inMinor' | 'outMinor'
): (number | null)[] {
	const byMonth = new Map(monthly.map((m) => [m.month, amountIn(m.totals, currency, key)]));
	return months.map((m) => {
		const v = byMonth.get(m);
		return v === undefined ? 0 : v;
	});
}

/** The year so far against the whole year before, as running totals by month. */
export function yearLines(
	thisYear: readonly MonthTotals[],
	lastYear: readonly MonthTotals[],
	months: readonly string[],
	previousYear: string,
	currency: string,
	key: 'inMinor' | 'outMinor'
): CumulativeLines {
	const previousMonths = monthsBetween(`${previousYear}-01`, `${previousYear}-12`);
	const current = runningTotals(perMonth(thisYear, months, currency, key));
	const previous = runningTotals(perMonth(lastYear, previousMonths, currency, key));
	return { current, previous, diffMinor: diffAt(current, previous) };
}

/** `categoryMonthlyTotals` as month → category key → money in the direction in `currency`. */
function byMonthAndCategory(
	rows: readonly CategoryMonthTotals[],
	currency: string,
	key: 'inMinor' | 'outMinor'
): Map<string, Map<string, number | null>> {
	const map = new Map<string, Map<string, number | null>>();
	for (const r of rows) {
		const inner = map.get(r.month) ?? new Map<string, number | null>();
		inner.set(r.category?.id ?? '', amountIn(r.totals, currency, key));
		map.set(r.month, inner);
	}
	return map;
}

/** The value of `keys` (exact sum) in one month's category map; `rest` sums every key not in `keys`. */
function pick(
	month: Map<string, number | null> | undefined,
	keys: ReadonlySet<string>,
	rest: boolean
): number | null {
	if (!month) return 0;
	return sumExact([...month].filter(([k]) => keys.has(k) !== rest).map(([, v]) => v));
}

/**
 * Yearly stacked bars: per month, one segment per top category (the first STACK_CATEGORIES of `slices`, which
 * are sorted largest first) and one OTHER_KEY segment for the rest. The segments of a month add up to its
 * total exactly; the average is floor(sum of totals / months).
 */
export function yearStack(
	rows: readonly CategoryMonthTotals[],
	slices: readonly CategorySlice[],
	months: readonly string[],
	currency: string,
	key: 'inMinor' | 'outMinor'
): { stack: StackMonth[]; stackKeys: string[]; averageMinor: number | null } {
	const map = byMonthAndCategory(rows, currency, key);
	const top = slices.slice(0, STACK_CATEGORIES).map((s) => s.key);
	const hasRest = slices.length > STACK_CATEGORIES;
	const stackKeys = hasRest ? [...top, OTHER_KEY] : top;
	const topSet = new Set(top);
	const stack = months.map((month) => {
		const m = map.get(month);
		const segments = top.map((k) => ({ key: k, minor: pick(m, new Set([k]), false) }));
		if (hasRest) segments.push({ key: OTHER_KEY, minor: pick(m, topSet, true) });
		return { month, segments, total: sumExact(segments.map((s) => s.minor)) };
	});
	const yearTotal = sumExact(stack.map((s) => s.total));
	return { stack, stackKeys, averageMinor: floorPer(yearTotal, months.length) };
}

/**
 * "Kategori dari waktu ke waktu": the first GRID_CATEGORIES of `slices` as rows, the rest as one OTHER_KEY
 * row; a cell per month shaded against the largest cell of the whole table; the row total at the end.
 */
export function categoryGrid(
	rows: readonly CategoryMonthTotals[],
	slices: readonly CategorySlice[],
	months: readonly string[],
	currency: string,
	key: 'inMinor' | 'outMinor'
): GridRow[] {
	const map = byMonthAndCategory(rows, currency, key);
	const shown = slices.slice(0, GRID_CATEGORIES);
	const shownSet = new Set(shown.map((s) => s.key));
	const lines = shown.map((s) => ({
		key: s.key,
		tileKey: s.tileKey,
		name: s.name,
		isPreset: s.isPreset,
		values: months.map((month) => pick(map.get(month), new Set([s.key]), false))
	}));
	if (slices.length > GRID_CATEGORIES)
		lines.push({
			key: OTHER_KEY,
			tileKey: 'lain',
			name: null,
			isPreset: false,
			values: months.map((month) => pick(map.get(month), shownSet, true))
		});
	const max = maxOf(lines.flatMap((l) => l.values));
	return lines.map(({ values, ...row }) => ({
		...row,
		cells: values.map((minor) => ({ minor, level: heatLevel(minor, max) })),
		total: sumExact(values)
	}));
}

/** Everything Laporan shows for `spaceId` (already admitted by the access gate) on the WIB date `today`. */
export async function laporanReport(
	db: Db,
	spaceId: string,
	today: string,
	view: LaporanView
): Promise<LaporanReport> {
	const { from, to } = periodRange(view, today);
	const type = view.direction === 'masuk' ? 'income' : 'expense';
	const key = view.direction === 'masuk' ? 'inMinor' : 'outMinor';
	const wallets = await listWallets(db, spaceId);
	const currency = wallets.find((w) => w.isFavourite)?.currency ?? 'IDR';

	// "Tempat teratas" and "Pengeluaran terbesar" belong to the month view only (APP_PARITY § 3).
	const monthView = view.mode === 'bulan';
	const [totals, categories, merchants, largest] = await Promise.all([
		periodTotals(db, spaceId, filter(from, to, null)),
		categoryTotals(db, spaceId, filter(from, to, type)),
		monthView
			? merchantTotals(db, spaceId, filter(from, to, type), currency, LAPORAN_TOP)
			: Promise.resolve([]),
		monthView
			? largestTransactions(db, spaceId, filter(from, to, type), currency, LAPORAN_TOP)
			: Promise.resolve([])
	]);
	const slices = categorySlices(categories, currency, key);

	let detail: LaporanDetail;
	let units: number;
	if (view.mode === 'bulan') {
		const month = view.month;
		const previousMonth = shiftMonth(month, -1);
		const elapsed = monthOf(today) === month ? daysBetween(from, today) + 1 : daysIn(month);
		const daily = await dailyTotals(db, spaceId, filter(`${previousMonth}-01`, to, type));
		units = elapsed;
		detail = {
			mode: 'bulan',
			month,
			previousMonth,
			elapsed,
			heatmap: heatmapDays(daily, month, today, currency, key),
			lines: monthLines(daily, month, elapsed, currency, key)
		};
	} else {
		const year = view.year;
		const previousYear = String(Number(year) - 1);
		const months = monthsBetween(`${year}-01`, monthOf(to));
		const [byCategory, thisYear, lastYear] = await Promise.all([
			categoryMonthlyTotals(db, spaceId, filter(from, to, type)),
			monthlyTotals(db, spaceId, filter(from, to, type)),
			monthlyTotals(db, spaceId, filter(`${previousYear}-01-01`, `${previousYear}-12-31`, type))
		]);
		const { stack, stackKeys, averageMinor } = yearStack(byCategory, slices, months, currency, key);
		const keyed = new Map(slices.map((s) => [s.key, s]));
		units = months.length;
		detail = {
			mode: 'tahun',
			year,
			previousYear,
			months,
			stack,
			stackKeys: stackKeys.map((k) => {
				const s = keyed.get(k);
				return s
					? { key: s.key, tileKey: s.tileKey, name: s.name, isPreset: s.isPreset }
					: { key: OTHER_KEY, tileKey: 'lain', name: null, isPreset: false };
			}),
			averageMinor,
			lines: yearLines(thisYear, lastYear, months, previousYear, currency, key),
			grid: categoryGrid(byCategory, slices, months, currency, key)
		};
	}

	const directionMinor = amountIn(totals.totals, currency, key);
	return {
		view,
		from,
		to,
		currency,
		stats: laporanStats(totals, currency),
		directionMinor,
		categories: slices.map((c) => ({
			...c,
			percent: floorPercent(c.minor, directionMinor),
			perUnitMinor: floorPer(c.minor, units)
		})),
		merchants,
		largest,
		detail,
		otherCurrencies: totals.totals
			.filter((t) => t.currency !== currency && t[key] !== 0)
			.map((t) => t.currency)
	};
}
