import { sql } from 'drizzle-orm';
import { trendRangeStart, type TrendRange } from '#lib/shared/wealth';
import type { Db } from '../db';

/** Most daily points one chart reads (about ten years); `all` beyond that keeps the newest. */
export const TREND_MAX_POINTS = 3660;

/** One stored daily snapshot as the chart plots it: the recorded IDR total, never interpolated. */
export interface TrendPoint {
	/** WIB date `YYYY-MM-DD`. */
	date: string;
	totalMinor: number;
	/** A price or rate was missing that day: still the recorded figure, drawn with a lighter dot. */
	partial: boolean;
}

/**
 * The space's live `net_worth_snapshots` (FN-25's daily totals, already without `Data demo` items) from the
 * range's first WIB date through `today`, oldest first. Callers have admitted the user with
 * `requireSpaceAccess`. Bounded: at most TREND_MAX_POINTS rows, the newest kept.
 */
export async function netWorthTrend(
	db: Db,
	spaceId: string,
	range: TrendRange,
	today: string
): Promise<TrendPoint[]> {
	const from = trendRangeStart(range, today);
	const rows = await db.all<{ date: string; total: number; partial: number }>(sql`select date,
			total_minor as total, partial from net_worth_snapshots
		where space_id = ${spaceId} and deleted_at is null and date <= ${today}
			${from === null ? sql`` : sql`and date >= ${from}`}
		order by date desc limit ${TREND_MAX_POINTS}`);
	return rows
		.reverse()
		.map((r) => ({ date: r.date, totalMinor: r.total, partial: r.partial === 1 }));
}
