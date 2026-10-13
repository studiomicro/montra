import { error, redirect } from '@sveltejs/kit';
import { getEnv } from '#lib/server/env';
import { gmailOAuthConfig, type GmailAppEnv } from '#lib/server/gmail/config';
import { setGmailResult } from '#lib/server/gmail/flash';
import { googleClient } from '#lib/server/gmail/google';
import type { GmailCallbackResult } from '#lib/server/gmail/messages';
import { completeGmailConnect, consumeState } from '#lib/server/gmail/oauth';
import { errorLabel } from '#lib/server/util';
import type { RequestHandler } from './$types';

// FN-19 Gmail OAuth callback (PRD § 3). Needs the session (a top-level GET from Google carries the SameSite=Lax
// cookie). Answers only on the configured redirect origin (elsewhere: 404 like an unknown route). The state is
// consumed atomically and must be this user's AND this session's, unexpired; every miss gets the same neutral
// result. Always ends with a 303 to the settings page without a query (the code never stays in the address bar or
// history; the result travels in a short-lived HttpOnly cookie) and `Referrer-Policy: no-referrer`. There is no
// `next`/`return` parameter: the target is a constant. Nothing from the query is logged.

const TARGET = '/pengaturan/aplikasi/gmail';
const STATE_MAX = 128;
const CODE_MAX = 2048;
const ERROR_MAX = 64;

const param = (url: URL, name: string, max: number) => {
	const value = url.searchParams.get(name);
	return value !== null && value.length <= max ? value : null;
};

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	const env = getEnv() as GmailAppEnv;
	const cfg = gmailOAuthConfig(env);
	if (!cfg || url.origin !== cfg.redirectOrigin) error(404, 'Not Found');
	const user = locals.user;
	if (!user) redirect(303, '/masuk');

	let result: GmailCallbackResult = 'failed';
	try {
		const state = param(url, 'state', STATE_MAX);
		const consumed =
			state && locals.sessionToken
				? await consumeState(
						locals.db,
						env,
						{ state, userId: user.id, sessionToken: locals.sessionToken },
						Date.now()
					)
				: null;
		const denied = url.searchParams.has('error');
		const code = param(url, 'code', CODE_MAX);
		if (denied)
			result = param(url, 'error', ERROR_MAX) === 'access_denied' ? 'cancelled' : 'failed';
		else if (consumed && code)
			result = await completeGmailConnect(
				locals.db,
				env,
				cfg,
				googleClient(),
				{ userId: user.id, spaceId: consumed.spaceId, code, verifier: consumed.verifier },
				Date.now()
			);
	} catch (e) {
		console.error('pengaturan/aplikasi/gmail/callback: failed', errorLabel(e));
		result = 'failed';
	}
	setGmailResult(cookies, locals.secure, result);
	return new Response(null, {
		status: 303,
		headers: { location: TARGET, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }
	});
};
