import { fail, redirect } from '@sveltejs/kit';
import {
	AGENT_DELETE_FAILED,
	AGENT_EMPTY,
	AGENT_INVALID,
	AGENT_LOAD_FAILED,
	AGENT_PLAN_ENDED,
	AGENT_PLAN_REQUIRED,
	AGENT_SAVE_FAILED,
	AGENT_SPACE_BUSY,
	AGENT_SPACE_DAILY,
	AGENT_TOO_MANY,
	AGENT_USER_BUSY,
	AGENT_USER_DAILY
} from '#lib/server/agent/messages';
import {
	agentRunId,
	createRun,
	deleteRun,
	hasAssetRecords,
	hasRowsIn,
	listRuns,
	monthsWithRows,
	type CreateRunResult
} from '#lib/server/agent/repo';
import { isAiGatewayConfigured } from '#lib/server/ai-keys/anthropic';
import { getStoredKey } from '#lib/server/ai-keys/repo';
import { agentEnabled, planOf } from '#lib/server/billing/gate';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { cleanUpFiles } from '#lib/server/photos/store';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { errorLabel, newId } from '#lib/server/util';
import { agentForm, agentRange, isAgentPeriod, AGENT_MAX_YEARS_BACK } from '#lib/shared/agent';
import { wibTodayString } from '#lib/shared/dates';
import type { JobMessage } from '#lib/shared/jobs';
import type { Actions, PageServerLoad } from './$types';

/**
 * FN-23 Agen (beta). Every load, action and download re-checks the Agent plan on the server with
 * `locals.user.id` (`agentEnabled`, FN-30's one gate) and resolves the space through `currentSpaceScope`
 * (signed out: /masuk; a removed member: the shared 404). Not on the Agent plan: the locked state, no run data.
 * `buat` creates a queued run (one guarded insert holding every cap) and enqueues its first step; the jobs Worker
 * does the rest. `hapus` deletes one of the user's own runs. Both redirect after post, so a reload never repeats
 * them; progress always comes from D1, never from the browser.
 */

export type NarrativeReady = 'ok' | 'no_gateway' | 'no_key';

const CREATE_REFUSALS: Record<Exclude<CreateRunResult, 'created' | 'exists'>, [number, string]> = {
	user_busy: [429, AGENT_USER_BUSY],
	space_busy: [429, AGENT_SPACE_BUSY],
	user_daily: [429, AGENT_USER_DAILY],
	space_daily: [429, AGENT_SPACE_DAILY],
	too_many: [409, AGENT_TOO_MANY],
	gone: [404, AGENT_SAVE_FAILED]
};

/** The periods the form offers on `today`: the current month or year first, then those that hold rows. */
function periodsOf(months: readonly string[], today: string) {
	const month = today.slice(0, 7);
	const year = today.slice(0, 4);
	const oldest = Number(year) - AGENT_MAX_YEARS_BACK;
	const monthList = [...new Set([month, ...months])].filter((m) => Number(m.slice(0, 4)) >= oldest);
	const yearList = [...new Set([year, ...months.map((m) => m.slice(0, 4))])].filter(
		(y) => Number(y) >= oldest
	);
	return {
		months: monthList.sort().reverse(),
		years: yearList.sort().reverse()
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/masuk?next=%2Fagen');
	const scope = await currentSpaceScope(locals);
	const db = locals.db;
	const now = Date.now();
	if (!agentEnabled(await planOf(db, scope.userId, now)))
		return { locked: true as const, message: AGENT_PLAN_REQUIRED };
	const env = getEnv();
	const configured = isAiGatewayConfigured(env);
	const today = wibTodayString(now);
	try {
		const [runs, months, hasKey] = await Promise.all([
			listRuns(db, scope, now),
			monthsWithRows(db, scope.spaceId, today),
			// Only whether a key is stored (red team S4: never decrypted here); the key never leaves the server.
			configured ? getStoredKey(db, scope.userId, 'anthropic').then((k) => k !== null) : false
		]);
		const narrative: NarrativeReady = !configured ? 'no_gateway' : hasKey ? 'ok' : 'no_key';
		return {
			locked: false as const,
			runs,
			periods: periodsOf(months, today),
			narrative,
			today,
			requestId: newId(),
			active: runs.some((r) => r.status === 'queued' || r.status === 'running'),
			loadError: null
		};
	} catch (e) {
		console.error('agen: load failed', errorLabel(e));
		return {
			locked: false as const,
			runs: [],
			periods: periodsOf([], today),
			narrative: (configured ? 'ok' : 'no_gateway') as NarrativeReady,
			today,
			requestId: newId(),
			active: false,
			loadError: AGENT_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	/** "Buat laporan": refused (no row, nothing queued) off the Agent plan, for an invalid or empty period, or past a cap. */
	buat: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/masuk?next=%2Fagen');
		const scope = await currentSpaceScope(locals);
		const db = locals.db;
		const form = await readFormBody(request);
		const now = Date.now();
		if (!agentEnabled(await planOf(db, scope.userId, now)))
			return fail(403, { action: 'buat' as const, error: AGENT_PLAN_REQUIRED });
		// Two selects (months, years) so the form works without JavaScript; the type picks which one counts.
		const type = textField(form, 'type');
		const parsed = agentForm.safeParse({
			type,
			period: textField(form, type === 'monthly' ? 'month' : 'year'),
			narrative: textField(form, 'narrative') === 'on',
			requestId: textField(form, 'requestId')
		});
		const today = wibTodayString(now);
		if (!parsed.success || !isAgentPeriod(parsed.data.type, parsed.data.period, today))
			return fail(400, { action: 'buat' as const, error: AGENT_INVALID });
		const input = parsed.data;
		const empty =
			input.type === 'spt_assets'
				? !(await hasAssetRecords(db, scope.spaceId))
				: !(await hasRowsIn(db, scope.spaceId, agentRange(input.type, input.period, today)));
		if (empty) return fail(400, { action: 'buat' as const, error: AGENT_EMPTY });
		const id = await agentRunId(scope.userId, input.requestId);
		let result: CreateRunResult;
		try {
			result = await createRun(
				db,
				scope,
				{
					id,
					type: input.type,
					period: input.period,
					// The asset list never calls the model (owner decision 8).
					withNarrative: input.narrative && input.type !== 'spt_assets',
					locale: locals.locale
				},
				now
			);
		} catch (e) {
			console.error('agen: create failed', errorLabel(e));
			return fail(503, { action: 'buat' as const, error: AGENT_SAVE_FAILED });
		}
		if (result !== 'created' && result !== 'exists') {
			const [status, error] = CREATE_REFUSALS[result];
			return fail(status, { action: 'buat' as const, error });
		}
		if (result === 'created') {
			try {
				await getEnv().JOBS_QUEUE.send({ type: 'agent_run', runId: id } satisfies JobMessage);
			} catch (e) {
				// The row stays `queued` ("Antre"); the cron sweep re-sends it.
				console.warn('agen: first step not queued, left to the cron sweep', errorLabel(e));
			}
		}
		// Success only once the run row exists: the page lists it from D1 (redirect after post).
		redirect(303, '/agen');
	},

	/** "Hapus": one of the user's own runs in this space; idempotent (an already deleted run is not an error). */
	hapus: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/masuk?next=%2Fagen');
		const scope = await currentSpaceScope(locals);
		const db = locals.db;
		const form = await readFormBody(request);
		const now = Date.now();
		if (!agentEnabled(await planOf(db, scope.userId, now)))
			return fail(403, { action: 'hapus' as const, error: AGENT_PLAN_ENDED });
		const id = textField(form, 'id').slice(0, 64);
		try {
			const keys = await deleteRun(db, scope, id, now);
			await cleanUpFiles(getEnv(), db, keys, now);
		} catch (e) {
			console.error('agen: delete failed', errorLabel(e));
			return fail(503, { action: 'hapus' as const, error: AGENT_DELETE_FAILED });
		}
		redirect(303, '/agen');
	}
};
