import { fail, redirect } from '@sveltejs/kit';
import { trackContext, trackEvent } from '#lib/server/analytics/track';
import { accountKeyMaterial, getAccountKey } from '#lib/server/account-keys/repo';
import {
	EMAIL_MAX_LENGTH,
	PASSWORD_MAX_LENGTH,
	signInWithPassword
} from '#lib/server/auth/password';
import {
	BOT_CHECK_FAILED,
	FIELDS_REQUIRED,
	INVALID_CREDENTIALS,
	PASSKEY_HOST_UNAVAILABLE,
	PASSKEY_SIGN_IN_FAILED,
	TOO_MANY_ATTEMPTS
} from '#lib/server/auth/messages';
import {
	checkSignIn,
	passkeyOrigin,
	passkeyRpId,
	readAssertionForm,
	signInOptions
} from '#lib/server/auth/passkey-flow';
import {
	createPasskeySession,
	createPasswordSession,
	revokeSession,
	setSessionCookie
} from '#lib/server/auth/session';
import { overAttemptLimit, PASSKEY_BEGIN_PER_WINDOW } from '#lib/server/auth/throttle';
import { requireBotCheck, turnstileSiteKeyFor } from '#lib/server/auth/turnstile-action';
import { readFormBody, textField } from '#lib/server/forms';
import { safeReturnTo } from '#lib/server/return-to';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, safeReturnTo(url.searchParams.get('next')));
	// FN-50: the Turnstile site key (public) when the check is on, else null; passkeys only on a host that can be
	// an rpId (a secure deployment or localhost), so the page can hide the button elsewhere.
	return { turnstile: turnstileSiteKeyFor(), passkeyHost: passkeyRpId(url) !== null };
};

// FN-50: named actions only. SvelteKit refuses a `default` action next to named ones, so the password form posts
// to `?/password` (its `next` kept in the action URL), the passkey flow to `?/passkeyOptions` and `?/passkey`.
export const actions: Actions = {
	/** E-mail + password sign-in. */
	password: async (event) => {
		const { request, locals, cookies, url } = event;
		const form = await readFormBody(request);
		const email = textField(form, 'email').slice(0, EMAIL_MAX_LENGTH);
		const password = textField(form, 'password');
		const values = { email };
		if (!email.trim() || !password) return fail(400, { error: FIELDS_REQUIRED, values });
		const now = Date.now();
		// Counted before any key derivation, so a flood costs one row write per attempt.
		if (await overAttemptLimit(locals.db, request, now, 'sign-in'))
			return fail(429, { error: TOO_MANY_ATTEMPTS, values });
		// FN-50: the bot check, after the throttle (a flood never costs a siteverify call) and before any
		// derivation. Off while unconfigured; fails closed while configured.
		if (!(await requireBotCheck(event, form, 'sign-in')))
			return fail(400, { error: BOT_CHECK_FAILED, values });
		// Longer than any stored password can be: refused without deriving (says nothing about the account).
		if (password.length > PASSWORD_MAX_LENGTH)
			return fail(400, { error: INVALID_CREDENTIALS, values });
		const result = await signInWithPassword(locals.db, email, password, now);
		if (!result.ok) return fail(400, { error: INVALID_CREDENTIALS, values });
		const session = await createPasswordSession(locals.db, result.user.id, result.hash, now);
		if (!session) return fail(400, { error: INVALID_CREDENTIALS, values });
		// The cookie is about to be replaced: the session it held must not stay valid unseen (red team L7).
		if (locals.sessionToken) await revokeSession(locals.db, locals.sessionToken, now);
		setSessionCookie(cookies, session.token, session.expiresAt, locals.secure);
		// FN-31 usage statistics: counted only once signed in, under this account's own opt-out.
		await trackEvent(trackContext(event, result.user.id), { screen: 'masuk', action: 'sign_in' });
		const next = safeReturnTo(url.searchParams.get('next'));
		// A device that can open an account key asked for it (FN-21): after this password proof it gets the
		// wrapped key (never the password-derived key or a plain private key), opens it locally and navigates.
		if (textField(form, 'withKey') === '1') {
			const key = await getAccountKey(locals.db, result.user.id);
			if (key) return { signedIn: true as const, next, accountKey: accountKeyMaterial(key) };
		}
		redirect(303, next);
	},

	/**
	 * FN-50: the options of a discoverable passkey sign-in (one `sign_in` challenge, no allowed credentials),
	 * counted per client with its own budget (the conditional UI asks once per page load).
	 */
	passkeyOptions: async ({ request, locals, url }) => {
		await readFormBody(request);
		const rpId = passkeyRpId(url);
		if (!rpId) return fail(400, { passkeyError: PASSKEY_HOST_UNAVAILABLE });
		const now = Date.now();
		if (await overAttemptLimit(locals.db, request, now, 'passkey-begin', PASSKEY_BEGIN_PER_WINDOW))
			return fail(429, { passkeyError: TOO_MANY_ATTEMPTS });
		return { passkeyOptions: await signInOptions(locals.db, rpId, now) };
	},

	/**
	 * FN-50: a passkey assertion → a session. Counted per client, verified against this request's origin and rpId,
	 * the challenge consumed and the session written in one batch (`createPasskeySession`). Every refusal has the
	 * one message; a known credential's bad signature is recorded as `passkey_refused`.
	 */
	passkey: async (event) => {
		const { request, locals, cookies, url } = event;
		const form = await readFormBody(request);
		const rpId = passkeyRpId(url);
		if (!rpId) return fail(400, { passkeyError: PASSKEY_HOST_UNAVAILABLE });
		const now = Date.now();
		if (await overAttemptLimit(locals.db, request, now, 'passkey-finish'))
			return fail(429, { passkeyError: TOO_MANY_ATTEMPTS });
		const fields = readAssertionForm(form);
		const expected = { origin: passkeyOrigin(url), rpId };
		const checked = await checkSignIn(locals.db, fields, expected, now);
		if (!checked.ok) {
			// A reason label only: never the credential id, challenge or any field.
			console.warn('passkey sign-in refused', checked.reason);
			return fail(400, { passkeyError: PASSKEY_SIGN_IN_FAILED });
		}
		const session = await createPasskeySession(locals.db, checked, now);
		if (!session) return fail(400, { passkeyError: PASSKEY_SIGN_IN_FAILED });
		if (locals.sessionToken) await revokeSession(locals.db, locals.sessionToken, now);
		setSessionCookie(cookies, session.token, session.expiresAt, locals.secure);
		await trackEvent(trackContext(event, checked.userId), { screen: 'masuk', action: 'sign_in' });
		redirect(303, safeReturnTo(url.searchParams.get('next')));
	}
};
