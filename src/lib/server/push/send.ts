import { base64urlDecode } from '../../shared/base64url.ts';
import type { PushPayload } from '../../shared/push.ts';
import type { Db } from '../db';
import { encryptPushPayload } from './encrypt';
import { removeSubscription, type ActiveSubscription } from './repo';
import { isPushEndpoint } from './validation';
import { vapidAuthorization, type VapidKeys } from './vapid';

/** How long a push service may hold an undelivered message (seconds). */
const TTL_SECONDS = 24 * 60 * 60;
/** How long the push service may take to answer. */
const SEND_TIMEOUT_MS = 10_000;

/** The push service refused the message for a reason other than an expired subscription. */
export class PushSendError extends Error {
	constructor(readonly status: number) {
		super(`push: the push service answered ${status}`);
	}
}

/**
 * Sends one notification to one subscription: the payload encrypted for it (RFC 8291) and signed for with
 * VAPID (RFC 8292). No dependency on a SvelteKit request, so the app Worker (dev test action) and later
 * `workers/jobs` (FN-19/FN-24 triggers) call it the same way.
 *
 * - 2xx → 'sent'.
 * - 404/410 (the browser dropped the subscription) → the row is tombstoned before returning 'expired', so a
 *   dead endpoint is never tried again.
 * - anything else, a 3xx redirect included (never followed) → PushSendError (the row stays; the caller
 *   decides whether to retry).
 */
export async function sendPushNotification(
	db: Db,
	subscription: Pick<ActiveSubscription, 'userId' | 'endpoint' | 'p256dh' | 'auth'>,
	payload: PushPayload,
	keys: VapidKeys,
	now: number = Date.now()
): Promise<'sent' | 'expired'> {
	const { endpoint } = subscription;
	// Rows are validated when stored; checked again so no stored value can make the Worker POST elsewhere.
	if (!isPushEndpoint(endpoint)) throw new Error('push: endpoint is not a known push service');
	const uaPublic = base64urlDecode(subscription.p256dh);
	const authSecret = base64urlDecode(subscription.auth);
	if (!uaPublic || !authSecret) throw new Error('push: stored subscription keys are malformed');

	const body = await encryptPushPayload(
		new Uint8Array(new TextEncoder().encode(JSON.stringify(payload))),
		uaPublic,
		authSecret
	);
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			authorization: await vapidAuthorization(endpoint, keys, now),
			'content-encoding': 'aes128gcm',
			'content-type': 'application/octet-stream',
			ttl: String(TTL_SECONDS),
			urgency: 'normal'
		},
		body,
		// Never follow a redirect: the allow-list was checked on this URL only (a 3xx is a failure below).
		redirect: 'manual',
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	// The body is never used; release it.
	await response.body?.cancel().catch(() => {});
	if (response.ok) return 'sent';
	if (response.status === 404 || response.status === 410) {
		await removeSubscription(db, subscription.userId, endpoint, now);
		return 'expired';
	}
	throw new PushSendError(response.status);
}
