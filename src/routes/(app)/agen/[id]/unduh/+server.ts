import { error } from '@sveltejs/kit';
import { AGENT_FILE_CSP, CONTENT_TYPES } from '#lib/server/agent/files';
import { AGENT_PLAN_ENDED } from '#lib/server/agent/messages';
import { getReadyRun, runSpaceId } from '#lib/server/agent/repo';
import { agentEnabled, planOf } from '#lib/server/billing/gate';
import { getEnv } from '#lib/server/env';
import { requireSpaceAccess } from '#lib/server/spaces/access';
import { AGENT_FILE_SLUGS, AGENT_FORMATS, type AgentFormat } from '#lib/shared/agent';
import type { RequestHandler } from './$types';

/**
 * A ready Agen report's file (FN-23), the only way to read it: the bucket is never public. Signed out: 404. Off the
 * Agent plan: 403 "Paket Agen berakhir" for every id (asked before any lookup, so it says nothing about the id).
 * The run's space goes through `requireSpaceAccess` (an unknown or foreign id asks about the space '' and gets the
 * same 404 with the same body), then the read repeats (id, user, space), `ready`, unexpired and live membership in
 * one statement; the R2 key comes from that row only. A missing object answers the same 404. Always an
 * attachment, with a fixed type, `nosniff`, no caching and a script-free sandbox CSP.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const user = locals.user;
	if (!user) error(404, 'Not found');
	const now = Date.now();
	if (!agentEnabled(await planOf(locals.db, user.id, now))) error(403, AGENT_PLAN_ENDED);
	const format = url.searchParams.get('format') ?? '';
	const id = params.id.slice(0, 64);
	const access = await requireSpaceAccess(
		locals.db,
		user.id,
		await runSpaceId(locals.db, user.id, id)
	);
	const run = await getReadyRun(locals.db, { spaceId: access.space.id, userId: user.id }, id, now);
	if (!run || !(AGENT_FORMATS as readonly string[]).includes(format)) error(404, 'Not found');
	const ext = format as AgentFormat;
	const object = await getEnv().FILES.get(ext === 'csv' ? run.csvKey : run.htmlKey);
	if (!object) error(404, 'Not found');
	// Built from the validated type and period only, never from user text.
	const filename = `montra-${AGENT_FILE_SLUGS[run.type]}-${run.period}.${ext}`;
	return new Response(object.body, {
		headers: {
			'content-type': CONTENT_TYPES[ext],
			'content-disposition': `attachment; filename="${filename}"`,
			'content-length': String(object.size),
			'x-content-type-options': 'nosniff',
			'cache-control': 'private, no-store',
			'content-security-policy': AGENT_FILE_CSP,
			'cross-origin-resource-policy': 'same-origin'
		}
	});
};
