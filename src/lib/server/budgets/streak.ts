import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { addDays, monthOf } from '#lib/shared/dates';
import type { BudgetDayStatus } from '#lib/shared/streak';
import type { Db } from '../db';
import { budgetStreakDays } from '../db/schema';
import { STREAK_LOOKBACK_DAYS } from '../streak/repo';
import { dailyTotals } from '../transactions/aggregate';
import { newId } from '../util';
import { daysRemainingInclusive, outIn, sumExact } from './math';
import { getActiveBudget } from './repo';

// FN-34b budget streak (owner decisions E and F): per space, one stored verdict per WIB date, written once the
// morning after from the budget live at that moment and FN-05's expense aggregates (real rows only, demo rows,
// income, transfers and adjustments never count). Never revised afterwards. Every function takes a space id the
// caller already admitted through the access gate (currentSpaceScope), or the jobs Worker's own space walk.

/**
 * The verdict for WIB date `date` (pure): `spentBefore` is the month's spending in the budget's currency from
 * the 1st through the day before `date`, `spentOn` that of `date` itself (null: too large to show, so over any
 * budget). The day's allowance is what is left of the budget split over the month's remaining days, `date`
 * included, rounded down like `safeToSpend` (never more generous than the real remainder). A budget already
 * spent past before `date` makes it `over` whatever `date` spent; otherwise `within` when `spentOn` is at most
 * the allowance.
 */
export function budgetDayStatus(
	budgetMinor: number,
	spentBefore: number | null,
	spentOn: number | null,
	date: string
): BudgetDayStatus {
	if (spentBefore === null || spentOn === null) return 'over';
	const remaining = BigInt(budgetMinor) - BigInt(spentBefore);
	if (remaining < 0n) return 'over';
	const allowance = remaining / BigInt(daysRemainingInclusive(date));
	return BigInt(spentOn) <= allowance ? 'within' : 'over';
}

export interface BudgetStreak {
	/** `within` days in a row through yesterday (today is judged tomorrow morning); a day without a verdict is skipped. */
	current: number;
	longest: number;
}

/**
 * Counts stored verdicts (any order) before `today`: a `within` day extends the run, an `over` day ends it, a
 * date without a verdict (no live budget then) is skipped, neither a break nor a day of the run.
 */
export function countBudgetStreak(
	days: readonly { date: string; status: BudgetDayStatus }[],
	today: string
): BudgetStreak {
	let current = 0;
	let longest = 0;
	for (const d of [...days]
		.filter((x) => x.date < today)
		.sort((a, b) => (a.date < b.date ? -1 : 1))) {
		current = d.status === 'within' ? current + 1 : 0;
		longest = Math.max(longest, current);
	}
	return { current, longest };
}

/**
 * Judges WIB date `date` for `spaceId` and stores the verdict once: nothing when the space has no live budget
 * now (a skip). One guarded insert (never a second row for a date: `not exists` plus the unique index, so a
 * redelivered or concurrent message is a no-op) that also requires the space to still be live. Returns the
 * stored verdict (this call's or an earlier one), or null when nothing is stored.
 */
export async function snapshotBudgetDay(
	db: Db,
	spaceId: string,
	date: string,
	now: number
): Promise<BudgetDayStatus | null> {
	const budget = await getActiveBudget(db, spaceId);
	if (!budget) return null;
	const from = `${monthOf(date)}-01`;
	const daily = await dailyTotals(db, spaceId, {
		from,
		to: date,
		type: 'expense',
		categoryId: null,
		walletId: null,
		q: null
	});
	const spentBefore = sumExact(
		daily.filter((d) => d.date < date).map((d) => outIn(d.totals, budget.currency))
	);
	const onDate = daily.find((d) => d.date === date);
	const spentOn = onDate ? outIn(onDate.totals, budget.currency) : 0;
	const status = budgetDayStatus(budget.amountMinor, spentBefore, spentOn, date);
	const [, stored] = await db.batch([
		db
			.insert(budgetStreakDays)
			.select(
				sql`select ${newId()}, ${spaceId}, ${date}, ${status}, ${now}
				where exists (select 1 from spaces s where s.id = ${spaceId} and s.deleted_at is null)
					and not exists (select 1 from budget_streak_days b where b.space_id = ${spaceId} and b.date = ${date})`
			)
			.onConflictDoNothing(),
		db
			.select({ status: budgetStreakDays.status })
			.from(budgetStreakDays)
			.where(and(eq(budgetStreakDays.spaceId, spaceId), eq(budgetStreakDays.date, date)))
			.limit(1)
	]);
	return stored[0]?.status ?? null;
}

/** The space's stored verdicts in the STREAK_LOOKBACK_DAYS before `today`, oldest first (bounded). */
export async function budgetStreakDaysOf(
	db: Db,
	spaceId: string,
	today: string
): Promise<{ date: string; status: BudgetDayStatus }[]> {
	return db
		.select({ date: budgetStreakDays.date, status: budgetStreakDays.status })
		.from(budgetStreakDays)
		.where(
			and(
				eq(budgetStreakDays.spaceId, spaceId),
				lt(budgetStreakDays.date, today),
				gte(budgetStreakDays.date, addDays(today, -STREAK_LOOKBACK_DAYS))
			)
		)
		.orderBy(asc(budgetStreakDays.date))
		.limit(STREAK_LOOKBACK_DAYS);
}

/** The budget streak of `spaceId` on WIB date `today`, plus the verdicts it was counted from (for the calendar). */
export async function budgetStreakSummary(
	db: Db,
	spaceId: string,
	today: string
): Promise<BudgetStreak & { days: { date: string; status: BudgetDayStatus }[] }> {
	const days = await budgetStreakDaysOf(db, spaceId, today);
	return { ...countBudgetStreak(days, today), days };
}
