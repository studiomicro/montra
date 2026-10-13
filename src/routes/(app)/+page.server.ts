import { error, redirect } from '@sveltejs/kit';
import { deleteBudgetAction, setBudgetAction } from '#lib/server/budgets/actions';
import { BERANDA_LOAD_FAILED } from '#lib/server/budgets/messages';
import { berandaLists, berandaSummary } from '#lib/server/budgets/summary';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { closeDay, streakSummary } from '#lib/server/streak/repo';
import { errorLabel } from '#lib/server/util';
import { wibDateString, wibTodayString } from '#lib/shared/dates';
import type { Actions, PageServerLoad } from './$types';

// Beranda works on the session's current space (locals.space), re-checked through requireSpaceAccess on every
// load and action (currentSpaceScope); budget writes repeat the membership inside their statements. No budget
// id is ever read from the client: the server resolves "the live budget of this space" itself.
// The streak (FN-34) is the signed-in account's own, read and written with locals.user.id only (owner
// decision A): no id or date is taken from the request; the closed day is the server's WIB date.

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId, userId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	// `?anggaran=1` opens the budget form without JavaScript (the sheet does it with JavaScript).
	const openBudget = url.searchParams.get('anggaran') === '1';
	// "Terbaru", "Akan datang" and the streak load beside the figures: if one fails, the rest still shows.
	const [summary, lists, streak] = await Promise.all([
		berandaSummary(locals.db, spaceId, today).catch((e: unknown) => {
			console.error('beranda: summary failed', e);
			return null;
		}),
		berandaLists(locals.db, spaceId, today).catch((e: unknown) => {
			console.error('beranda: lists failed', e);
			return null;
		}),
		streakSummary(locals.db, userId, today).catch((e: unknown) => {
			console.error('beranda: streak failed', errorLabel(e));
			return null;
		})
	]);
	return {
		today,
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
