import { error, fail } from '@sveltejs/kit';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField, boundedId, expectedUpdatedAt } from '#lib/server/forms';
import {
	addContribution,
	deleteContribution,
	listContributions,
	type ContributionCursor
} from '#lib/server/goals/contributions';
import {
	CONTRIBUTION_NOT_FOUND,
	GOAL_CHANGED,
	GOAL_NOT_FOUND,
	GOALS_LOAD_FAILED,
	SAVED_TOO_LARGE,
	CONTRIBUTION_LIMIT
} from '#lib/server/goals/messages';
import {
	archiveGoal,
	getGoal,
	restoreGoal,
	updateGoal,
	type GoalWriteResult
} from '#lib/server/goals/repo';
import { parseContributionForm, parseGoalForm } from '#lib/server/goals/validation';
import { notifyGoalMilestone } from '#lib/server/notifications/triggers';
import { currentSpaceAccess } from '#lib/server/spaces/current';
import { errorLabel } from '#lib/server/util';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// One goal of the session's current space (locals.space, re-validated through requireSpaceAccess with
// locals.user on every load and action). The goal and every contribution are looked up with `space_id` in the
// same query, so another space's id and an unknown id get the same answer: 404 "Not found" for the page,
// GOAL_NOT_FOUND / CONTRIBUTION_NOT_FOUND for an action.

/** `?sebelum=<created_at>_<id>`: the history page after (older than) that contribution. */
const CURSOR = /^(\d{1,15})_([0-9a-f-]{1,64})$/;

async function goalScope(event: { locals: App.Locals; params: { id: string } }) {
	const { scope } = await currentSpaceAccess(event.locals);
	const goalId = boundedId(event.params.id);
	return { scope, goalId };
}

function cursorOf(url: URL): ContributionCursor | null {
	const match = CURSOR.exec(url.searchParams.get('sebelum') ?? '');
	return match ? { createdAt: Number(match[1]), id: match[2] as string } : null;
}

function refused(result: Exclude<GoalWriteResult, 'ok'>) {
	return result === 'missing'
		? fail(404, { error: GOAL_NOT_FOUND })
		: fail(409, { error: GOAL_CHANGED });
}

export const load: PageServerLoad = async (event) => {
	const { scope, goalId } = await goalScope(event);
	const { locals, url } = event;
	const cursor = cursorOf(url);
	let goal;
	try {
		goal = await getGoal(locals.db, scope.spaceId, goalId, { includeArchived: true });
	} catch (e) {
		console.error('tabungan: goal read failed', errorLabel(e));
		return {
			goal: null,
			contributions: [],
			more: false,
			cursor: null,
			loadError: GOALS_LOAD_FAILED,
			open: null
		};
	}
	// Unknown, other-space and malformed ids alike: the same 404 as a space the user is not in.
	if (!goal) error(404, 'Not found');
	// `?ubah=1` / `?tambah=1` open the edit / add-contribution form without JavaScript.
	const open = goal.archived
		? null
		: url.searchParams.get('ubah') === '1'
			? ('edit' as const)
			: url.searchParams.get('tambah') === '1'
				? ('contribute' as const)
				: null;
	try {
		const page = await listContributions(locals.db, scope.spaceId, goalId, { cursor });
		return {
			goal,
			contributions: page.rows,
			more: page.more,
			cursor: cursor ? `${cursor.createdAt}_${cursor.id}` : null,
			loadError: null,
			open
		};
	} catch (e) {
		console.error('tabungan: contribution list failed', errorLabel(e));
		return {
			goal,
			contributions: [],
			more: false,
			cursor: null,
			loadError: GOALS_LOAD_FAILED,
			open
		};
	}
};

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const { scope, goalId } = await goalScope(event);
	return { form, scope, goalId, db: event.locals.db };
}

export const actions: Actions = {
	addContribution: async (event) => {
		const { form, scope, goalId, db } = await guarded(event);
		const parsed = parseContributionForm(form);
		if (!parsed.ok)
			return fail(400, {
				action: 'contribute' as const,
				errors: parsed.errors,
				values: parsed.values
			});
		const now = Date.now();
		const added = await addContribution(db, scope, goalId, parsed.value, now);
		if (!added.ok) {
			if (added.reason === 'missing') return fail(404, { error: GOAL_NOT_FOUND });
			const why = { archived: GOAL_CHANGED, too_large: SAVED_TOO_LARGE, limit: CONTRIBUTION_LIMIT };
			return fail(409, { error: why[added.reason] });
		}
		// FN-24: a 50 %/100 % crossing creates its notification now; the push goes through the queue.
		await notifyGoalMilestone(db, getEnv().JOBS_QUEUE, scope.spaceId, goalId, now);
		return { saved: 'contributed' as const };
	},

	deleteContribution: async (event) => {
		const { form, scope, goalId, db } = await guarded(event);
		const id = textField(form, 'contributionId');
		const result = await deleteContribution(db, scope, goalId, boundedId(id), Date.now());
		if (result !== 'ok') return fail(404, { error: CONTRIBUTION_NOT_FOUND });
		return { saved: 'deleted' as const };
	},

	updateGoal: async (event) => {
		const { form, scope, goalId, db } = await guarded(event);
		const parsed = parseGoalForm(form);
		if (!parsed.ok)
			return fail(400, { action: 'update' as const, errors: parsed.errors, values: parsed.values });
		const result = await updateGoal(
			db,
			scope,
			goalId,
			parsed.value,
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		return { saved: 'updated' as const };
	},

	archiveGoal: async (event) => {
		const { form, scope, goalId, db } = await guarded(event);
		const result = await archiveGoal(db, scope, goalId, expectedUpdatedAt(form), Date.now());
		if (result !== 'ok') return refused(result);
		return { saved: 'archived' as const };
	},

	restoreGoal: async (event) => {
		const { form, scope, goalId, db } = await guarded(event);
		const result = await restoreGoal(db, scope, goalId, expectedUpdatedAt(form), Date.now());
		if (result !== 'ok') return refused(result);
		return { saved: 'restored' as const };
	}
};
