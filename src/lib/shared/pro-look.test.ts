import { describe, expect, it } from 'vitest';
import { DAY_MS, effectivePlan, PLANS } from './billing/plans';
import { allowedTheme, appleTouchIconFile, hasProLook } from './pro-look';
import { FREE_THEMES, isProTheme, PRO_THEMES, THEME_PREFS } from './theme';

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);

describe('hasProLook (FN-46)', () => {
	it('Pro and Agen have it, Gratis does not (Agen looks exactly like Pro)', () => {
		expect(PLANS.filter(hasProLook)).toEqual(['pro', 'agen']);
	});

	it('follows the plan in force: a never-paid and a lapsed paid plan are Gratis, so no Pro look', () => {
		const never = effectivePlan(null, NOW);
		const lapsed = effectivePlan({ plan: 'pro', currentPeriodEnd: NOW - 1 }, NOW);
		const atBoundary = effectivePlan({ plan: 'agen', currentPeriodEnd: NOW }, NOW);
		const running = effectivePlan({ plan: 'agen', currentPeriodEnd: NOW + DAY_MS }, NOW);
		expect([never, lapsed, atBoundary].map(hasProLook)).toEqual([false, false, false]);
		expect(hasProLook(running)).toBe(true);
	});
});

describe('allowedTheme (FN-46 Part 2)', () => {
	it('the Pro themes are exactly gold and emerald; the four free ones are not', () => {
		expect(THEME_PREFS.filter(isProTheme)).toEqual([...PRO_THEMES]);
		expect(PRO_THEMES).toEqual(['gold', 'emerald']);
		expect(FREE_THEMES.some(isProTheme)).toBe(false);
	});

	it.each(PRO_THEMES)('%s on Gratis falls back to system (owner decision 2)', (theme) => {
		expect(allowedTheme(theme, 'gratis')).toBe('system');
	});

	it.each(PRO_THEMES)('%s stays on Pro and on Agen', (theme) => {
		expect(allowedTheme(theme, 'pro')).toBe(theme);
		expect(allowedTheme(theme, 'agen')).toBe(theme);
	});

	it('the free themes are untouched on every plan', () => {
		for (const plan of PLANS)
			for (const theme of FREE_THEMES) expect(allowedTheme(theme, plan)).toBe(theme);
	});
});

describe('appleTouchIconFile (FN-46 Part 3)', () => {
	it('names the crowned icon on Pro and Agen, today’s file on Gratis', () => {
		expect(appleTouchIconFile('gratis')).toBe('apple-touch-icon.png');
		expect(appleTouchIconFile('pro')).toBe('apple-touch-icon-pro.png');
		expect(appleTouchIconFile('agen')).toBe('apple-touch-icon-pro.png');
	});
});
