import { error } from '@sveltejs/kit';
import { TRACK_MAX_PER_WINDOW, trackContext, trackEvent } from '#lib/server/analytics/track';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { readFormBody, textField } from '#lib/server/forms';
import { isStatAction, isStatScreen } from '#lib/shared/privacy';
import type { RequestHandler } from './$types';

/** A screen and an action name from the fixed vocabulary are a few dozen bytes; anything bigger is refused. */
const TRACK_BODY_MAX_BYTES = 256;
const TRACK_BODY_TIMEOUT_MS = 2_000;

/**
 * The browser's usage-statistics beacon (FN-31): `screen` and `action`, form-encoded (navigator.sendBeacon),
 * so SvelteKit's same-origin form check applies. Both names must be in the fixed vocabulary (400 otherwise:
 * no free text ever reaches a statistic). The answer is an empty 200 whether or not anything was counted —
 * `trackEvent` alone decides (signed in, statistics on, served through Cloudflare) — so the page never
 * learns or depends on it. A signed-in account past TRACK_MAX_PER_WINDOW beacons in the throttle window
 * (or a throttle that cannot count) gets the same empty 200 and nothing is written.
 */
export const POST: RequestHandler = async (event) => {
	const form = await readFormBody(event.request, TRACK_BODY_MAX_BYTES, TRACK_BODY_TIMEOUT_MS);
	const screen = textField(form, 'screen');
	const action = textField(form, 'action');
	if (!isStatScreen(screen) || !isStatAction(action)) error(400, 'Unknown event');
	const userId = event.locals.user?.id;
	const limited =
		userId !== undefined &&
		(await overUserAttemptLimit(
			event.locals.db,
			userId,
			Date.now(),
			'track',
			TRACK_MAX_PER_WINDOW
		));
	if (!limited) await trackEvent(trackContext(event), { screen, action });
	return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
};
