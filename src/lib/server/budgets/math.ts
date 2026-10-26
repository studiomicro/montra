import { addDays, daysBetween, monthOf, monthRange, shiftMonth } from '#lib/shared/dates';
import type { TileKey } from '#lib/shared/transactions';
import {
	safeMinor,
	type CategoryTotals,
	type CurrencyTotals,
	type DayTotals,
	type PeriodTotals
} from '../transactions/aggregate';
import type { Budget } from './repo';

// Beranda's figures (FN-07/FN-08) from the FN-05 aggregates. Pure: every date is a WIB `YYYY-MM-DD` the caller
// passes in, so the month-boundary vectors are plain inputs. A figure is `null` when its exact value is past
// Number.MAX_SAFE_INTEGER (the aggregates' "too large to show" state): it is never rounded, and anything
// computed from it is null too. Sums are taken in BigInt and only then narrowed.

/** Days in the bar chart, today included. */
const BAR_DAYS = 14;

/** The WIB day of the month of `date` (1–31). */
export const dayOfMonth = (date: string): number => Number(date.slice(8, 10));

/** Days in the month `YYYY-MM`. */
export function daysInMonth(month: string): number {
	const { from, to } = monthRange(month);
	return daysBetween(from, to) + 1;
}

/** WIB days left in `date`'s month, `date` itself included (1 on the last day). */
export function daysRemainingInclusive(date: string): number {
	return daysBetween(date, monthRange(monthOf(date)).to) + 1;
}

export type SafeToSpend =
	| { kind: 'left'; remainingMinor: number; perDayMinor: number; days: number }
	| { kind: 'spent' }
	/** `overMinor` null: spending is too large to show (and so far past any budget). */
	| { kind: 'over'; overMinor: number | null };

/**
 * What is left of `budgetMinor` after `spentMinor` this month, split over the remaining WIB days (today
 * included), rounded down so the daily figure never overstates what is left (owner decision F). Exactly
 * spent → `spent`; past the budget → `over` by how much (a negative daily figure is never produced).
 * Spending too large to show (null) is past every budget (budgets stay far below 2^53).
 */
export function safeToSpend(
	budgetMinor: number,
	spentMinor: number | null,
	today: string
): SafeToSpend {
	if (spentMinor === null) return { kind: 'over', overMinor: null };
	const remaining = BigInt(budgetMinor) - BigInt(spentMinor);
	if (remaining < 0n) return { kind: 'over', overMinor: safeMinor(-remaining) };
	if (remaining === 0n) return { kind: 'spent' };
	const remainingMinor = Number(remaining); // 0 < remaining <= budgetMinor: safe
	const days = daysRemainingInclusive(today);
	return { kind: 'left', remainingMinor, perDayMinor: Math.floor(remainingMinor / days), days };
}

/**
 * The comparison periods (owner decision C): this month from the 1st through today, against last month from
 * the 1st through the same day of the month, cut at last month's length (the 31st compares with all of a
 * 30-day month; 29–31 March compare with all of February).
 */
export function comparisonWindows(today: string): {
	thisMonth: { from: string; to: string };
	lastMonth: { from: string; to: string };
} {
	const month = monthOf(today);
	const last = shiftMonth(month, -1);
	const lastFrom = `${last}-01`;
	const sameDays = Math.min(dayOfMonth(today), daysInMonth(last));
	return {
		thisMonth: { from: `${month}-01`, to: today },
		lastMonth: { from: lastFrom, to: addDays(lastFrom, sameDays - 1) }
	};
}

/** The BAR_DAYS WIB dates ending today, oldest first. */
export function lastDays(today: string, count = BAR_DAYS): string[] {
	return Array.from({ length: count }, (_, i) => addDays(today, i - count + 1));
}

/** Money in or out (`key`) in `currency`: 0 when that currency has none, null when too large to show. */
export function amountIn(
	totals: readonly CurrencyTotals[],
	currency: string,
	key: 'inMinor' | 'outMinor'
): number | null {
	const t = totals.find((x) => x.currency === currency);
	return t ? t[key] : 0;
}

/** Money out in `currency`: 0 when that currency has none, null when too large to show. */
export function outIn(totals: readonly CurrencyTotals[], currency: string): number | null {
	return amountIn(totals, currency, 'outMinor');
}

/** Exact sum of `values`; null when any is null or the sum is past the safe range. */
export function sumExact(values: Iterable<number | null>): number | null {
	let sum = 0n;
	for (const v of values) {
		if (v === null) return null;
		sum += BigInt(v);
	}
	return safeMinor(sum);
}

/** A day's money out: 0 for a day without rows, null (kept, never `?? 0`) when too large to show. */
function dayOut(byDate: Map<string, number | null>, date: string): number | null {
	const v = byDate.get(date);
	return v === undefined ? 0 : v;
}

function datesFrom(from: string, days: number): string[] {
	return Array.from({ length: days }, (_, i) => addDays(from, i));
}

function sumOver(byDate: Map<string, number | null>, from: string, to: string): number | null {
	return sumExact(datesFrom(from, daysBetween(from, to) + 1).map((d) => dayOut(byDate, d)));
}

/** Running totals by day; from the first value that is too large on, every entry is null. */
export function cumulative(
	byDate: Map<string, number | null>,
	from: string,
	days: number
): (number | null)[] {
	let sum: bigint | null = 0n;
	return datesFrom(from, days).map((d) => {
		const v = dayOut(byDate, d);
		sum = sum === null || v === null ? null : sum + BigInt(v);
		return sum === null ? null : safeMinor(sum);
	});
}

export interface CategorySlice {
	/** Category id; '' for rows without a category. */
	key: string;
	tileKey: TileKey;
	name: string | null;
	isPreset: boolean;
	minor: number | null;
}

/**
 * `categoryTotals` as chart slices of money in or out (`key`) in `currency`: categories without money in that
 * currency are left out; too large first (it is the largest), then by amount, then by id for a stable order.
 */
export function categorySlices(
	categories: readonly CategoryTotals[],
	currency: string,
	key: 'inMinor' | 'outMinor'
): CategorySlice[] {
	return categories
		.map((c) => ({
			key: c.category?.id ?? '',
			tileKey: c.category?.tileKey ?? 'lain',
			name: c.category?.name ?? null,
			isPreset: c.category?.isPreset ?? false,
			minor: amountIn(c.totals, currency, key)
		}))
		.filter((c) => c.minor !== 0)
		.sort((a, b) =>
			a.minor === b.minor
				? a.key < b.key
					? -1
					: 1
				: a.minor === null
					? -1
					: b.minor === null
						? 1
						: b.minor - a.minor
		);
}

export interface BerandaFigures {
	today: string;
	/** `YYYY-MM` of this and last WIB month. */
	month: string;
	lastMonth: string;
	dayOfMonth: number;
	/** The hero's currency: the favourite wallet's, IDR without wallets. */
	currency: string;
	/** This WIB month's spending in `currency` (= Riwayat's month total for type expense). */
	spentMinor: number | null;
	/** This month's spending in other currencies, shown beside the hero, never added to it. */
	otherCurrencies: { currency: string; outMinor: number | null }[];
	/** Month-to-date minus last month's same days, and the month-to-date average per day (floor). */
	diffMinor: number | null;
	avgPerDayMinor: number | null;
	budget: Budget | null;
	/** From the budget and this month's spending in the budget's currency; null without a budget. */
	safeToSpend: SafeToSpend | null;
	bars: { date: string; minor: number | null }[];
	categories: CategorySlice[];
	/** Cumulative spending by day of month, both the same length (aligned by day). */
	lines: { thisMonth: (number | null)[]; lastMonth: (number | null)[] };
}

/**
 * Beranda's figures. `monthTotals` is `periodTotals` over this whole WIB month (type expense); `daily` is
 * `dailyTotals` from the first of last month to the end of this month; `categories` is `categoryTotals` over
 * this month. Only `currency` is summed; other currencies are listed separately.
 */
export function berandaFigures(input: {
	today: string;
	currency: string;
	budget: Budget | null;
	monthTotals: PeriodTotals;
	daily: DayTotals[];
	categories: CategoryTotals[];
}): BerandaFigures {
	const { today, currency, budget } = input;
	const month = monthOf(today);
	const lastMonth = shiftMonth(month, -1);
	const n = dayOfMonth(today);
	const byDate = new Map(input.daily.map((d) => [d.date, outIn(d.totals, currency)]));
	const windows = comparisonWindows(today);
	const toDate = sumOver(byDate, windows.thisMonth.from, windows.thisMonth.to);
	const lastSameDays = sumOver(byDate, windows.lastMonth.from, windows.lastMonth.to);
	const lineDays = daysBetween(windows.lastMonth.from, windows.lastMonth.to) + 1;
	return {
		today,
		month,
		lastMonth,
		dayOfMonth: n,
		currency,
		spentMinor: outIn(input.monthTotals.totals, currency),
		otherCurrencies: input.monthTotals.totals
			.filter((t) => t.currency !== currency && t.outMinor !== 0)
			.map((t) => ({ currency: t.currency, outMinor: t.outMinor })),
		diffMinor:
			toDate === null || lastSameDays === null
				? null
				: safeMinor(BigInt(toDate) - BigInt(lastSameDays)),
		avgPerDayMinor: toDate === null ? null : Math.floor(toDate / n),
		budget,
		safeToSpend: budget
			? safeToSpend(budget.amountMinor, outIn(input.monthTotals.totals, budget.currency), today)
			: null,
		bars: lastDays(today).map((date) => ({ date, minor: dayOut(byDate, date) })),
		categories: categorySlices(input.categories, currency, 'outMinor'),
		lines: {
			thisMonth: cumulative(byDate, windows.thisMonth.from, lineDays),
			lastMonth: cumulative(byDate, windows.lastMonth.from, lineDays)
		}
	};
}

/**
 * How far through `today`'s WIB month the period is, as a whole percent with today counted as spent (the 8th of
 * a 31-day month is 25 %): the pace marker on the Anggaran bars. Rounded down.
 */
export function pacePercent(today: string): number {
	return Math.floor((dayOfMonth(today) * 100) / daysInMonth(monthOf(today)));
}

/** `ok`: on or under pace; `ahead`: still within the budget but on course to pass it; `over`: past it. */
type PaceState = 'ok' | 'ahead' | 'over';

export interface BudgetProgress {
	budgetMinor: number;
	/** This month's spending in the budget's currency; null when too large to show. */
	spentMinor: number | null;
	/** Budget minus spending: negative once over; null when spending is too large to show. */
	remainingMinor: number | null;
	/** Whole percent of the budget spent, rounded down and not capped (bars clamp it); 100 when too large. */
	usedPercent: number;
	/** Spending at this month's daily rate through the month's last day (rounded down); null when too large. */
	projectedMinor: number | null;
	state: PaceState;
}

/**
 * A budget against this WIB month's spending on `today` (Anggaran page): what is left, how much is used, the
 * month-end projection at the month-to-date daily rate (today counted as a full day) and the pace state. Exact
 * BigInt arithmetic; nothing is rounded up.
 */
export function budgetProgress(
	budgetMinor: number,
	spentMinor: number | null,
	today: string
): BudgetProgress {
	if (spentMinor === null)
		return {
			budgetMinor,
			spentMinor,
			remainingMinor: null,
			usedPercent: 100,
			projectedMinor: null,
			state: 'over'
		};
	const spent = BigInt(spentMinor);
	const budget = BigInt(budgetMinor);
	const days = BigInt(daysInMonth(monthOf(today)));
	const projected = safeMinor((spent * days) / BigInt(dayOfMonth(today)));
	const usedPercent = budget > 0n ? Number((spent * 100n) / budget) : 100;
	const state: PaceState =
		spent > budget ? 'over' : projected === null || projected > budgetMinor ? 'ahead' : 'ok';
	return {
		budgetMinor,
		spentMinor,
		remainingMinor: safeMinor(budget - spent),
		usedPercent,
		projectedMinor: projected,
		state
	};
}
