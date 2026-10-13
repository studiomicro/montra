import type { Cookies } from '@sveltejs/kit';
import { hostCookieName } from '../auth/session';
import { GMAIL_CALLBACK_RESULTS, type GmailCallbackResult } from './messages';

/**
 * The OAuth callback always ends with a 303 to the settings page WITHOUT a query (the code must not stay in the
 * address bar or history), so its result travels in a short-lived, HttpOnly cookie read once by the page. The
 * value is one of a fixed list of codes, never anything from Google or the request.
 */
const BASE = 'gmail_result';
const MAX_AGE_S = 120;

export function setGmailResult(
	cookies: Cookies,
	secure: boolean,
	result: GmailCallbackResult
): void {
	cookies.set(hostCookieName(BASE, secure), result, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: MAX_AGE_S
	});
}

/** The pending result (and clears it), or null. */
export function takeGmailResult(cookies: Cookies, secure: boolean): GmailCallbackResult | null {
	const name = hostCookieName(BASE, secure);
	const value = cookies.get(name);
	if (value === undefined) return null;
	cookies.delete(name, { path: '/', httpOnly: true, secure, sameSite: 'lax' });
	return Object.hasOwn(GMAIL_CALLBACK_RESULTS, value) ? (value as GmailCallbackResult) : null;
}
