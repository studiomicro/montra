import { getContext, setContext } from 'svelte';
import {
	amountsHiddenCookie,
	maskAmount,
	readAmountsHidden,
	writeAmountsHidden
} from './amount-visibility';

/**
 * The page's "hide amounts" state, shared by every kit component that prints money. The server renders it from
 * the choice's cookie (HeroAmount, per render; the root layout resets it first, so one request's choice never
 * reaches another); `loadAmountsHidden()` applies the stored choice once the page is hydrated and refreshes the
 * cookie.
 */
export const amounts = $state({ hidden: false });

function localStore(): Storage | undefined {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

function writeCookie(hidden: boolean): void {
	try {
		document.cookie = amountsHiddenCookie(hidden, location.protocol === 'https:');
	} catch {
		// Cookies blocked: the page still masks after hydration.
	}
}

export function loadAmountsHidden(): void {
	amounts.hidden = readAmountsHidden(localStore());
	writeCookie(amounts.hidden);
}

export function setAmountsHidden(hidden: boolean): void {
	amounts.hidden = hidden;
	writeAmountsHidden(localStore(), hidden);
	writeCookie(hidden);
}

/** `text`, or "••••" while amounts are hidden (reactive inside components). */
export function shown(text: string): string {
	return maskAmount(text, amounts.hidden);
}

const AT_LOAD = Symbol('amounts-hidden-at-load');

/**
 * The root layout hands down this request's cookie choice (FN-25b red team 1) and resets the shared state: on the
 * server the module state lives across requests, so every render starts shown.
 */
export function provideAmountsHiddenAtLoad(read: () => boolean): void {
	amounts.hidden = false;
	setContext(AT_LOAD, read);
}

/** The cookie choice the page was loaded with (false outside the app shell, e.g. component tests). */
export function amountsHiddenAtLoad(): boolean {
	return getContext<(() => boolean) | undefined>(AT_LOAD)?.() === true;
}

/**
 * Applies the cookie choice at the top of a page whose hero has the eye button (red team N5), so every figure the
 * page renders, before its hero too, is masked on the server; HeroAmount applies it again and the device's stored
 * choice wins on mount. `scripts`-level only: call it before the page's markup.
 */
export function applyAmountsHiddenAtLoad(): void {
	amounts.hidden = amountsHiddenAtLoad();
}
