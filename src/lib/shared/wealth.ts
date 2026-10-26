import { addDays, monthOf, monthRange, shiftMonth } from './dates.ts';
import { msg } from './i18n.ts';
import type { NetWorthClass, NetWorthKind } from './net-worth.ts';

/**
 * The Kekayaan page (FN-25b): the trend chart's ranges, the allocation bar's split and the "Belum dihitung"
 * suggestions. Pure and integer-only: money stays in minor units, percentages are whole numbers computed with
 * BigInt so they always add up to 100.
 */

// ---- Trend ranges ----

/** The chart's ranges, as the `rentang` query parameter carries them. */
export const TREND_RANGES = ['1m', '3m', '1y', 'all'] as const;
export type TrendRange = (typeof TREND_RANGES)[number];
const DEFAULT_TREND_RANGE: TrendRange = '1m';

export const TREND_RANGE_LABELS: Readonly<Record<TrendRange, string>> = {
	'1m': msg('1 bln'),
	'3m': msg('3 bln'),
	'1y': msg('1 thn'),
	all: msg('Semua')
};

const MONTHS_OF: Readonly<Record<Exclude<TrendRange, 'all'>, number>> = {
	'1m': 1,
	'3m': 3,
	'1y': 12
};

/** The range a `rentang` value asks for; anything else is the default. */
export function parseTrendRange(value: string | null): TrendRange {
	return (TREND_RANGES as readonly (string | null)[]).includes(value)
		? (value as TrendRange)
		: DEFAULT_TREND_RANGE;
}

/**
 * The first WIB date of `range` ending on `today` (inclusive), or null for `all` (from the oldest snapshot):
 * the day after the same day-of-month `n` months earlier (clamped to that month's last day), so 1 month on
 * 11 Oct starts on 12 Sep.
 */
export function trendRangeStart(range: TrendRange, today: string): string | null {
	if (range === 'all') return null;
	const month = shiftMonth(monthOf(today), -MONTHS_OF[range]);
	const sameDay = `${month}-${today.slice(8, 10)}`;
	const { to: lastDay } = monthRange(month);
	return addDays(sameDay <= lastDay ? sameDay : lastDay, 1);
}

// ---- Allocation bar ----

/** One bar segment: an asset class holding a positive amount, with its whole-percent share of all assets. */
interface AllocationSlice {
	cls: NetWorthClass;
	minor: number;
	pct: number;
}

export interface Allocation {
	/** Asset classes holding a positive amount, in class order; their minors add up to `assetsMinor`. */
	slices: AllocationSlice[];
	/** The positive-asset total (the bar's whole); null when too large to show. */
	assetsMinor: number | null;
	/** Classes never drawn in the bar: debts, a negative class (an overdrawn wallet) or one too large to show. */
	outside: { cls: NetWorthClass; minor: number | null }[];
}

/**
 * Splits the summary's classes (IDR minor units, debts negative) into the bar and the lines under it. Debts are
 * never a segment and never in the denominator (owner decision 1). Percentages use the largest remainder, so
 * they add up to exactly 100.
 */
export function allocationOf(
	classes: readonly { cls: NetWorthClass; minor: number | null }[]
): Allocation {
	const assets: { cls: NetWorthClass; minor: number }[] = [];
	const outside: Allocation['outside'] = [];
	for (const c of classes) {
		if (c.cls !== 'debt' && c.minor !== null && c.minor > 0)
			assets.push({ cls: c.cls, minor: c.minor });
		else if (c.minor !== 0) outside.push(c);
	}
	const total = assets.reduce((s, a) => s + BigInt(a.minor), 0n);
	if (total === 0n) return { slices: [], assetsMinor: null, outside };
	const shares = assets.map((a) => {
		const scaled = BigInt(a.minor) * 100n;
		return { ...a, pct: scaled / total, rest: scaled % total };
	});
	let left = 100n - shares.reduce((s, a) => s + a.pct, 0n);
	const order = shares
		.map((s, i) => ({ i, rest: s.rest }))
		.sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1));
	for (const { i } of order) {
		if (left <= 0n) break;
		(shares[i] as (typeof shares)[number]).pct += 1n;
		left -= 1n;
	}
	const max = BigInt(Number.MAX_SAFE_INTEGER);
	return {
		slices: shares.map((s) => ({ cls: s.cls, minor: s.minor, pct: Number(s.pct) })),
		assetsMinor: total <= max ? Number(total) : null,
		outside
	};
}

// ---- Grouped sections ----

/** The item kinds listed in the page's own Investasi and Kripto sections (the other kinds stay per kind). */
const SECTION_KINDS = {
	investment: ['investment_stock', 'investment_gold'],
	crypto: ['investment_crypto']
} as const satisfies Record<string, readonly NetWorthKind[]>;
export type WealthSection = keyof typeof SECTION_KINDS;

/** The section an item kind is listed in, or null for the per-kind "Aset dan utang" groups. */
export function sectionOfKind(kind: NetWorthKind): WealthSection | null {
	for (const section of ['investment', 'crypto'] as const)
		if ((SECTION_KINDS[section] as readonly NetWorthKind[]).includes(kind)) return section;
	return null;
}

// ---- "Belum dihitung" suggestions ----

export type WealthSuggestion = 'gold' | 'pension';

/** Words that mark an item as a pension fund (case-insensitive). A display heuristic only, never stored. */
const PENSION_KEYWORDS = ['bpjs', 'jht', 'dplk', 'pensiun', 'pension'] as const;

/**
 * The classes the space has not recorded yet, from a fixed list of two: gold (no gold item) and a pension fund
 * (no item named like one). Only real items count: a `Data demo` row never hides a suggestion. A missed name
 * only shows an extra card; it never hides data.
 */
export function missingSuggestions(
	items: readonly { kind: NetWorthKind; name: string; isDemo: boolean }[]
): WealthSuggestion[] {
	const real = items.filter((i) => !i.isDemo);
	const out: WealthSuggestion[] = [];
	if (!real.some((i) => i.kind === 'investment_gold')) out.push('gold');
	const named = (name: string) => {
		const lower = name.toLowerCase();
		return PENSION_KEYWORDS.some((k) => lower.includes(k));
	};
	if (!real.some((i) => named(i.name))) out.push('pension');
	return out;
}
