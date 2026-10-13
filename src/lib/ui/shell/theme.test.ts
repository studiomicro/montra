import { describe, expect, it } from 'vitest';
import { FREE_THEMES, THEME_PREFS } from '#lib/shared/theme';
import { applyThemeColor, nextTheme, THEME_ICONS, themeCookie } from './theme';

describe('theme toggle', () => {
	it('cycles Sistem → Terang → Gelap → Hitam-putih → Sistem', () => {
		expect(nextTheme('system')).toBe('light');
		expect(nextTheme('light')).toBe('dark');
		expect(nextTheme('dark')).toBe('mono');
		expect(nextTheme('mono')).toBe('system');
	});
	it('keeps Hitam-putih reachable: four clicks from any choice come back to it', () => {
		for (const start of FREE_THEMES) {
			const seen: string[] = [start];
			for (let i = 0; i < 4; i++) seen.push(nextTheme(seen.at(-1)));
			expect(new Set(seen.slice(1))).toEqual(new Set(FREE_THEMES));
			expect(seen.at(-1)).toBe(start);
		}
	});
	it('never cycles into a Pro theme; from one it moves on to Sistem (FN-46)', () => {
		expect(nextTheme('gold')).toBe('system');
		expect(nextTheme('emerald')).toBe('system');
		for (const start of THEME_PREFS) expect(['gold', 'emerald']).not.toContain(nextTheme(start));
	});
	it('treats a missing or unknown value as Sistem', () => {
		expect(nextTheme(undefined)).toBe('light');
		expect(nextTheme('bogus')).toBe('light');
		expect(nextTheme('toString')).toBe('light');
	});
	it('shows a distinct icon per choice', () => {
		expect(new Set(Object.values(THEME_ICONS)).size).toBe(THEME_PREFS.length);
	});
	it('writes the cookie hooks.server.ts reads, Secure only on HTTPS; Sistem clears it', () => {
		expect(themeCookie('dark', false)).toBe('theme=dark; Path=/; Max-Age=31536000; SameSite=Lax');
		expect(themeCookie('mono', true)).toBe(
			'theme=mono; Path=/; Max-Age=31536000; SameSite=Lax; Secure'
		);
		expect(themeCookie('system', false)).toBe('theme=; Path=/; Max-Age=0; SameSite=Lax');
		expect(themeCookie('gold', false)).toBe('theme=gold; Path=/; Max-Age=31536000; SameSite=Lax');
	});
});

describe('applyThemeColor (FN-13b)', () => {
	/** The two metas of app.html, told apart by their media query, as a stub document. */
	function metas() {
		const light = { media: '(prefers-color-scheme: light)', content: '#ffffff' };
		const dark = { media: '(prefers-color-scheme: dark)', content: '#111112' };
		const doc = { querySelectorAll: () => [light, dark] } as unknown as Document;
		return { doc, light, dark };
	}
	it('Gelap on a light device turns both metas dark at once; Terang turns both light', () => {
		const { doc, light, dark } = metas();
		applyThemeColor(doc, 'dark');
		expect([light.content, dark.content]).toEqual(['#111112', '#111112']);
		applyThemeColor(doc, 'light');
		expect([light.content, dark.content]).toEqual(['#ffffff', '#ffffff']);
	});
	it('Sistem and Hitam-putih keep one colour per scheme', () => {
		const { doc, light, dark } = metas();
		applyThemeColor(doc, 'mono');
		expect([light.content, dark.content]).toEqual(['#ffffff', '#121212']);
		applyThemeColor(doc, 'system');
		expect([light.content, dark.content]).toEqual(['#ffffff', '#111112']);
	});
});
