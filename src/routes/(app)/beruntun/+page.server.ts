import { getActiveBudget } from '#lib/server/budgets/repo';
import { budgetStreakSummary } from '#lib/server/budgets/streak';
import { getCloseReminderHour, getNotificationPrefs } from '#lib/server/notifications/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { streakDetails } from '#lib/server/streak/repo';
import { errorLabel } from '#lib/server/util';
import { monthOf, shiftMonth, wibTodayString } from '#lib/shared/dates';
import { budgetCalendar, closureCalendar, STREAK_MILESTONES } from '#lib/shared/streak';
import type { PageServerLoad } from './$types';

// /beruntun (FN-34b). The closure streak and the reminder preference are the signed-in account's own (read with
// locals.user.id only, FN-34 owner decision A); the budget streak is the current space's, admitted through
// requireSpaceAccess (currentSpaceScope) on every load. No id or date is read from the request: `?bulan=` only
// picks between this WIB month and the one before (anything else shows this month), so the calendar never reads
// or shows a date outside those two months. The four reads load side by side; one failing never blanks the rest.

const failed = (what: string) => (e: unknown) => {
	console.error(`beruntun: ${what} failed`, errorLabel(e));
	return null;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId, userId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	const thisMonth = monthOf(today);
	const lastMonth = shiftMonth(thisMonth, -1);
	const month = url.searchParams.get('bulan') === lastMonth ? lastMonth : thisMonth;

	const [closure, budget, budgetSet, reminder] = await Promise.all([
		streakDetails(locals.db, userId, today).catch(failed('closure streak')),
		budgetStreakSummary(locals.db, spaceId, today).catch(failed('budget streak')),
		getActiveBudget(locals.db, spaceId)
			.then((b) => b !== null)
			.catch(failed('budget')),
		Promise.all([getNotificationPrefs(locals.db, userId), getCloseReminderHour(locals.db, userId)])
			.then(([prefs, hour]) => ({ enabled: prefs.close_reminder, hour }))
			.catch(failed('reminder'))
	]);

	return {
		today,
		month,
		thisMonth,
		lastMonth,
		closure: closure && {
			current: closure.current,
			closedToday: closure.closedToday,
			longest: closure.longest,
			bank: closure.bank,
			milestones: STREAK_MILESTONES.map((days) => ({ days, reached: closure.longest >= days })),
			calendar: closureCalendar(month, today, new Set(closure.closedOn), new Set(closure.frozen))
		},
		budget: budget && {
			current: budget.current,
			longest: budget.longest,
			// null: whether a budget is set now could not be read (the streak figures still show).
			hasBudget: budgetSet,
			calendar: budgetCalendar(month, today, new Map(budget.days.map((d) => [d.date, d.status])))
		},
		reminder
	};
};
