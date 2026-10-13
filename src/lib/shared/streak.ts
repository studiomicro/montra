import { addDays, daysBetween, monthRange } from './dates.ts';

/**
 * FN-34 / FN-34b streaks: the fixed values both the server and the streak page use. Plain counts and day
 * states only: no coin, point, level or reward of any kind (FN-34 owner decision C).
 */

/** Milestones shown on /beruntun ("7 hari berturut-turut", …): reached once a run is at least this long. */
export const STREAK_MILESTONES = [7, 30, 100] as const;

/** A freeze is earned after this many actually-closed days of one unbroken run (owner decision B). */
export const FREEZE_EARN_EVERY = 7;
/** At most this many freezes are banked; an earn past it is simply not kept (owner decision B). */
export const FREEZE_BANK_MAX = 2;

/** The verdict stored for one space and WIB date (`budget_streak_days.status`). */
export const BUDGET_DAY_STATUSES = ['within', 'over'] as const;
export type BudgetDayStatus = (typeof BUDGET_DAY_STATUSES)[number];

/** One day on the closure calendar. `missed` is a past day neither closed nor bridged by a freeze. */
export type ClosureDayState = 'closed' | 'frozen' | 'missed' | 'today' | 'future';
/** One day on the budget calendar. `no_budget`: a past day without a verdict (no live budget then). */
export type BudgetDayState = BudgetDayStatus | 'no_budget' | 'today' | 'future';

/** Every WIB date of the month `YYYY-MM`, in order. */
function monthDays(month: string): string[] {
	const { from, to } = monthRange(month);
	return Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
}

/**
 * The closure calendar of `month` on WIB date `today`: each day closed, bridged by a freeze (`frozen`), missed,
 * today (still open) or in the future. Pure: `closed` and `frozen` come from the stored closures (streakHistory).
 */
export function closureCalendar(
	month: string,
	today: string,
	closed: ReadonlySet<string>,
	frozen: ReadonlySet<string>
): { date: string; state: ClosureDayState }[] {
	return monthDays(month).map((date) => ({
		date,
		state: closed.has(date)
			? 'closed'
			: date > today
				? 'future'
				: date === today
					? 'today'
					: frozen.has(date)
						? 'frozen'
						: 'missed'
	}));
}

/**
 * The budget calendar of `month` on WIB date `today`: each past day's stored verdict, `no_budget` for a past day
 * without one, `today` (judged tomorrow morning) or in the future.
 */
export function budgetCalendar(
	month: string,
	today: string,
	verdicts: ReadonlyMap<string, BudgetDayStatus>
): { date: string; state: BudgetDayState }[] {
	return monthDays(month).map((date) => ({
		date,
		state: date > today ? 'future' : date === today ? 'today' : (verdicts.get(date) ?? 'no_budget')
	}));
}
