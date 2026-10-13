import { json } from '@sveltejs/kit';
import { overUserAttemptLimit, retryAfterSeconds } from '#lib/server/auth/throttle';
import { readRawBody } from '#lib/server/forms';
import { pushQueuedWrite, SYNC_PUSH_MAX_PER_WINDOW } from '#lib/server/sync/push';
import { SESSION_ENDED } from '#lib/server/auth/gate';
import { PUSH_BODY_MAX_BYTES, type PushResponse } from '#lib/shared/offline-queue';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

const reply = (
	status: number,
	body: PushResponse | { message: string },
	headers: Record<string, string> = {}
) => json(body, { status, headers: { ...NO_STORE, ...headers } });

/**
 * FN-02: the device's offline queue sends one queued write here (JSON, one item per request), once it is online.
 * Checked in this order, each before the next touches anything:
 * 1. `Origin` equals this origin (403). SvelteKit's own CSRF check covers form content types only, so a JSON
 *    POST to a +server.ts route needs its own; a missing Origin is refused too.
 * 2. A session (401 `session`: the device pauses its whole queue until the user signs in again), then the
 *    per-user budget SYNC_PUSH_MAX_PER_WINDOW (429 with Retry-After; the device keeps the item and waits).
 * 3. `application/json` (415) within PUSH_BODY_MAX_BYTES (413), parseable (400).
 * Then `pushQueuedWrite` re-authorises the item's own space for the session's user; a creating item past the
 * per-user creation budget is answered 429 with Retry-After like the push budget.
 */
export const POST: RequestHandler = async ({ request, url, locals }) => {
	if (request.headers.get('origin') !== url.origin) return reply(403, { message: 'Forbidden' });
	const user = locals.user;
	if (!user) return reply(401, { clientId: null, result: 'session', message: SESSION_ENDED });
	const now = Date.now();
	if (await overUserAttemptLimit(locals.db, user.id, now, 'sync-push', SYNC_PUSH_MAX_PER_WINDOW)) {
		return reply(
			429,
			{ message: 'Too many requests' },
			{ 'retry-after': String(retryAfterSeconds(now)) }
		);
	}
	const type = request.headers.get('content-type') ?? '';
	if (type.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
		return reply(415, { message: 'Unsupported content type' });
	const bytes = await readRawBody(request, PUSH_BODY_MAX_BYTES);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return reply(400, { clientId: null, result: 'invalid' });
	}
	// Amounts are read with the UI language the item was queued in (its `locale`, FN-47); an item queued
	// without one falls back to the session's language (see `locale` in shared/offline-queue.ts).
	const outcome = await pushQueuedWrite(locals.db, user.id, value, now, locals.locale);
	// Over the per-user creation budget (transactions/create-limit.ts): the device keeps the item and waits.
	return reply(
		outcome.status,
		outcome.body,
		outcome.status === 429 ? { 'retry-after': String(retryAfterSeconds(now)) } : {}
	);
};
