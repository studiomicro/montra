import { msg } from '#lib/shared/i18n';

/**
 * The `theme` cookie (FN-40 Part 1): `mono` is "Hitam-putih", greys that follow the device's light/dark scheme.
 * FN-46: `gold` ("Emas") and `emerald` ("Hijau tua") are the Pro themes, following the device scheme like `mono`;
 * only an account on a paid plan may keep one (src/lib/shared/pro-look.ts, enforced in hooks.server.ts).
 */
export type ThemePref = 'system' | 'light' | 'dark' | 'mono' | 'gold' | 'emerald';

/** The two Pro themes, in the order Pengaturan › Tampilan lists them after Hitam-putih. */
export const PRO_THEMES = ['gold', 'emerald'] as const satisfies readonly ThemePref[];

/** The four choices every account has, in the order Tampilan lists them and the sidebar toggle cycles them. */
export const FREE_THEMES = [
	'system',
	'light',
	'dark',
	'mono'
] as const satisfies readonly ThemePref[];

/** Every value the cookie may hold. */
export const THEME_PREFS: readonly ThemePref[] = [...FREE_THEMES, ...PRO_THEMES];

export const THEME_LABELS: Record<ThemePref, string> = {
	system: msg('Sistem'),
	light: msg('Terang'),
	dark: msg('Gelap'),
	mono: msg('Hitam-putih'),
	gold: msg('Emas'),
	emerald: msg('Hijau tua')
};

export function isThemePref(value: string): value is ThemePref {
	return (THEME_PREFS as readonly string[]).includes(value);
}

export function isProTheme(theme: ThemePref): boolean {
	return (PRO_THEMES as readonly ThemePref[]).includes(theme);
}

/**
 * The browser chrome colour (`<meta name="theme-color">`) for a light and a dark device scheme: the `--bg` of
 * what that scheme shows under this preference (test/contrast.test.ts checks them against tokens.css). The server
 * writes them into the first HTML; the theme toggle rewrites them without a reload (FN-13b).
 */
const BG = {
	light: '#ffffff',
	dark: '#111112',
	monoLight: '#ffffff',
	monoDark: '#121212',
	goldLight: '#fffdf8',
	goldDark: '#14120d',
	emeraldLight: '#fbfefc',
	emeraldDark: '#0d1311'
} as const;

export function themeColors(theme: ThemePref): { light: string; dark: string } {
	if (theme === 'light') return { light: BG.light, dark: BG.light };
	if (theme === 'dark') return { light: BG.dark, dark: BG.dark };
	if (theme === 'mono') return { light: BG.monoLight, dark: BG.monoDark };
	if (theme === 'gold') return { light: BG.goldLight, dark: BG.goldDark };
	if (theme === 'emerald') return { light: BG.emeraldLight, dark: BG.emeraldDark };
	return { light: BG.light, dark: BG.dark };
}
