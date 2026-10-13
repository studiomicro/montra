import { json } from '@sveltejs/kit';
import { overUserAttemptLimit, retryAfterSeconds } from '#lib/server/auth/throttle';
import { readFormBody } from '#lib/server/forms';
import { MERCHANT_SUGGESTS_PER_WINDOW, resolveMerchants } from '#lib/server/merchants/resolve';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { TITLE_MAX_LENGTH } from '#lib/shared/transactions';
import { VOICE_BATCH_MAX } from '#lib/shared/voice-parse';
import type { RequestHandler } from './$types';

/**
 * FN-20 suggestion for the manual form (`/riwayat/baru`, as the title is typed) and the voice review rows: up to
 * VOICE_BATCH_MAX (`title`, `type`) pairs → the cleaned merchant, a category of the current space and the reason
 * enum. Deterministic only (owner decision 11: no AI while typing). Session and space come from the request
 * (`currentSpaceScope`, the shared space-access helper); the form carries no space id. CSRF is checked for every
 * POST by hooks.server.ts; the body goes through the shared form guard (size cap, 400/415, never 500). Counted per
 * user before the body is read or any history row (scope 'merchant-suggest'); over the budget it answers 429 with
 * Retry-After, which the form treats as "no suggestion" (FN-20 red team L1).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const scope = await currentSpaceScope(locals);
	const now = Date.now();
	if (
		await overUserAttemptLimit(
			locals.db,
			scope.userId,
			now,
			'merchant-suggest',
			MERCHANT_SUGGESTS_PER_WINDOW
		)
	)
		return json(
			{ message: 'Too many requests' },
			{
				status: 429,
				headers: { 'retry-after': String(retryAfterSeconds(now)), 'cache-control': 'no-store' }
			}
		);
	const form = await readFormBody(request);
	const titles = form.getAll('title');
	const types = form.getAll('type');
	const items = titles.slice(0, VOICE_BATCH_MAX).map((t, i) => ({
		rawText: typeof t === 'string' ? t.slice(0, TITLE_MAX_LENGTH * 4) : '',
		type: types[i] === 'income' ? ('income' as const) : ('expense' as const)
	}));
	const { items: resolved } = await resolveMerchants(locals.db, scope, items, {
		userId: scope.userId,
		allowAi: false
	});
	return json(
		{
			items: resolved.map((r) => ({
				// The chip is tap-to-apply, so it may offer the AI-recognised name (owner decision 2026-10-13).
				merchant: r.suggestedName ?? r.merchant,
				categoryId: r.categoryId,
				reason: r.reason
			}))
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
