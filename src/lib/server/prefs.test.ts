import { describe, expect, it } from 'vitest';
import { isThemePref, resolveTheme, themeColors } from '#lib/server/prefs';

describe('resolveTheme', () => {
	it('accepts light, dark, mono, system and the Pro themes (the plan check is hooks.server.ts, FN-46)', () => {
		expect(resolveTheme('gold')).toBe('gold');
		expect(resolveTheme('emerald')).toBe('emerald');
		expect(resolveTheme('light')).toBe('light');
		expect(resolveTheme('dark')).toBe('dark');
		expect(resolveTheme('mono')).toBe('mono');
		expect(resolveTheme('system')).toBe('system');
	});
	it('falls back to system for anything else', () => {
		expect(resolveTheme(undefined)).toBe('system');
		expect(resolveTheme('')).toBe('system');
		expect(resolveTheme('MONO')).toBe('system');
		expect(resolveTheme('toString')).toBe('system');
		expect(resolveTheme('"><script>')).toBe('system');
	});
});

describe('isThemePref', () => {
	it('allows exactly the six values', () => {
		expect(['system', 'light', 'dark', 'mono', 'gold', 'emerald'].every(isThemePref)).toBe(true);
		expect(isThemePref('GOLD')).toBe(false);
		expect(isThemePref('mono-dark')).toBe(false);
		expect(isThemePref('__proto__')).toBe(false);
	});
});

describe('themeColors', () => {
	it('follows the device scheme for system and mono, pins it for light and dark', () => {
		expect(themeColors('system')).toEqual({ light: '#ffffff', dark: '#111112' });
		expect(themeColors('mono')).toEqual({ light: '#ffffff', dark: '#121212' });
		expect(themeColors('light')).toEqual({ light: '#ffffff', dark: '#ffffff' });
		expect(themeColors('dark')).toEqual({ light: '#111112', dark: '#111112' });
		expect(themeColors('gold')).toEqual({ light: '#fffdf8', dark: '#14120d' });
		expect(themeColors('emerald')).toEqual({ light: '#fbfefc', dark: '#0d1311' });
	});
});
