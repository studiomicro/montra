import { base64urlDecode } from '../../shared/base64url.ts';
import { normalizePushEndpoint } from '../../shared/push.ts';
import { cleanText } from '../../shared/text.ts';
import { AUTH_SECRET_BYTES, P256_PUBLIC_KEY_BYTES } from './encrypt';

/** Longest endpoint stored (real ones are a few hundred characters). */
export const ENDPOINT_MAX_LENGTH = 1024;
/** Stored user-agent text is a device hint only. */
export const USER_AGENT_MAX_LENGTH = 200;

/**
 * Hosts of the browsers' own push services: Chrome and other Chromium browsers (FCM), Firefox (Mozilla
 * autopush), Edge (WNS) and Safari (Apple). The Worker POSTs to a stored endpoint, so an endpoint anywhere else
 * is refused: a subscription can never make the server send requests to an arbitrary host.
 */
const PUSH_HOSTS = [
	/^fcm\.googleapis\.com$/,
	/^android\.googleapis\.com$/,
	/^updates\.push\.services\.mozilla\.com$/,
	/^[a-z0-9-]+\.notify\.windows\.com$/,
	/^web\.push\.apple\.com$/
];

/**
 * True for a normalised endpoint (normalizePushEndpoint: https, default port, no credentials) on a known push
 * service host. Stored rows are normalised, so send.ts re-checks them with this too.
 */
export function isPushEndpoint(endpoint: string): boolean {
	if (endpoint.length === 0 || endpoint.length > ENDPOINT_MAX_LENGTH) return false;
	if (normalizePushEndpoint(endpoint) !== endpoint) return false;
	const host = new URL(endpoint).hostname;
	return PUSH_HOSTS.some((pattern) => pattern.test(host));
}

/** The normalised form of a posted endpoint, or null when it is not a known push-service endpoint. */
export function pushEndpointFrom(raw: string): string | null {
	if (raw.length === 0 || raw.length > ENDPOINT_MAX_LENGTH) return null;
	const endpoint = normalizePushEndpoint(raw);
	return endpoint && isPushEndpoint(endpoint) ? endpoint : null;
}

export interface SubscriptionInput {
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent: string | null;
}

/**
 * The subscription a browser posted (`PushSubscription.toJSON()`: endpoint, keys.p256dh, keys.auth), or null
 * when any part is malformed: a known push-service endpoint (stored normalised), a 65-octet uncompressed P-256 key and a
 * 16-octet auth secret, both base64url.
 */
export function parseSubscription(
	fields: { endpoint: string; p256dh: string; auth: string },
	userAgent: string | null
): SubscriptionInput | null {
	const { p256dh, auth } = fields;
	const endpoint = pushEndpointFrom(fields.endpoint);
	if (!endpoint) return null;
	if (p256dh.length > 128 || auth.length > 64) return null;
	const key = base64urlDecode(p256dh);
	const secret = base64urlDecode(auth);
	if (!key || key.length !== P256_PUBLIC_KEY_BYTES || key[0] !== 0x04) return null;
	if (!secret || secret.length !== AUTH_SECRET_BYTES) return null;
	const ua = userAgent ? cleanText(userAgent, USER_AGENT_MAX_LENGTH) : '';
	return { endpoint, p256dh, auth, userAgent: ua || null };
}
