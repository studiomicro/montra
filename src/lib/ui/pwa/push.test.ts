import { describe, expect, it } from 'vitest';
import { sha256Hex } from '#lib/server/util';
import type { IosBrowser } from '#lib/shared/user-agent';
import { endpointHash, pushSupport } from './push';

describe('pushSupport', () => {
	const ios = (iosBrowser: IosBrowser, standalone: boolean, hasPushApi: boolean) =>
		pushSupport({ os: 'ios', iosBrowser, standalone, hasPushApi });

	it('iOS Safari outside the home-screen app must install first, whatever the APIs say', () => {
		expect(ios('safari', false, true)).toBe('ios-needs-install');
		expect(ios('safari', false, false)).toBe('ios-needs-install');
	});
	it('an iOS browser that is not Safari is sent to Safari first', () => {
		for (const browser of ['chrome', 'firefox', 'edge', 'other'] as const) {
			expect(ios(browser, false, true), browser).toBe('ios-open-in-safari');
			expect(ios(browser, false, false), browser).toBe('ios-open-in-safari');
		}
	});
	it('an installed iOS app follows the Push API; without it the iOS is too old', () => {
		expect(ios('safari', true, true)).toBe('supported');
		expect(ios('safari', true, false)).toBe('ios-too-old');
		expect(ios('chrome', true, false)).toBe('ios-too-old');
	});
	it('Android and desktop follow the Push API, installed or not', () => {
		const other = { iosBrowser: null, standalone: false } as const;
		expect(pushSupport({ os: 'android', ...other, hasPushApi: true })).toBe('supported');
		expect(pushSupport({ os: 'android', ...other, hasPushApi: false })).toBe('unsupported');
		expect(pushSupport({ os: 'other', ...other, hasPushApi: false })).toBe('unsupported');
		expect(
			pushSupport({ os: 'other', iosBrowser: null, standalone: true, hasPushApi: false })
		).toBe('unsupported');
	});
});

describe('endpointHash', () => {
	it('equals the server-side hash the notification page compares against', async () => {
		const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def';
		expect(await endpointHash(endpoint)).toBe(await sha256Hex(endpoint));
	});
});
