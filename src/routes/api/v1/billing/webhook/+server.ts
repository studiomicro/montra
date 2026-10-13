import { error, json } from '@sveltejs/kit';
import { activeProvider } from '#lib/server/billing/provider';
import { processWebhook, WEBHOOK_BODY_MAX_BYTES } from '#lib/server/billing/webhook';
import { getEnv } from '#lib/server/env';
import { readRawBody } from '#lib/server/forms';
import type { RequestHandler } from './$types';

/**
 * FN-30 payment webhook (the mock provider only this pass). Signature-authenticated, not session-
 * authenticated: no cookie or user id from the request is ever used; the account comes from the stored
 * checkout the signed event names. Answers: 200 `{status}` for an accepted (or replayed) event, a fixed 401
 * for any signature problem (missing, malformed, wrong key, stale, or no provider configured), a fixed 400 for
 * a signed event we do not accept, 413/415 for an oversized or non-JSON body. Never stores the raw body.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const type = (request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
	if (type !== 'application/json') error(415, 'Unsupported content type');
	const body = await readRawBody(request, WEBHOOK_BODY_MAX_BYTES);
	const result = await processWebhook(
		locals.db,
		activeProvider(getEnv()),
		{ body, headers: request.headers },
		Date.now()
	);
	if (result.status === 401) error(401, 'Invalid signature');
	if (result.status !== 200) error(400, 'Invalid event');
	return json({ status: result.outcome }, { headers: { 'cache-control': 'no-store' } });
};
