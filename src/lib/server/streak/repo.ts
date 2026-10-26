import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { addDays } from '#lib/shared/dates';
import type { Db } from '../db';
import { dayClosures } from '../db/schema';
import { newId } from '../util';
import { countStreak, streakHistory, type Streak, type StreakHistory } from './count';

/**
 * "Tutup hari" (FN-34). Every function takes the signed-in user's own id (`locals.user.id`), never an id from
 * the request: a closure belongs to the account, not to a space (owner decision A), so one streak covers every
 * space the user is in. Dates are WIB calendar dates computed by the server.
 */

/** Most closures read for one streak, and the period they come from: a streak counts up to this many days. */
export const STREAK_LOOKBACK_DAYS = 400;

/**
 * Closes the WIB date `closedOn` for `userId`: one guarded insert (nothing when that day is already closed or
 * the account is gone; the unique index absorbs a concurrent double submit), then a read in the same batch.
 * True when the day is closed afterwards, whether by this call or an earlier one.
 */
export async function closeDay(
	db: Db,
	userId: string,
	closedOn: string,
	now: number
): Promise<boolean> {
	const [, after] = await db.batch([
		db
			.insert(dayClosures)
			.select(
				sql`select ${newId()}, ${userId}, ${closedOn}, ${now}, ${now}
				where exists (select 1 from users u where u.id = ${userId})
					and not exists (select 1 from day_closures d where d.user_id = ${userId} and d.closed_on = ${closedOn})`
			)
			.onConflictDoNothing(),
		db
			.select({ id: dayClosures.id })
			.from(dayClosures)
			.where(and(eq(dayClosures.userId, userId), eq(dayClosures.closedOn, closedOn)))
			.limit(1)
	]);
	return after.length === 1;
}

/** The user's closed WIB dates in the STREAK_LOOKBACK_DAYS ending `today`, newest first (bounded). */
async function closedDates(db: Db, userId: string, today: string): Promise<string[]> {
	const rows = await db
		.select({ closedOn: dayClosures.closedOn })
		.from(dayClosures)
		.where(
			and(
				eq(dayClosures.userId, userId),
				lte(dayClosures.closedOn, today),
				gte(dayClosures.closedOn, addDays(today, -(STREAK_LOOKBACK_DAYS - 1)))
			)
		)
		.orderBy(desc(dayClosures.closedOn))
		.limit(STREAK_LOOKBACK_DAYS);
	return rows.map((r) => r.closedOn);
}

/** The user's streak on the WIB date `today`, from at most STREAK_LOOKBACK_DAYS of their newest closures. */
export async function streakSummary(db: Db, userId: string, today: string): Promise<Streak> {
	return countStreak(await closedDates(db, userId, today), today);
}

/**
 * FN-34b /beruntun: the same bounded window as streakSummary (so `current` always equals the Beranda chip), plus
 * the longest run in it, the days freezes bridged, the banked freezes and the closed dates for the calendar.
 */
export async function streakDetails(
	db: Db,
	userId: string,
	today: string
): Promise<StreakHistory & { closedOn: string[] }> {
	const closedOn = await closedDates(db, userId, today);
	return { ...streakHistory(closedOn, today), closedOn };
}

/**
 * FN-54 /kalender: the user's closed WIB dates between `from` and `to` (one calendar month, so at most 31 rows),
 * oldest first. Account-scoped like every closure: a shared space's other members never show here.
 */
export async function closedDatesIn(
	db: Db,
	userId: string,
	from: string,
	to: string
): Promise<string[]> {
	const rows = await db
		.select({ closedOn: dayClosures.closedOn })
		.from(dayClosures)
		.where(
			and(
				eq(dayClosures.userId, userId),
				gte(dayClosures.closedOn, from),
				lte(dayClosures.closedOn, to)
			)
		)
		.orderBy(dayClosures.closedOn)
		.limit(31);
	return rows.map((r) => r.closedOn);
}
