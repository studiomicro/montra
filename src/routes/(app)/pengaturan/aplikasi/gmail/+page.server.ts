import { fail, redirect } from '@sveltejs/kit';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { gmailLookbackMaxDays, planOf } from '#lib/server/billing/gate';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField, idField } from '#lib/server/forms';
import {
	gmailMissing,
	gmailOAuthConfig,
	gmailTesting,
	type GmailAppEnv,
	type GmailMissing
} from '#lib/server/gmail/config';
import { takeGmailResult } from '#lib/server/gmail/flash';
import { googleClient } from '#lib/server/gmail/google';
import {
	GMAIL_ALREADY_CONNECTED,
	GMAIL_AUTOSAVE_SPACE,
	GMAIL_AUTOSAVE_WALLET,
	GMAIL_NOTIFY_CHANGED,
	GMAIL_CALLBACK_RESULTS,
	GMAIL_CHANGED_MEANWHILE,
	GMAIL_CHECK_RECENT,
	GMAIL_LOAD_FAILED,
	GMAIL_LOOKBACK_INVALID,
	GMAIL_LOOKBACK_LIMIT,
	GMAIL_LOOKBACK_PLAN,
	GMAIL_LOOKBACK_RUNNING,
	GMAIL_MISSING_CLIENT,
	GMAIL_MISSING_KEY,
	GMAIL_MISSING_REDIRECT,
	GMAIL_NEEDS_RECONNECT,
	GMAIL_NOT_CONFIGURED,
	GMAIL_NOT_CONNECTED,
	GMAIL_QUEUE_FAILED,
	GMAIL_RATE_LIMITED,
	GMAIL_SESSION_REQUIRED,
	GMAIL_SPACE_NOT_AVAILABLE
} from '#lib/server/gmail/messages';
import { revokeGmailToken, startGmailConnect } from '#lib/server/gmail/oauth';
import {
	cancelLookback,
	deleteConnection,
	dropScan,
	getConnection,
	openScan,
	requeueRereadable,
	sealedTokenOf,
	setAutoCheck,
	setAutoSave,
	setConnectionSpace,
	type ConnectionRef,
	type ConnectionWriteResult
} from '#lib/server/gmail/repo';
import { listSpaces } from '#lib/server/spaces/spaces';
import { listWallets } from '#lib/server/wallets/repo';
import {
	getNotificationPrefs,
	notificationPrefVersion,
	setNotificationPrefIfUnchanged
} from '#lib/server/notifications/repo';
import { SENDER_DOMAINS } from '#lib/shared/inbound/sender-domains';
import { errorLabel } from '#lib/server/util';
import { wibDateString, wibTimeString } from '#lib/shared/dates';
import {
	GMAIL_CHECK_NOW_MINUTES,
	GMAIL_AUTOSAVE_SETTING_PER_WINDOW,
	GMAIL_NOTIFY_SETTING_PER_WINDOW,
	GMAIL_CONNECTS_PER_WINDOW,
	GMAIL_SCAN_ACTIONS_PER_WINDOW
} from '#lib/shared/gmail/ledger';
import { lookbackAllowed, lookbackDaysOf } from '#lib/shared/gmail/lookback';
import type { JobMessage } from '#lib/shared/jobs';
import type { Actions, PageServerLoad } from './$types';

// FN-19 Gmail (docs/features/fn-19-gmail/PRD.md § 1–8). Account-level like /pengaturan/aplikasi/email: every load
// and action works on the session user's own connection only (`user_id = locals.user.id` is repeated in every
// statement, so another user's connection or scan id reads exactly like a missing one). A target space is accepted
// only while the user is a live member of it, checked inside the write. The token, the client secret, the code,
// the verifier and the state never reach page data, a form result or a log line.

function signedIn(locals: App.Locals) {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	return user;
}

const env = () => getEnv() as GmailAppEnv & { JOBS_QUEUE: Queue };

const MISSING_TEXT: Readonly<Record<GmailMissing, string>> = {
	client: GMAIL_MISSING_CLIENT,
	redirect: GMAIL_MISSING_REDIRECT,
	key: GMAIL_MISSING_KEY
};

export const load: PageServerLoad = async ({ locals, cookies }) => {
	const user = signedIn(locals);
	const missing = gmailMissing(env());
	const result = takeGmailResult(cookies, locals.secure);
	const base = {
		configured: missing.length === 0,
		missing: missing.map((m) => MISSING_TEXT[m]),
		testing: gmailTesting(env()),
		result: result ? GMAIL_CALLBACK_RESULTS[result] : null,
		resultOk: result === 'connected'
	};
	try {
		const now = Date.now();
		const [connection, spaces, plan, prefs, notifyVersion] = await Promise.all([
			getConnection(locals.db, user.id, now),
			listSpaces(locals.db, user.id),
			planOf(locals.db, user.id, now),
			getNotificationPrefs(locals.db, user.id),
			notificationPrefVersion(locals.db, user.id, 'gmail_payment')
		]);
		// FN-19b: the target space's live IDR wallets for "Simpan ke dompet" (only while the user is a member).
		const wallets =
			connection && connection.spaceName !== null
				? (await listWallets(locals.db, connection.spaceId))
						.filter((w) => w.currency === 'IDR')
						.map((w) => ({ id: w.id, name: w.name }))
				: [];
		return {
			...base,
			connection,
			spaces: spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
			wallets,
			confirmedSenders: SENDER_DOMAINS.length,
			// FN-19b "Beri tahu di perangkat ini": the same preference as the /pengaturan/notifikasi row.
			notify: prefs.gmail_payment,
			notifyVersion,
			lookbackMax: gmailLookbackMaxDays(plan),
			loadError: null
		};
	} catch (e) {
		console.error('pengaturan/aplikasi/gmail: load failed', errorLabel(e));
		return {
			...base,
			connection: null,
			spaces: [],
			wallets: [],
			confirmedSenders: SENDER_DOMAINS.length,
			notify: true,
			notifyVersion: 0,
			lookbackMax: 0,
			loadError: GMAIL_LOAD_FAILED
		};
	}
};

/** The connection ref of a form: its id and the `updated_at` the page showed ("changed meanwhile" otherwise). */
function connectionRef(form: FormData): ConnectionRef | null {
	const id = idField(form, 'connectionId');
	const updatedAt = Number(textField(form, 'updatedAt'));
	return id && Number.isSafeInteger(updatedAt) && updatedAt > 0 ? { id, updatedAt } : null;
}

function answer(result: ConnectionWriteResult, done: string) {
	if (result === 'missing') return fail(404, { error: GMAIL_NOT_CONNECTED });
	if (result === 'stale') return fail(409, { error: GMAIL_CHANGED_MEANWHILE });
	return { done };
}

const LIMITS = {
	'gmail-connect': GMAIL_CONNECTS_PER_WINDOW,
	'gmail-scan': GMAIL_SCAN_ACTIONS_PER_WINDOW,
	'gmail-autosave-setting': GMAIL_AUTOSAVE_SETTING_PER_WINDOW,
	'gmail-notify-setting': GMAIL_NOTIFY_SETTING_PER_WINDOW
} as const;

const overLimit = (locals: App.Locals, userId: string, scope: keyof typeof LIMITS) =>
	overUserAttemptLimit(locals.db, userId, Date.now(), scope, LIMITS[scope]);

/** Sends job messages, at most 100 per Queues `sendBatch`. */
async function enqueue(messages: JobMessage[]): Promise<void> {
	for (let i = 0; i < messages.length; i += 100)
		await env().JOBS_QUEUE.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })));
}

/** The 5-minute bucket of "Periksa sekarang" (WIB), the window of its scan: one manual check per bucket. */
function checkNowWindow(now: number): string {
	const time = wibTimeString(now);
	const minute = Number(time.slice(3, 5));
	const bucket = String(minute - (minute % GMAIL_CHECK_NOW_MINUTES)).padStart(2, '0');
	return `${wibDateString(now)}T${time.slice(0, 2)}:${bucket}`;
}

/**
 * Enqueues the first page of the scan just opened; when the queue refuses, the scan is dropped again (so a retry
 * may open it) and false is returned.
 */
async function startScan(
	locals: App.Locals,
	userId: string,
	scanId: string,
	scan: { connectionId: string; kind: 'hourly' | 'lookback'; window: string }
): Promise<boolean> {
	try {
		await enqueue([{ type: 'gmail_check', ...scan, page: 0 }]);
		return true;
	} catch (e) {
		console.error('pengaturan/aplikasi/gmail: enqueue failed', errorLabel(e));
		await dropScan(locals.db, userId, scanId);
		return false;
	}
}

export const actions: Actions = {
	/**
	 * "Hubungkan" / "Hubungkan ulang": answers with the authorization URL as page data (a plain "Lanjut ke Google"
	 * link), never a 303 to Google (CSP `form-action 'self'` may block a cross-origin redirect of a form post).
	 */
	connect: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const cfg = gmailOAuthConfig(env());
		if (!cfg) return fail(503, { error: GMAIL_NOT_CONFIGURED });
		if (!locals.sessionToken) return fail(401, { error: GMAIL_SESSION_REQUIRED });
		const existing = await getConnection(locals.db, user.id, Date.now());
		if (existing?.status === 'connected') return fail(409, { error: GMAIL_ALREADY_CONNECTED });
		const spaceId = idField(form, 'spaceId') || locals.space?.id || '';
		const spaces = await listSpaces(locals.db, user.id);
		if (!spaces.some((s) => s.id === spaceId))
			return fail(404, { error: GMAIL_SPACE_NOT_AVAILABLE });
		if (await overLimit(locals, user.id, 'gmail-connect'))
			return fail(429, { error: GMAIL_RATE_LIMITED });
		const started = await startGmailConnect(
			locals.db,
			env(),
			cfg,
			{ userId: user.id, sessionToken: locals.sessionToken, spaceId },
			Date.now()
		);
		if (started.kind !== 'ok')
			return started.kind === 'key'
				? fail(503, { error: GMAIL_NOT_CONFIGURED })
				: fail(404, { error: GMAIL_SPACE_NOT_AVAILABLE });
		return { authUrl: started.url };
	},

	/**
	 * "Putuskan Gmail": revoke at Google first (with the refresh token), then delete locally REGARDLESS of the
	 * revoke result; the page says when Google could not be reached. Works even when no longer configured.
	 */
	disconnect: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const ref = connectionRef(form);
		if (!ref) return fail(404, { error: GMAIL_NOT_CONNECTED });
		const stored = await sealedTokenOf(locals.db, user.id);
		if (!stored || stored.id !== ref.id) return fail(404, { error: GMAIL_NOT_CONNECTED });
		if (stored.updatedAt !== ref.updatedAt) return fail(409, { error: GMAIL_CHANGED_MEANWHILE });
		const revoked = await revokeGmailToken(locals.db, env(), googleClient(), user.id);
		if (!(await deleteConnection(locals.db, user.id, stored.id, Date.now())))
			return fail(404, { error: GMAIL_NOT_CONNECTED });
		return { done: revoked ? 'disconnected' : 'disconnected_local' };
	},

	/** "Dicatat ke": a space the user is a live member of; any other id gets the same refusal. */
	target: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const ref = connectionRef(form);
		if (!ref) return fail(404, { error: GMAIL_NOT_CONNECTED });
		const spaceId = idField(form, 'spaceId');
		const spaces = await listSpaces(locals.db, user.id);
		if (!spaces.some((s) => s.id === spaceId))
			return fail(404, { error: GMAIL_SPACE_NOT_AVAILABLE });
		return answer(await setConnectionSpace(locals.db, user.id, ref, spaceId, Date.now()), 'moved');
	},

	/** "Periksa otomatis" on or off. */
	autoCheck: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const ref = connectionRef(form);
		if (!ref) return fail(404, { error: GMAIL_NOT_CONNECTED });
		const on = textField(form, 'on') === '1';
		return answer(
			await setAutoCheck(locals.db, user.id, ref, on, Date.now()),
			on ? 'auto_on' : 'auto_off'
		);
	},

	/**
	 * FN-19b "Simpan otomatis": on with a live IDR wallet of the target space, or off. Success only after the
	 * guarded write; a stale page answers "changed meanwhile".
	 */
	autoSave: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const ref = connectionRef(form);
		if (!ref) return fail(404, { error: GMAIL_NOT_CONNECTED });
		const on = textField(form, 'on') === '1';
		const walletId = idField(form, 'walletId');
		if (on && !walletId) return fail(400, { error: GMAIL_AUTOSAVE_WALLET });
		if (await overLimit(locals, user.id, 'gmail-autosave-setting'))
			return fail(429, { error: GMAIL_RATE_LIMITED });
		const result = await setAutoSave(
			locals.db,
			user.id,
			ref,
			on ? { on: true, walletId } : { on: false },
			Date.now()
		);
		if (result === 'wallet') return fail(400, { error: GMAIL_AUTOSAVE_WALLET });
		if (result === 'space') return fail(403, { error: GMAIL_AUTOSAVE_SPACE });
		return answer(result, on ? 'autosave_on' : 'autosave_off');
	},

	/**
	 * FN-19b "Beri tahu di perangkat ini": the `gmail_payment` notification preference (one source of truth with
	 * /pengaturan/notifikasi). Pushes still need this device's opt-in there.
	 */
	notify: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const on = textField(form, 'on') === '1';
		const version = textField(form, 'version');
		const expected = /^\d{1,16}$/.test(version) ? Number(version) : -1;
		if (await overLimit(locals, user.id, 'gmail-notify-setting'))
			return fail(429, { error: GMAIL_RATE_LIMITED });
		const result =
			expected < 0
				? 'stale'
				: await setNotificationPrefIfUnchanged(
						locals.db,
						user.id,
						'gmail_payment',
						on,
						expected,
						Date.now()
					);
		if (result === 'stale') return fail(409, { error: GMAIL_NOTIFY_CHANGED });
		return { done: on ? 'notify_on' : 'notify_off' };
	},

	/** "Periksa sekarang": one hourly-kind check now, at most one per 5-minute bucket. */
	checkNow: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const connectionId = idField(form, 'connectionId');
		if (await overLimit(locals, user.id, 'gmail-scan'))
			return fail(429, { error: GMAIL_RATE_LIMITED });
		const now = Date.now();
		const window = checkNowWindow(now);
		const opened = await openScan(
			locals.db,
			{ userId: user.id, connectionId, kind: 'hourly', window, days: null, afterS: null },
			now
		);
		if (opened.kind === 'exists') return fail(429, { error: GMAIL_CHECK_RECENT });
		if (opened.kind !== 'opened') return fail(404, { error: GMAIL_NOT_CONNECTED });
		if (
			!(await startScan(locals, user.id, opened.scanId, { connectionId, kind: 'hourly', window }))
		)
			return fail(503, { error: GMAIL_QUEUE_FAILED });
		return { done: 'checking' };
	},

	/** "Pindai sekarang": a look-back scan within the plan's limit (re-read here; a forged value is refused). */
	lookback: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const connectionId = idField(form, 'connectionId');
		const days = lookbackDaysOf(textField(form, 'days'));
		if (days === null) return fail(400, { error: GMAIL_LOOKBACK_INVALID });
		const now = Date.now();
		if (!lookbackAllowed(days, gmailLookbackMaxDays(await planOf(locals.db, user.id, now))))
			return fail(403, { error: GMAIL_LOOKBACK_PLAN });
		if (await overLimit(locals, user.id, 'gmail-scan'))
			return fail(429, { error: GMAIL_RATE_LIMITED });
		const window = `lb-${now}`;
		const opened = await openScan(
			locals.db,
			{
				userId: user.id,
				connectionId,
				kind: 'lookback',
				window,
				days,
				afterS: Math.floor(now / 1000) - days * 24 * 60 * 60
			},
			now
		);
		if (opened.kind === 'running' || opened.kind === 'exists')
			return fail(409, { error: GMAIL_LOOKBACK_RUNNING });
		if (opened.kind === 'limit') return fail(429, { error: GMAIL_LOOKBACK_LIMIT });
		if (opened.kind !== 'opened') return fail(404, { error: GMAIL_NOT_CONNECTED });
		if (
			!(await startScan(locals, user.id, opened.scanId, { connectionId, kind: 'lookback', window }))
		)
			return fail(503, { error: GMAIL_QUEUE_FAILED });
		return { done: 'scanning' };
	},

	/** "Hentikan": the running look-back stops reading. */
	stopLookback: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const scanId = idField(form, 'scanId');
		if (!(await cancelLookback(locals.db, user.id, scanId, Date.now())))
			return fail(404, { error: GMAIL_NOT_CONNECTED });
		return { done: 'stopped' };
	},

	/** "Baca ulang yang tertunda": payment mail left unread for want of an AI key is read again from Gmail. */
	reread: async ({ request, locals }) => {
		await readFormBody(request);
		const user = signedIn(locals);
		if (await overLimit(locals, user.id, 'gmail-scan'))
			return fail(429, { error: GMAIL_RATE_LIMITED });
		const connection = await getConnection(locals.db, user.id, Date.now());
		if (!connection) return fail(404, { error: GMAIL_NOT_CONNECTED });
		if (connection.status !== 'connected') return fail(409, { error: GMAIL_NEEDS_RECONNECT });
		const ids = await requeueRereadable(locals.db, user.id, Date.now());
		try {
			await enqueue(ids.map((mailId) => ({ type: 'gmail_read', mailId })));
		} catch (e) {
			// The rows are `listed` again: the jobs Worker's sweep enqueues them within the hour.
			console.error('pengaturan/aplikasi/gmail: enqueue failed', errorLabel(e));
		}
		return { done: 'rereading', count: ids.length };
	}
};
