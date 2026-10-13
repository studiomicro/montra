import { isPaidPlan, type Plan } from './billing/plans.ts';
import { isProTheme, type ThemePref } from './theme.ts';

/**
 * FN-46 "Pro look": what a paid plan changes in how Montra looks (badge, Pro themes, crowned Koko, Beranda's hero
 * frame, the home-screen icon). Pure: the caller passes the plan the server derived for `locals.user`
 * (billing/gate.ts `planOf`), never anything the client sent. Agen looks exactly like Pro (owner decision 5).
 */

/** True on Pro and Agen while the paid period runs (`effectivePlan` already turned a lapsed plan into Gratis). */
export function hasProLook(plan: Plan): boolean {
	return isPaidPlan(plan);
}

/**
 * The theme this account may see: a Pro theme from an account without the Pro look (never paid, lapsed, signed
 * out, or a hand-edited cookie) falls back to `system` (owner decision 2).
 */
export function allowedTheme(theme: ThemePref, plan: Plan): ThemePref {
	return isProTheme(theme) && !hasProLook(plan) ? 'system' : theme;
}

/** The `apple-touch-icon` file under /icons/: read by iOS only when the app is added to the home screen. */
export function appleTouchIconFile(plan: Plan): string {
	return hasProLook(plan) ? 'apple-touch-icon-pro.png' : 'apple-touch-icon.png';
}

/** The manifest's "any" icons for the Pro look; maskable and monochrome stay Koko's own (owner decision 3). */
export const PRO_MANIFEST_ICONS: Readonly<Record<string, string>> = {
	'/icons/icon-192.png': '/icons/icon-192-pro.png',
	'/icons/icon-512.png': '/icons/icon-512-pro.png'
};
