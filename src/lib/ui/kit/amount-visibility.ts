/**
 * "Hide amounts" (APP_PARITY § 2, HeroAmount's eye button): a per-device display preference kept in
 * localStorage. Storage may be blocked (private mode, embedded browsers): reading then means "shown" and writing
 * is skipped, so the toggle still works for the current page.
 */

export const HIDDEN_AMOUNT = '••••';
export const AMOUNTS_HIDDEN_KEY = 'fin-amounts-hidden';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readAmountsHidden(storage: Store | undefined): boolean {
	try {
		return storage?.getItem(AMOUNTS_HIDDEN_KEY) === '1';
	} catch {
		return false;
	}
}

/** Returns whether the choice was stored (false when storage is unavailable). */
export function writeAmountsHidden(storage: Store | undefined, hidden: boolean): boolean {
	if (!storage) return false;
	try {
		if (hidden) storage.setItem(AMOUNTS_HIDDEN_KEY, '1');
		else storage.removeItem(AMOUNTS_HIDDEN_KEY);
		return true;
	} catch {
		return false;
	}
}

/**
 * The cookie that carries the choice to the server (FN-25b red team 1), so a page whose amounts are hidden is
 * rendered masked from the first paint instead of showing the figures until hydration. A display preference only
 * (not access control: the figures are still in the page data); localStorage stays the device's source of truth.
 */
export const AMOUNTS_HIDDEN_COOKIE = 'montra-amounts-hidden';

/** The `document.cookie` assignment for `hidden` (cleared when shown). */
export function amountsHiddenCookie(hidden: boolean, secure: boolean): string {
	const flags = `Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
	return hidden
		? `${AMOUNTS_HIDDEN_COOKIE}=1; ${flags}; Max-Age=31536000`
		: `${AMOUNTS_HIDDEN_COOKIE}=; ${flags}; Max-Age=0`;
}

/** `text` unless amounts are hidden. */
export function maskAmount(text: string, hidden: boolean): string {
	return hidden ? HIDDEN_AMOUNT : text;
}
