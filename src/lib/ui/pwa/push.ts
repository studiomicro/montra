import { normalizePushEndpoint } from '#lib/shared/push';
import type { IosBrowser, MobileOs } from '#lib/shared/user-agent';

/**
 * Whether this device can turn on notifications here (FN-13, FN-13b):
 * - 'ios-needs-install': iPhone/iPad Safari grants notification permission only to an app opened from the
 *   home screen (iOS 16.4+), so the page asks to install first and never prompts;
 * - 'ios-open-in-safari': the same, but this iOS browser is not Safari, so installing starts in Safari;
 * - 'ios-too-old': the installed iOS app has no Push API (iOS below 16.4); feature detection, not a UA version;
 * - 'unsupported': no service worker, Push API or Notification API in this browser;
 * - 'supported'.
 */
export type PushSupport =
	'supported' | 'unsupported' | 'ios-needs-install' | 'ios-open-in-safari' | 'ios-too-old';

export function pushSupport(device: {
	os: MobileOs;
	iosBrowser: IosBrowser | null;
	standalone: boolean;
	hasPushApi: boolean;
}): PushSupport {
	if (device.os === 'ios' && !device.standalone)
		return device.iosBrowser === 'safari' || device.iosBrowser === null
			? 'ios-needs-install'
			: 'ios-open-in-safari';
	if (device.os === 'ios' && !device.hasPushApi) return 'ios-too-old';
	return device.hasPushApi ? 'supported' : 'unsupported';
}

/** True when the browser has everything Web Push needs. Browser only. */
export function hasPushApi(): boolean {
	return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * SHA-256 (hex) of a push endpoint: the page compares this browser's subscription with the hashes the server
 * lists, so endpoints of the user's other devices never reach the page.
 */
export async function endpointHash(endpoint: string): Promise<string> {
	// The server hashes the normalised form it stores; hash the same form here.
	const stored = normalizePushEndpoint(endpoint) ?? endpoint;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stored));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
