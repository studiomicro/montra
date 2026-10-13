import { readFileSync } from 'node:fs';
import { Tween } from 'svelte/motion';
import { describe, expect, it } from 'vitest';
import {
	countUpDuration,
	DURATION_MS,
	EASE,
	highlightedBatchId,
	interpolateMinor,
	motionAllowed,
	PAGE_ENTER_OPTIONS,
	pageEnterKeyframes,
	pageFadeAllowed,
	rowOut,
	SKELETON_MAX_ROWS,
	skeletonRows,
	streakHop,
	WELCOME_WAVE_KEY,
	welcomeWaveDue
} from './motion';

const tokens = readFileSync('docs/design/tokens.css', 'utf8');

describe('motion durations', () => {
	it('mirror the --duration-* tokens; every finite motion stays within 150–300 ms', () => {
		for (const [name, ms] of Object.entries(DURATION_MS)) {
			expect(tokens).toMatch(new RegExp(`--duration-${name}:\\s*${ms}ms;`));
			if (name === 'loop') continue;
			expect(ms).toBeGreaterThanOrEqual(150);
			expect(ms).toBeLessThanOrEqual(300);
		}
		// The one loop (the skeleton shimmer, only while a load is outstanding) is longer: one visible sweep.
		expect(DURATION_MS.loop).toBe(1200);
	});

	it('EASE is the --ease token, so the Web Animations fade and the CSS transitions share one curve', () => {
		expect(tokens).toContain(`--ease: ${EASE};`);
	});
});

describe('motionAllowed (FN-51 I)', () => {
	it('is off under reduced motion and in a hidden tab', () => {
		expect(motionAllowed({ reducedMotion: false, hidden: false })).toBe(true);
		expect(motionAllowed({ reducedMotion: true, hidden: false })).toBe(false);
		expect(motionAllowed({ reducedMotion: false, hidden: true })).toBe(false);
	});
});

describe('hero count-up', () => {
	it('shows whole minor units at every step and exactly the new figure at the end', () => {
		const step = interpolateMinor(126_400_000, 98_750_050);
		expect(step(0)).toBe(126_400_000);
		for (const t of [0.013, 0.1, 0.37, 0.5, 0.91, 0.999])
			expect(Number.isInteger(step(t))).toBe(true);
		expect(step(1)).toBe(98_750_050);
		// An eased overshoot past 1 never leaves an amount that is not the server's figure.
		expect(step(1.02)).toBe(98_750_050);
	});

	it('counts for the slow duration, and not at all under reduced motion, hidden, across currencies or with no change', () => {
		const change = { from: 100, to: 250, sameCurrency: true, reducedMotion: false };
		expect(countUpDuration(change)).toBe(300);
		expect(countUpDuration({ ...change, reducedMotion: true })).toBe(0);
		expect(countUpDuration({ ...change, hidden: true })).toBe(0);
		expect(countUpDuration({ ...change, sameCurrency: false })).toBe(0);
		expect(countUpDuration({ ...change, to: 100 })).toBe(0);
	});

	it('a zero-duration set (reduced motion) puts the end value on screen at once', async () => {
		const count = new Tween(126_400_000, { interpolate: interpolateMinor });
		const done = count.set(98_750_050, {
			duration: countUpDuration({
				from: 126_400_000,
				to: 98_750_050,
				sameCurrency: true,
				reducedMotion: true
			})
		});
		expect(count.current).toBe(98_750_050);
		await done;
		expect(count.current).toBe(98_750_050);
	});

	it('with motion, the tween is aimed at the exact server figure', () => {
		const count = new Tween(500, { interpolate: interpolateMinor });
		void count.set(1_234_567, { duration: 300 });
		expect(count.target).toBe(1_234_567);
	});
});

describe('page enter (FN-51 A)', () => {
	const nav = { supported: true, reducedMotion: false, from: '/', to: '/riwayat' };
	it('runs between two pages where the browser supports it', () => {
		expect(pageFadeAllowed(nav)).toBe(true);
	});
	it('never without Web Animations, under reduced motion, hidden, on the same page or a first load', () => {
		expect(pageFadeAllowed({ ...nav, supported: false })).toBe(false);
		expect(pageFadeAllowed({ ...nav, reducedMotion: true })).toBe(false);
		expect(pageFadeAllowed({ ...nav, hidden: true })).toBe(false);
		expect(pageFadeAllowed({ ...nav, to: '/' })).toBe(false);
		expect(
			pageFadeAllowed({ from: '/riwayat', to: '/riwayat', supported: true, reducedMotion: false })
		).toBe(false);
		expect(pageFadeAllowed({ ...nav, from: undefined })).toBe(false);
	});
	it('keyframes move opacity and transform only, 200 ms on the --ease curve, leaving no transform behind', () => {
		const frames = pageEnterKeyframes();
		expect(frames).toHaveLength(2);
		for (const frame of frames) expect(Object.keys(frame).sort()).toEqual(['opacity', 'transform']);
		expect(frames[0]).toEqual({ opacity: 0, transform: 'translateY(8px)' });
		expect(frames[1]).toEqual({ opacity: 1, transform: 'translateY(0)' });
		expect(PAGE_ENTER_OPTIONS).toEqual({ duration: 200, easing: EASE, fill: 'none' });
	});
});

describe('row exit (FN-51 B3)', () => {
	const node = {} as Element;
	it('fades and shrinks for 150 ms with motion, and is removed at once under reduced motion', () => {
		const out = rowOut(node, { reducedMotion: false });
		expect(out.duration).toBe(DURATION_MS.fast);
		expect(out.css(1)).toBe('opacity: 1; transform: scale(1)');
		expect(out.css(0)).toBe('opacity: 0; transform: scale(0.98)');
		expect(rowOut(node, { reducedMotion: true }).duration).toBe(0);
	});
	it('touches no other property', () => {
		for (const t of [0, 0.25, 0.5, 1]) {
			const props = rowOut(node, { reducedMotion: false })
				.css(t)
				.split(';')
				.map((d) => d.split(':')[0]!.trim())
				.filter(Boolean)
				.sort();
			expect(props).toEqual(['opacity', 'transform']);
		}
	});
});

describe('streak hop (FN-51 G)', () => {
	it.each([
		[3, 4, false, false, true],
		[3, 3, false, false, false],
		[4, 3, false, false, false],
		[null, 1, false, false, false],
		[0, 1, false, false, true],
		[3, 4, true, false, false],
		[3, 4, false, true, false],
		[undefined, undefined, false, false, false]
	])('prev %s → next %s (reduced %s, hidden %s) = %s', (prev, next, reduced, hidden, want) => {
		expect(streakHop(prev, next, reduced, hidden)).toBe(want);
	});
});

describe('highlighted import batch (FN-51 B2)', () => {
	it('names the batch of the action result, and no row otherwise', () => {
		expect(highlightedBatchId({ done: 'undone', batchId: 'b1' })).toBe('b1');
		expect(highlightedBatchId({ done: 'imported', counts: {}, batchId: 'b2' })).toBe('b2');
		expect(highlightedBatchId({ done: 'imported', counts: {}, batchId: null })).toBeNull();
		expect(highlightedBatchId({ done: 'imported', counts: {} })).toBeNull();
		expect(highlightedBatchId({ batchId: '' })).toBeNull();
		expect(highlightedBatchId({ batchId: 42 })).toBeNull();
		expect(highlightedBatchId(null)).toBeNull();
		expect(highlightedBatchId(undefined)).toBeNull();
	});
});

describe('skeleton rows (FN-51 D)', () => {
	it('caps at 8 bars and never goes negative', () => {
		expect(SKELETON_MAX_ROWS).toBe(8);
		expect(skeletonRows(3)).toBe(3);
		expect(skeletonRows(8)).toBe(8);
		expect(skeletonRows(20)).toBe(8);
		expect(skeletonRows(0)).toBe(0);
		expect(skeletonRows(-2)).toBe(0);
		expect(skeletonRows(2.7)).toBe(2);
	});
});

describe('Koko welcome back (FN-51)', () => {
	const base = {
		standalone: true,
		reducedMotion: false,
		hidden: false,
		lastShown: null,
		today: '2026-10-12'
	};
	it('once per WIB day on an installed device with motion allowed', () => {
		expect(WELCOME_WAVE_KEY).toBe('montra-welcome-wib-date');
		expect(welcomeWaveDue(base)).toBe(true);
		expect(welcomeWaveDue({ ...base, lastShown: '2026-10-11' })).toBe(true);
		expect(welcomeWaveDue({ ...base, lastShown: '2026-10-12' })).toBe(false);
	});
	it('never in a browser tab, under reduced motion or hidden', () => {
		expect(welcomeWaveDue({ ...base, standalone: false })).toBe(false);
		expect(welcomeWaveDue({ ...base, reducedMotion: true })).toBe(false);
		expect(welcomeWaveDue({ ...base, hidden: true })).toBe(false);
	});
	it('follows the WIB date, not the UTC one: 23:30 and 00:30 WIB straddle a day the UTC clock does not', async () => {
		const { wibTodayString } = await import('#lib/shared/dates');
		// 2026-10-12 16:30 UTC = 23:30 WIB (still the 12th); 17:30 UTC = 00:30 WIB on the 13th.
		const late = wibTodayString(Date.UTC(2026, 9, 12, 16, 30));
		const early = wibTodayString(Date.UTC(2026, 9, 12, 17, 30));
		expect(late).toBe('2026-10-12');
		expect(early).toBe('2026-10-13');
		expect(welcomeWaveDue({ ...base, lastShown: late, today: late })).toBe(false);
		expect(welcomeWaveDue({ ...base, lastShown: late, today: early })).toBe(true);
	});
});
