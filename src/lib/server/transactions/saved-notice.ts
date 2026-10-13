import type { Cookies } from '@sveltejs/kit';
import { hostCookieName } from '../auth/session';

/** What a finished transaction write tells Riwayat after its redirect (`/riwayat?saved=…`). */
export type SavedKind = 'created' | 'updated' | 'deleted' | 'adjusted';
const KINDS: ReadonlySet<string> = new Set<SavedKind>([
	'created',
	'updated',
	'deleted',
	'adjusted'
]);

/**
 * FN-44 L1: one-shot cookie set only after the server confirmed the write, read and cleared by Riwayat's load.
 * The `?saved=` in the redirect alone never shows "Transaksi dicatat" or Koko's hop, so a crafted or reloaded
 * URL shows nothing. Same pattern as the inbox's save summary (drafts/notice.ts). `/riwayat/berulang` has its
 * own cookie and kinds (below), so a notice for one list is never cleared or shown by the other.
 */
const NOTICE_COOKIE = 'tx_saved';
const SERIES_NOTICE_COOKIE = 'series_saved';
const NOTICE_MAX_AGE_S = 60;

const options = (secure: boolean) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	secure
});

function setNotice(cookies: Cookies, secure: boolean, cookie: string, kind: string) {
	cookies.set(hostCookieName(cookie, secure), kind, {
		...options(secure),
		maxAge: NOTICE_MAX_AGE_S
	});
}

/**
 * The kind the last write left, only when it is one of `kinds` and matches the redirect's `?saved=` (the cookie
 * is cleared as it is read, matched or not); null otherwise.
 */
function takeNotice<K extends string>(
	cookies: Cookies,
	secure: boolean,
	cookie: string,
	kinds: ReadonlySet<string>,
	param: string | null
): K | null {
	const name = hostCookieName(cookie, secure);
	const value = cookies.get(name);
	if (value === undefined) return null;
	cookies.delete(name, options(secure));
	return kinds.has(value) && value === param ? (value as K) : null;
}

export const setSavedNotice = (cookies: Cookies, secure: boolean, kind: SavedKind) =>
	setNotice(cookies, secure, NOTICE_COOKIE, kind);

export const takeSavedNotice = (cookies: Cookies, secure: boolean, param: string | null) =>
	takeNotice<SavedKind>(cookies, secure, NOTICE_COOKIE, KINDS, param);

/** What a finished recurring-series write tells `/riwayat/berulang` after its redirect. */
export type SeriesSavedKind = 'created' | 'updated' | 'paused' | 'resumed' | 'stopped' | 'deleted';
const SERIES_KINDS: ReadonlySet<string> = new Set<SeriesSavedKind>([
	'created',
	'updated',
	'paused',
	'resumed',
	'stopped',
	'deleted'
]);

export const setSeriesSavedNotice = (cookies: Cookies, secure: boolean, kind: SeriesSavedKind) =>
	setNotice(cookies, secure, SERIES_NOTICE_COOKIE, kind);

export const takeSeriesSavedNotice = (cookies: Cookies, secure: boolean, param: string | null) =>
	takeNotice<SeriesSavedKind>(cookies, secure, SERIES_NOTICE_COOKIE, SERIES_KINDS, param);

/** What a finished Patungan write (FN-49) tells `/patungan` or the split's page after its redirect. */
export type SplitSavedKind =
	'created' | 'updated' | 'deleted' | 'settled' | 'unsettled' | 'linked' | 'unlinked';
const SPLIT_KINDS: ReadonlySet<string> = new Set<SplitSavedKind>([
	'created',
	'updated',
	'deleted',
	'settled',
	'unsettled',
	'linked',
	'unlinked'
]);
const SPLIT_NOTICE_COOKIE = 'split_saved';

export const setSplitSavedNotice = (cookies: Cookies, secure: boolean, kind: SplitSavedKind) =>
	setNotice(cookies, secure, SPLIT_NOTICE_COOKIE, kind);

export const takeSplitSavedNotice = (cookies: Cookies, secure: boolean, param: string | null) =>
	takeNotice<SplitSavedKind>(cookies, secure, SPLIT_NOTICE_COOKIE, SPLIT_KINDS, param);
