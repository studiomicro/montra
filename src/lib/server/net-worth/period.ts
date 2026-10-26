import { sql } from 'drizzle-orm';
import { addDays, daysBetween, monthOf } from '#lib/shared/dates';
import { msg } from '#lib/shared/i18n';
import { NET_WORTH_CLASSES, type NetWorthClass } from '#lib/shared/net-worth';
import { periodDates, type ReportPeriod } from '#lib/shared/report-period';
import type { Db } from '../db';
import { safeMinor } from '../transactions/aggregate';
import type { PriceBook } from './prices';
import { netWorthSummary, summaryIsPartial } from './summary';

// Laporan kekayaan (FN-53): the net worth at the start and end of a month, quarter or year, its monthly points and
// the change per group, from the stored daily snapshots only (FN-25), plus the live total for a period that is
// still running (the same figure as the Kekayaan hero). Nothing is interpolated or carried past a snapshot's own
// date; a missing value is a stated gap, never a zero.

export const NW_REPORT_LOAD_FAILED = msg(
	'Laporan kekayaan tidak bisa dimuat. Coba lagi sebentar lagi.'
);

/** Most snapshot rows one period reads (a year is at most 366). */
const PERIOD_MAX_SNAPSHOTS = 400;
/** The opening value may come from a complete snapshot at most this many days before the period's first day. */
const OPENING_CARRY_DAYS = 7;

/** One stored snapshot as the report reads it. */
export interface PeriodSnapshot {
	date: string;
	totalMinor: number;
	partial: boolean;
	/** The stored `classes` JSON text (null before migration 0046 or when a class was too large). */
	classes: string | null;
}

/** The live net worth now (`/kekayaan`'s hero), for a period that contains today. */
export interface LiveNetWorth {
	totalMinor: number | null;
	classes: { cls: NetWorthClass; minor: number | null }[];
	/** A price or rate was missing: shown with the same note as the hero, still the closing value. */
	partial: boolean;
	/** The daily rates the total used, with their dates (the foreign-rate caption). */
	rates: { currency: string; rate: string; date: string }[];
	/** The space holds `Data demo` items: listed on Kekayaan, never in this total (the page says so). */
	hasDemo: boolean;
}

/**
 * `exact`: the complete snapshot of the day before the period; `earlier`: an older one, at most
 * OPENING_CARRY_DAYS before it (its date shown); `since_start`: the first complete snapshot inside the period.
 */
type OpeningBasis = 'exact' | 'earlier' | 'since_start';

/** A slot of the monthly trend: the opening ("awal") or a month; a gap has no value and nothing is drawn. */
interface NetWorthPoint {
	/** 'awal' or the month `YYYY-MM`. */
	key: string;
	/** The snapshot's date (today for the live value); null for a gap. */
	date: string | null;
	minor: number | null;
	partial: boolean;
}

/** One allocation class's change; `cls` 'other' holds keys this build does not know (never dropped). */
export interface NetWorthGroupChange {
	cls: NetWorthClass | 'other';
	openingMinor: number | null;
	closingMinor: number | null;
	changeMinor: number | null;
}

export interface NetWorthPeriodReport {
	period: ReportPeriod;
	from: string;
	to: string;
	/** The period contains today: the closing value is the live total. */
	partial: boolean;
	opening: { minor: number; date: string; basis: OpeningBasis } | null;
	closing: { minor: number; date: string; live: boolean; partial: boolean } | null;
	/** Closing − opening; null when either is missing, they are not two different values, or it is too large. */
	changeMinor: number | null;
	points: NetWorthPoint[];
	/** Largest change first, unchanged groups left out; null when either end has no `classes`. */
	groups: NetWorthGroupChange[] | null;
	/** The first snapshot date with `classes` (null: none yet), for "tersedia mulai …". */
	groupsSince: string | null;
	/** The live total's daily rates, when it holds a foreign currency; null otherwise. */
	rates: LiveNetWorth['rates'] | null;
	/** Nothing recorded for the period: no snapshot, no opening and no live holdings. */
	empty: boolean;
	/** The live value left `Data demo` items out (the page badges it). */
	hasDemo: boolean;
}

/** `classes` JSON text as a record of integer amounts; null when absent or malformed (never a guess). */
function parseClasses(text: string | null): Map<string, bigint> | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
		const map = new Map<string, bigint>();
		for (const [key, amount] of Object.entries(value)) {
			if (!Number.isSafeInteger(amount)) return null;
			map.set(key, BigInt(amount as number));
		}
		return map;
	} catch {
		return null;
	}
}

function liveClasses(classes: LiveNetWorth['classes']): Map<string, bigint> | null {
	const map = new Map<string, bigint>();
	for (const c of classes) {
		if (c.minor === null) return null;
		map.set(c.cls, BigInt(c.minor));
	}
	return map;
}

const KNOWN = new Set<string>(NET_WORTH_CLASSES);

/**
 * The change per class between two class records (a class absent on one side counts as 0 there; unknown keys are
 * summed into 'other'), unchanged classes left out, largest absolute change first. Exact: the changes add up to the
 * difference of the two records' sums. Pure.
 */
export function groupChanges(
	opening: ReadonlyMap<string, bigint>,
	closing: ReadonlyMap<string, bigint>
): NetWorthGroupChange[] {
	const fold = (record: ReadonlyMap<string, bigint>) => {
		const out = new Map<NetWorthClass | 'other', bigint>();
		for (const [key, amount] of record) {
			const cls = KNOWN.has(key) ? (key as NetWorthClass) : 'other';
			out.set(cls, (out.get(cls) ?? 0n) + amount);
		}
		return out;
	};
	const o = fold(opening);
	const c = fold(closing);
	const order: (NetWorthClass | 'other')[] = [...NET_WORTH_CLASSES, 'other'];
	const rows = order
		.filter((cls) => o.has(cls) || c.has(cls))
		.map((cls) => {
			const before = o.get(cls) ?? 0n;
			const after = c.get(cls) ?? 0n;
			return { cls, before, after, change: after - before };
		})
		.filter((r) => r.change !== 0n);
	const abs = (v: bigint) => (v < 0n ? -v : v);
	rows.sort((a, b) =>
		abs(a.change) === abs(b.change)
			? order.indexOf(a.cls) - order.indexOf(b.cls)
			: abs(b.change) > abs(a.change)
				? 1
				: -1
	);
	return rows.map((r) => ({
		cls: r.cls,
		openingMinor: safeMinor(r.before),
		closingMinor: safeMinor(r.after),
		changeMinor: safeMinor(r.change)
	}));
}

/**
 * Folds the period's snapshots (oldest first), the latest complete snapshot before the period (`before`) and, for
 * a period containing `today`, the live value into the report. Pure: every date is an input, so the WIB boundary
 * vectors are plain tests.
 */
export function shapeNetWorthPeriod(input: {
	period: ReportPeriod;
	today: string;
	rows: readonly PeriodSnapshot[];
	before: PeriodSnapshot | null;
	groupsSince: string | null;
	live: LiveNetWorth | null;
}): NetWorthPeriodReport {
	const { period, today, rows } = input;
	const dates = periodDates(period, today);
	const live = dates.partial ? input.live : null;
	const inPeriod = rows.filter(
		(r) => r.date >= dates.from && r.date <= dates.to && r.date <= today
	);
	const complete = inPeriod.filter((r) => !r.partial);

	// Closing: the live total for a running period; else the latest complete snapshot inside the period (a
	// snapshot dated before the period never closes it: that would claim "no change" for a period with no record).
	const lastComplete = complete.at(-1) ?? null;
	const closing =
		live !== null
			? live.totalMinor === null
				? null
				: { minor: live.totalMinor, date: today, live: true, partial: live.partial }
			: lastComplete
				? { minor: lastComplete.totalMinor, date: lastComplete.date, live: false, partial: false }
				: null;
	const closingClasses =
		live !== null ? liveClasses(live.classes) : parseClasses(lastComplete?.classes ?? null);

	// Opening: the complete snapshot of the day before the period, or one at most OPENING_CARRY_DAYS older; else
	// the first complete snapshot inside the period ("sejak …"), if it comes before the closing value.
	const dayBefore = addDays(dates.from, -1);
	const before =
		input.before &&
		!input.before.partial &&
		input.before.date <= dayBefore &&
		daysBetween(input.before.date, dayBefore) <= OPENING_CARRY_DAYS
			? input.before
			: null;
	const first = complete[0] ?? null;
	const openingRow = before ?? (first && closing && first.date < closing.date ? first : null);
	const opening = openingRow
		? {
				minor: openingRow.totalMinor,
				date: openingRow.date,
				basis: (openingRow === before
					? openingRow.date === dayBefore
						? 'exact'
						: 'earlier'
					: 'since_start') as OpeningBasis
			}
		: null;

	const changeMinor =
		opening && closing && opening.date < closing.date
			? safeMinor(BigInt(closing.minor) - BigInt(opening.minor))
			: null;

	const openingClasses = openingRow ? parseClasses(openingRow.classes) : null;
	const groups =
		changeMinor !== null && openingClasses && closingClasses
			? groupChanges(openingClasses, closingClasses)
			: null;

	const thisMonth = monthOf(today);
	const monthPoints = dates.months.map((month): NetWorthPoint => {
		if (live !== null && month === thisMonth && live.totalMinor !== null)
			return { key: month, date: today, minor: live.totalMinor, partial: live.partial };
		const last = inPeriod.filter((r) => monthOf(r.date) === month).at(-1);
		return last
			? { key: month, date: last.date, minor: last.totalMinor, partial: last.partial }
			: { key: month, date: null, minor: null, partial: false };
	});
	// Months before the space's first record are not gaps: nothing was recorded yet ("Dihitung sejak …"). With no
	// complete snapshot before the period at all they are left out, so a year whose records start in October is not
	// drawn as nine empty slots between "Awal" and October. An older snapshot (even one too old to open the period)
	// keeps every month: a month without a record after it is a real gap. The last month always stays.
	const firstRecorded =
		input.before !== null
			? 0
			: monthPoints.findIndex(
					(p) => p.minor !== null || (opening !== null && p.key >= monthOf(opening.date))
				);
	const points: NetWorthPoint[] = [
		opening
			? { key: 'awal', date: opening.date, minor: opening.minor, partial: false }
			: { key: 'awal', date: null, minor: null, partial: false },
		...monthPoints.slice(firstRecorded === -1 ? Math.max(0, monthPoints.length - 1) : firstRecorded)
	];

	return {
		period,
		from: dates.from,
		to: dates.to,
		partial: dates.partial,
		opening,
		closing,
		changeMinor,
		points,
		groups,
		groupsSince: input.groupsSince,
		rates: live && live.rates.length > 0 ? live.rates : null,
		empty:
			inPeriod.length === 0 && opening === null && (live === null || live.classes.length === 0),
		hasDemo: live?.hasDemo ?? false
	};
}

/**
 * The live net worth of `spaceId` now: exactly what /kekayaan's hero shows (`netWorthSummary` over the cached
 * prices in `book`; a KV outage reads as "no price" and items fall back to their manual values).
 */
export async function liveNetWorth(
	db: Db,
	spaceId: string,
	book: PriceBook,
	now: number
): Promise<LiveNetWorth> {
	const summary = await netWorthSummary(db, spaceId, book, now);
	return {
		totalMinor: summary.totalMinor,
		classes: summary.classes,
		partial: summaryIsPartial(summary),
		rates: summary.rates,
		hasDemo: summary.items.some((i) => i.isDemo)
	};
}

/**
 * The net-worth report of `spaceId` (already admitted by the access gate) for `period` on the WIB date `today`.
 * Two D1 statements: the period's snapshots (at most PERIOD_MAX_SNAPSHOTS, the primary key `(space_id, date)`
 * serves it) and the latest complete snapshot before the period with the first date that carries `classes`. `live`
 * is the caller's `liveNetWorth` for a period containing today, null otherwise (a past period reads no price cache
 * and no wallet sums).
 */
export async function netWorthPeriodReport(
	db: Db,
	spaceId: string,
	period: ReportPeriod,
	today: string,
	live: LiveNetWorth | null
): Promise<NetWorthPeriodReport> {
	const dates = periodDates(period, today);
	const upTo = dates.to < today ? dates.to : today;
	const dayBefore = addDays(dates.from, -1);
	type Row = { date: string; total: number; partial: number; classes: string | null };
	const [rows, [head]] = await Promise.all([
		db.all<Row>(sql`select date, total_minor as total, partial, classes from net_worth_snapshots
			where space_id = ${spaceId} and deleted_at is null and date >= ${dates.from} and date <= ${upTo}
			order by date limit ${PERIOD_MAX_SNAPSHOTS}`),
		db.all<{
			date: string | null;
			total: number | null;
			classes: string | null;
			since: string | null;
		}>(sql`select o.date as date, o.total_minor as total, o.classes as classes,
				(select s.date from net_worth_snapshots s
					where s.space_id = ${spaceId} and s.deleted_at is null and s.classes is not null
					order by s.date limit 1) as since
			from (select 1) as one
			left join (select date, total_minor, classes from net_worth_snapshots
				where space_id = ${spaceId} and deleted_at is null and partial = 0 and date <= ${dayBefore}
				order by date desc limit 1) as o on 1`)
	]);
	return shapeNetWorthPeriod({
		period,
		today,
		rows: rows.map((r) => ({
			date: r.date,
			totalMinor: r.total,
			partial: r.partial === 1,
			classes: r.classes
		})),
		before:
			head?.date && head.total !== null
				? { date: head.date, totalMinor: head.total, partial: false, classes: head.classes }
				: null,
		groupsSince: head?.since ?? null,
		live
	});
}
