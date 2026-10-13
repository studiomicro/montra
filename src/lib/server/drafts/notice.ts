import type { Cookies } from '@sveltejs/kit';
import { hostCookieName } from '../auth/session';

/** What "Simpan N transaksi" saved, shown once on /kotak-masuk after the redirect. */
export interface SavedNotice {
	saved: number;
	total: number;
	incomplete: number;
	/** Selected drafts past the per-request bound, left for a further submission. */
	remaining: number;
}

/**
 * One-shot cookie carrying the save summary across the redirect: set only after the server confirmed the
 * batch, read and cleared by the inbox (a crafted URL can never show "saved"). Same pattern as FN-03's
 * "you left the space" notice.
 */
const NOTICE_COOKIE = 'drafts_saved';
const NOTICE_MAX_AGE_S = 60;
const COUNT_MAX = 10_000;

const options = (secure: boolean) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	secure
});

export function setSavedNotice(cookies: Cookies, secure: boolean, notice: SavedNotice) {
	const value = [notice.saved, notice.total, notice.incomplete, notice.remaining].join('.');
	cookies.set(hostCookieName(NOTICE_COOKIE, secure), value, {
		...options(secure),
		maxAge: NOTICE_MAX_AGE_S
	});
}

/** The summary the last save left (cleared as it is read); null when none or malformed. */
export function takeSavedNotice(cookies: Cookies, secure: boolean): SavedNotice | null {
	const name = hostCookieName(NOTICE_COOKIE, secure);
	const value = cookies.get(name);
	if (value === undefined) return null;
	cookies.delete(name, options(secure));
	const parts = value.split('.');
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,5}$/.test(p))) return null;
	const [saved, total, incomplete, remaining] = parts.map(Number) as [
		number,
		number,
		number,
		number
	];
	if ([saved, total, incomplete, remaining].some((n) => n > COUNT_MAX)) return null;
	return { saved, total, incomplete, remaining };
}
