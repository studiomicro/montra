import { describe, expect, it } from 'vitest';
import { PULL_THRESHOLD, pullMayStart, pullProgress } from './pull-to-refresh';

describe('pull-to-refresh (FN-51)', () => {
	const ok = { standalone: true, scrollY: 0, hidden: false, dialogOpen: false, refreshing: false };

	it('may start only in the installed app, at the top, visible, with no sheet open and no refresh running', () => {
		expect(pullMayStart(ok)).toBe(true);
		expect(pullMayStart({ ...ok, standalone: false })).toBe(false);
		expect(pullMayStart({ ...ok, scrollY: 1 })).toBe(false);
		expect(pullMayStart({ ...ok, hidden: true })).toBe(false);
		expect(pullMayStart({ ...ok, dialogOpen: true })).toBe(false);
		expect(pullMayStart({ ...ok, refreshing: true })).toBe(false);
	});

	it('a downward drag from the top counts up to the threshold; scrolling up or away is nothing', () => {
		expect(PULL_THRESHOLD).toBe(72);
		expect(pullProgress(100, 100, 0)).toBe(0);
		expect(pullProgress(100, 136, 0)).toBe(0.5);
		expect(pullProgress(100, 172, 0)).toBe(1);
		expect(pullProgress(100, 400, 0)).toBe(1);
		// Finger moving up (scrolling the list) never pulls.
		expect(pullProgress(300, 200, 0)).toBe(0);
		// Once the page has scrolled away from the top the gesture is a scroll, not a pull.
		expect(pullProgress(100, 200, 40)).toBe(0);
	});
});
