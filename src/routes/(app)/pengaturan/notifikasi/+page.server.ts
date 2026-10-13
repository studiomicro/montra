import { error, fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { devRoutesEnabled } from '#lib/server/dev';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { HOUR_INVALID, KIND_INVALID, PREFS_LOAD_FAILED } from '#lib/server/notifications/messages';
import {
	getCloseReminderHour,
	getNotificationPrefs,
	setCloseReminderHour,
	setNotificationPref
} from '#lib/server/notifications/repo';
import {
	NO_SUBSCRIPTIONS,
	PUSH_LOAD_FAILED,
	PUSH_NOT_CONFIGURED,
	SUBSCRIPTION_INVALID,
	SUBSCRIPTION_REFUSED
} from '#lib/server/push/messages';
import {
	listActiveSubscriptions,
	removeSubscription,
	upsertSubscription
} from '#lib/server/push/repo';
import { PushSendError, sendPushNotification } from '#lib/server/push/send';
import { ENDPOINT_MAX_LENGTH, parseSubscription } from '#lib/server/push/validation';
import { vapidKeys } from '#lib/server/push/vapid';
import { sha256Hex } from '#lib/server/util';
import { appName } from '#lib/shared/sanity';
import { createTranslator } from '#lib/shared/i18n';
import {
	CLOSE_REMINDER_DEFAULT_HOUR,
	isNotificationKind,
	parseReminderHour,
	prefsFrom
} from '#lib/shared/notifications';
import { normalizePushEndpoint } from '#lib/shared/push';
import type { Actions, PageServerLoad } from './$types';

// Push subscriptions belong to the signed-in user (locals.user) and this device's session, never to a space
// and never to an id from the request: every query is scoped `user_id = locals.user.id`. hooks.server.ts
// answers signed-out requests first; the checks below only narrow the type and fail closed.

const devTools = () => devRoutesEnabled(getEnv() as { DEV_ROUTES?: string }, dev);

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fpengaturan%2Fnotifikasi');
	const keys = vapidKeys(getEnv());
	// FN-24: which kinds this user wants (in-app and push alike); shown and saved even without VAPID keys.
	// FN-34b: plus the evening reminder's WIB hour (the default when none is stored).
	const prefs = await Promise.all([
		getNotificationPrefs(locals.db, user.id),
		getCloseReminderHour(locals.db, user.id)
	])
		.then(([p, hour]) => ({ prefs: p, closeReminderHour: hour, prefsError: null }))
		.catch((e) => {
			console.error('pengaturan/notifikasi: prefs load failed', e);
			return {
				prefs: prefsFrom([]),
				closeReminderHour: CLOSE_REMINDER_DEFAULT_HOUR,
				prefsError: PREFS_LOAD_FAILED
			};
		});
	const base = {
		configured: keys !== null,
		// Public by design: the browser needs it as `applicationServerKey`. The private key never leaves the server.
		publicKey: keys?.publicKey ?? null,
		devTools: devTools(),
		...prefs
	};
	try {
		const rows = await listActiveSubscriptions(locals.db, user.id, Date.now());
		// Hashes only: the page matches its own endpoint without seeing the user's other devices' endpoints.
		const endpointHashes = await Promise.all(rows.map((r) => sha256Hex(r.endpoint)));
		return { ...base, endpointHashes, loadError: null };
	} catch (e) {
		console.error('pengaturan/notifikasi: load failed', e);
		return { ...base, endpointHashes: [] as string[], loadError: PUSH_LOAD_FAILED };
	}
};

export const actions: Actions = {
	/** FN-24: one kind on or off for this user (`enabled=on` on, missing off). Default (no row) is on. */
	setPref: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const kind = textField(form, 'kind');
		if (!isNotificationKind(kind)) return fail(400, { prefError: KIND_INVALID });
		const enabled = textField(form, 'enabled') === 'on';
		await setNotificationPref(locals.db, user.id, kind, enabled, Date.now());
		return { savedPref: kind, enabled };
	},

	/**
	 * FN-34b: the WIB hour of the signed-in user's own evening reminder. A whole hour 06–23 only: anything else is
	 * refused (400) and the stored hour stays as it was, never clamped. No id is read from the form.
	 */
	setReminderHour: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const hour = parseReminderHour(textField(form, 'hour'));
		if (hour === null) return fail(400, { hourError: HOUR_INVALID });
		await setCloseReminderHour(locals.db, user.id, hour, Date.now());
		return { savedHour: hour };
	},

	/** Stores this browser's PushSubscription (endpoint, p256dh, auth) for the signed-in user. */
	subscribe: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = locals.user;
		if (!user || !locals.sessionToken) redirect(303, '/masuk');
		if (!vapidKeys(getEnv())) return fail(503, { error: PUSH_NOT_CONFIGURED });
		const input = parseSubscription(
			{
				endpoint: textField(form, 'endpoint'),
				p256dh: textField(form, 'p256dh'),
				auth: textField(form, 'auth')
			},
			request.headers.get('user-agent')
		);
		if (!input) return fail(400, { error: SUBSCRIPTION_INVALID });
		const written = await upsertSubscription(
			locals.db,
			{ userId: user.id, sessionToken: locals.sessionToken },
			input,
			Date.now()
		);
		if (!written) return fail(409, { error: SUBSCRIPTION_REFUSED });
		return { subscribed: true };
	},

	/**
	 * Removes this browser's subscription. Scoped to the user, so another user's endpoint matches nothing; a
	 * missing and a foreign endpoint get the same answer (no existence oracle).
	 */
	unsubscribe: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const raw = textField(form, 'endpoint');
		// Compared in its stored (normalised) form, so a case or :443 variant names the same row.
		const endpoint = raw.length <= ENDPOINT_MAX_LENGTH ? normalizePushEndpoint(raw) : null;
		if (!endpoint) return fail(400, { error: SUBSCRIPTION_INVALID });
		await removeSubscription(locals.db, user.id, endpoint, Date.now());
		return { unsubscribed: true };
	},

	/** Dev only (`vite dev` or DEV_ROUTES=1): one test notification to each of the user's own devices. */
	sendTestPush: async ({ request, locals }) => {
		if (!devTools()) error(404, 'Not found');
		await readFormBody(request);
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const keys = vapidKeys(getEnv());
		if (!keys) return fail(503, { error: PUSH_NOT_CONFIGURED });
		const subscriptions = await listActiveSubscriptions(locals.db, user.id, Date.now());
		if (subscriptions.length === 0) return fail(400, { error: NO_SUBSCRIPTIONS });
		const { tr } = createTranslator(locals.locale);
		const payload = {
			title: appName(),
			body: tr('Notifikasi uji: notifikasi di perangkat ini berfungsi.'),
			url: '/pengaturan/notifikasi'
		};
		const results: ('sent' | 'expired' | 'failed')[] = [];
		for (const subscription of subscriptions) {
			try {
				results.push(await sendPushNotification(locals.db, subscription, payload, keys));
			} catch (e) {
				// Status only: the endpoint is a capability URL and never logged or shown.
				console.warn('sendTestPush: failed', e instanceof PushSendError ? e.status : 'network');
				results.push('failed');
			}
		}
		return { testResults: results };
	}
};
