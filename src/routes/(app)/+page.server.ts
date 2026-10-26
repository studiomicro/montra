import { error, redirect } from '@sveltejs/kit';
import { deleteBudgetAction, setBudgetAction } from '#lib/server/budgets/actions';
import { BERANDA_LOAD_FAILED } from '#lib/server/budgets/messages';
import { berandaLists, berandaSummary } from '#lib/server/budgets/summary';
import { onThisDayEntry } from '#lib/server/content/on-this-day';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { closeDay, streakSummary } from '#lib/server/streak/repo';
import { sectionOr } from '#lib/server/util';
import { STORY_OFF_COOKIE, STORY_SEEN_COOKIE, storyCards, storyDue } from '#lib/shared/daily-story';
import { wibDateString, wibTodayString } from '#lib/shared/dates';
import { greetingPeriod } from '#lib/shared/greeting';
import type { Actions, PageServerLoad } from './$types';

// Beranda works on the session's current space (locals.space), re-checked through requireSpaceAccess on every
// load and action (currentSpaceScope); budget writes repeat the membership inside their statements. No budget
// id is ever read from the client: the server resolves "the live budget of this space" itself.
// The streak (FN-34) is the signed-in account's own, read and written with locals.user.id only (owner
// decision A): no id or date is taken from the request; the closed day is the server's WIB date.
// FN-54: the greeting and the date badge come from one server instant (WIB), so hydration never disagrees. The daily
// greeting's two device cookies are display preferences only; its cards are built from this load's own figures.

export const load: PageServerLoad = async ({ locals, url, cookies }) => {
	const { spaceId, userId } = await currentSpaceScope(locals);
	const now = Date.now();
	const today = wibTodayString(now);
	// `?anggaran=1` opens the budget form without JavaScript (the sheet does it with JavaScript).
	const openBudget = url.searchParams.get('anggaran') === '1';
	// "Terbaru", "Akan datang" and the streak load beside the figures: if one fails, the rest still shows.
	const [summary, lists, streak] = await Promise.all([
		sectionOr('beranda: summary failed', berandaSummary(locals.db, spaceId, today), null),
		sectionOr('beranda: lists failed', berandaLists(locals.db, spaceId, today), null),
		sectionOr('beranda: streak failed', streakSummary(locals.db, userId, today), null)
	]);
	// FN-54 D2: the story's cards only when it is due today on this device (a seen day or the off switch costs no
	// payload), never on a load error.
	const story =
		summary &&
		storyDue({ seen: cookies.get(STORY_SEEN_COOKIE), off: cookies.get(STORY_OFF_COOKIE) }, today)
			? storyCards({
					today,
					walletCount: summary.walletCount,
					currency: summary.currency,
					bars: summary.bars,
					upcoming: lists?.upcoming ?? null,
					safeToSpend: summary.safeToSpend,
					budgetCurrency: summary.budget?.currency ?? summary.currency,
					entry: onThisDayEntry(today)
				})
			: [];
	return {
		today,
		greeting: greetingPeriod(now),
		story,
		summary,
		lists,
		streak,
		openBudget,
		loadError: summary ? null : BERANDA_LOAD_FAILED
	};
};

/** The budget form (FN-07); the same actions serve Anggaran (budgets/actions.ts). */
export const actions: Actions = {
	setBudget: setBudgetAction,
	deleteBudget: deleteBudgetAction,

	// Account-scoped (red team FN-34 L1): only the signed-in user is needed, never the current space, so a member
	// whose session still names a space they were just removed from closes their own day. CSRF is SvelteKit's
	// origin check on every form action.
	closeDay: async ({ locals }) => {
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const now = Date.now();
		// Today is the server's WIB date at the moment of the write, never a date from the form.
		if (!(await closeDay(locals.db, user.id, wibDateString(now), now))) error(404, 'Not found');
		return { saved: 'closed' as const };
	}
};
