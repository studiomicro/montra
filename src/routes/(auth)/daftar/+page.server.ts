import { fail, redirect } from '@sveltejs/kit';
import { trackContext, trackEvent } from '#lib/server/analytics/track';
import { KEY_INVALID } from '#lib/server/account-keys/messages';
import { readAccountKeyForm } from '#lib/server/account-keys/validation';
import { NAME_MAX_LENGTH, signUp } from '#lib/server/auth/accounts';
import { BOT_CHECK_FAILED, TOO_MANY_ATTEMPTS } from '#lib/server/auth/messages';
import { EMAIL_MAX_LENGTH } from '#lib/server/auth/password';
import { claimHashes } from '#lib/server/billing/claims';
import { getEnv } from '#lib/server/env';
import { revokeSession, setSessionCookie } from '#lib/server/auth/session';
import { overAttemptLimit } from '#lib/server/auth/throttle';
import { requireBotCheck, turnstileSiteKeyFor } from '#lib/server/auth/turnstile-action';
import { readFormBody, textField } from '#lib/server/forms';
import { safeReturnTo } from '#lib/server/return-to';
import { siteOriginForApp } from '#lib/shared/hosts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	// No second account while signed in.
	if (locals.user) redirect(303, '/');
	// The draft terms and privacy policy the consent box links to (FN-31) live on the public site. FN-50: the
	// Turnstile site key (public) when the bot check is on, else null.
	return {
		siteOrigin: siteOriginForApp(url.hostname, url.port, url.protocol),
		turnstile: turnstileSiteKeyFor()
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { request, locals, cookies, url } = event;
		const form = await readFormBody(request);
		const input = {
			name: textField(form, 'name'),
			email: textField(form, 'email'),
			password: textField(form, 'password'),
			adultConfirmed: textField(form, 'adult') === 'on',
			consentAccepted: textField(form, 'consent') === 'on'
		};
		// Echoed back for the form, bounded; the password never is.
		const values = {
			name: input.name.slice(0, NAME_MAX_LENGTH * 4),
			email: input.email.slice(0, EMAIL_MAX_LENGTH),
			adult: input.adultConfirmed,
			consent: input.consentAccepted
		};
		const now = Date.now();
		// Sign-up derives a key too: its own per-client budget, counted first.
		if (await overAttemptLimit(locals.db, request, now, 'sign-up'))
			return fail(429, { error: TOO_MANY_ATTEMPTS, errors: {}, values });
		// FN-50: the bot check, after the throttle and before any derivation; off while unconfigured.
		if (!(await requireBotCheck(event, form, 'sign-up')))
			return fail(400, { error: BOT_CHECK_FAILED, errors: {}, values });
		// The account key the device made (FN-21). Absent without JavaScript or X25519: the account is created
		// without one. Sent but malformed (a weakened scrypt cost, a wrong length): refused, never stored.
		const key = await readAccountKeyForm(form);
		if (key.kind === 'invalid') return fail(400, { error: KEY_INVALID, errors: {}, values });
		const result = await signUp(
			locals.db,
			{
				...input,
				accountKey:
					key.kind === 'present' ? { fields: key.fields, keyCheckHash: key.keyCheckHash } : null,
				// FN-30: no second starter grant for an address whose deleted account already had one.
				claimHashes: await claimHashes(getEnv(), input.email)
			},
			now
		);
		if (!result.ok) return fail(400, { error: undefined, errors: result.errors, values });
		// A cookie being replaced must not leave its session valid unseen (red team L7).
		if (locals.sessionToken) await revokeSession(locals.db, locals.sessionToken, now);
		setSessionCookie(cookies, result.token, result.expiresAt, locals.secure);
		await trackEvent(trackContext(event, result.userId), { screen: 'daftar', action: 'sign_up' });
		redirect(303, safeReturnTo(url.searchParams.get('next')));
	}
};
