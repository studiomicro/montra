import { error, json } from '@sveltejs/kit';
import { AGENT_PLAN_ENDED } from '#lib/server/agent/messages';
import { listRuns } from '#lib/server/agent/repo';
import { agentEnabled, planOf } from '#lib/server/billing/gate';
import { currentSpaceScope } from '#lib/server/spaces/current';
import type { RequestHandler } from './$types';

/**
 * What the /agen page polls every 3 s while a run is unfinished (FN-23 red team S4): only the user's own runs in the
 * current space (listRuns, at most AGENT_LIVE_MAX rows, live membership in the same statement), never the period
 * scan or the AI key. Signed out: 404. Off the Agent plan: 403, and the page stops polling.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(404, 'Not found');
	const scope = await currentSpaceScope(locals);
	const now = Date.now();
	if (!agentEnabled(await planOf(locals.db, scope.userId, now))) error(403, AGENT_PLAN_ENDED);
	const runs = await listRuns(locals.db, scope, now);
	return json(
		{ runs, active: runs.some((r) => r.status === 'queued' || r.status === 'running') },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
