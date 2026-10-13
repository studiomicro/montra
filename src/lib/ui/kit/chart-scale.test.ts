import { describe, expect, it } from 'vitest';
import { barHeights, linePoints, stackSegments } from './chart-scale';

describe('barHeights', () => {
	it('handles empty and all-zero data', () => {
		expect(barHeights([], 100)).toEqual([]);
		expect(barHeights([0, 0, 0], 100)).toEqual([0, 0, 0]);
	});
	it('scales to the max and keeps small values visible', () => {
		expect(barHeights([50, 100, 1], 100, 2)).toEqual([50, 100, 2]);
	});
	it('treats negative values as zero', () => {
		expect(barHeights([-5, 10], 100)).toEqual([0, 100]);
	});
	it('works for a single day', () => {
		expect(barHeights([7], 80)).toEqual([80]);
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
