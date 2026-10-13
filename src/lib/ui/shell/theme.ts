import {
	FREE_THEMES,
	isProTheme,
	isThemePref,
	themeColors,
	type ThemePref
} from '#lib/shared/theme';
import type { IconName } from '#lib/ui/icons';

/**
 * The sidebar's theme button (APP_PARITY § 1): one click moves to the next of the four choices every account has
 * in Pengaturan › Tampilan — Sistem → Terang → Gelap → Hitam-putih → Sistem — so it never drops a choice. A Pro
 * theme (FN-46) is picked in Tampilan only; from one, the button moves on to Sistem.
 */
export function nextTheme(current: string | undefined): ThemePref {
	const theme = current !== undefined && isThemePref(current) ? current : 'system';
	if (isProTheme(theme)) return 'system';
	const at = (FREE_THEMES as readonly ThemePref[]).indexOf(theme);
	return FREE_THEMES[(at + 1) % FREE_THEMES.length]!;
}

/** What the button shows for the current choice. */
export const THEME_ICONS: Record<ThemePref, IconName> = {
	system: 'monitor',
	light: 'sun',
	dark: 'moon',
	mono: 'contrast',
	gold: 'star',
	emerald: 'sparkle'
};

/**
 * `document.cookie` value: a year, the whole site, Lax; Secure on HTTPS. `system` clears the cookie, as the
 * Tampilan form action does.
 */
export function themeCookie(theme: ThemePref, secure: boolean): string {
	const value =
		theme === 'system' ? 'theme=; Path=/; Max-Age=0' : `theme=${theme}; Path=/; Max-Age=31536000`;
	return `${value}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * Points the two `theme-color` metas (app.html) at the colours of `theme`, so the browser's status bar follows a
 * theme change without a reload (FN-13b). The metas are told apart by their `media` query.
 */
export function applyThemeColor(doc: Document, theme: ThemePref): void {
	const colors = themeColors(theme);
	for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
		const scheme = meta.media.includes('dark') ? 'dark' : 'light';
		meta.content = colors[scheme];
	}
}
