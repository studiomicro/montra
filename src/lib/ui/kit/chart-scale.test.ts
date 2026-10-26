import { describe, expect, it } from 'vitest';
import { cappedBars, linePoints, stackSegments } from './chart-scale';

describe('cappedBars', () => {
	it('handles empty and all-zero data', () => {
		expect(cappedBars([], 100)).toEqual({ heights: [], clipped: [] });
		expect(cappedBars([0, 0], 100)).toEqual({ heights: [0, 0], clipped: [false, false] });
	});
	it('scales like barHeights when no day is an outlier', () => {
		expect(cappedBars([50, 100, 80], 100)).toEqual({
			heights: [50, 100, 80],
			clipped: [false, false, false]
		});
	});
	it('caps one outlier at twice the median so the other days stay readable', () => {
		// Median of the non-zero days is 100: the scale tops out at 200; the 3.5 jt rent day is clipped.
		const { heights, clipped } = cappedBars([100, 0, 3_500, 50, 150, 100], 120);
		expect(heights).toEqual([60, 0, 120, 30, 90, 60]);
		expect(clipped).toEqual([false, false, true, false, false, false]);
	});
	it('uses the mean of the two middle days for an even count', () => {
		// Non-zero sorted: 10, 20, 30, 1000 → median 25, cap 50.
		expect(cappedBars([10, 20, 30, 1_000], 100).heights).toEqual([20, 40, 60, 100]);
	});
	it('keeps every non-zero day at least minVisible tall', () => {
		expect(cappedBars([1, 100, 100], 120).heights).toEqual([6, 120, 120]);
		expect(cappedBars([1, 100, 100], 120, { minVisible: 4 }).heights[0]).toBe(4);
	});
	it('treats negative values as zero', () => {
		expect(cappedBars([-5, 10], 100)).toEqual({ heights: [0, 100], clipped: [false, false] });
	});
});

describe('stackSegments', () => {
	it('splits the width proportionally', () => {
		expect(stackSegments([1, 1, 2], 100)).toEqual([
			{ x: 0, width: 25 },
			{ x: 25, width: 25 },
			{ x: 50, width: 50 }
		]);
	});
	it('returns nothing for zero total', () => {
		expect(stackSegments([0, 0], 100)).toEqual([]);
	});
});

describe('linePoints', () => {
	it('maps values onto the box, top is max', () => {
		expect(linePoints([0, 10], 100, 50, 10)).toBe('0,50 100,0');
	});
	it('handles a single point and zero max', () => {
		expect(linePoints([5], 100, 50, 10)).toBe('0,25');
		expect(linePoints([0, 0], 100, 50, 0)).toBe('0,50 100,50');
	});
});
