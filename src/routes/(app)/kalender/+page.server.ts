import {
	calendarClosures,
	calendarDayRows,
	calendarSchedules,
	calendarSpending
} from '#lib/server/calendar/month';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { errorLabel } from '#lib/server/util';
import {
	calendarDay,
	calendarMonth,
	calendarNeighbours,
	upcomingInMonth
} from '#lib/shared/calendar';
import { monthOf, monthRange, wibTodayString } from '#lib/shared/dates';
import type { PageServerLoad } from './$types';

// /kalender (FN-54 Part C), opened from Beranda's date badge. Read-only. The space is the session's current space,
// admitted through requireSpaceAccess (currentSpaceScope) before anything is read: signed out goes to /masuk, a
// removed member gets the shared 404. Closed days are the signed-in account's own (locals.user.id via the scope),
// never another member's. Only `?bulan=` and `?hari=` are read from the request, both validated and clamped to the
// window (23 months back, 2 ahead); anything else shows this WIB month. The four reads load side by side and each
// fails to null on its own, so one failing never blanks the others.

const failed = (what: string) => (e: unknown) => {
	console.error(`kalender: ${what} failed`, errorLabel(e));
	return null;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId, userId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	const thisMonth = monthOf(today);
	const month = calendarMonth(url.searchParams.get('bulan'), thisMonth);
	const day =
		calendarDay(url.searchParams.get('hari'), month) ?? (month === thisMonth ? today : null);
	const futureMonth = monthRange(month).to >= today;

	const [spending, closures, schedules, dayRows] = await Promise.all([
		calendarSpending(locals.db, spaceId, month, today).catch(failed('spending')),
		calendarClosures(locals.db, userId, month).catch(failed('closures')),
		// A month wholly in the past has nothing still to come: no read.
		futureMonth
			? calendarSchedules(locals.db, spaceId, today).catch(failed('upcoming'))
			: Promise.resolve({ subscriptions: [], series: [] }),
		// A future day has no rows yet: only its due items show.
		day !== null && day <= today
			? calendarDayRows(locals.db, spaceId, day).catch(failed('day'))
			: Promise.resolve({ group: null, hasMore: false })
	]);

	return {
		today,
		month,
		thisMonth,
		day,
		neighbours: calendarNeighbours(month, thisMonth),
		spending,
		closedOn: closures,
		upcoming: schedules && upcomingInMonth(month, today, schedules.subscriptions, schedules.series),
		dayRows
	};
};
