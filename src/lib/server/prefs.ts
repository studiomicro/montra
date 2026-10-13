import { isThemePref, themeColors, type ThemePref } from '#lib/shared/theme';

export { isThemePref, themeColors, type ThemePref };

export function resolveTheme(cookie: string | undefined): ThemePref {
	return cookie !== undefined && isThemePref(cookie) ? cookie : 'system';
}
