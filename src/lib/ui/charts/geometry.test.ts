import { describe, expect, it } from 'vitest';
import {
	axisPoints,
	axisX,
	donutSegments,
	flowLayout,
	FLOW_BAR,
	FLOW_MIN_BAND,
	FLOW_MIN_NODE,
	FLOW_SCALE_HEIGHT,
	mondayColumn,
	stackRects,
	trendPoints
} from './geometry';

describe('mondayColumn', () => {
	it('Monday is column 0 and Sunday column 6', () => {
		expect(mondayColumn('2026-10-05')).toBe(0); // Monday
		expect(mondayColumn('2026-10-01')).toBe(3); // Thursday
		expect(mondayColumn('2026-11-01')).toBe(6); // Sunday
		expect(mondayColumn('2028-02-29')).toBe(1); // leap day, Tuesday
	});
});

describe('axisPoints / axisX', () => {
	it('places a short series on the full axis and stops early', () => {
		expect(axisPoints([0, 50, 100], 5, 400, 100, 100)).toBe('0,100 100,50 200,0');
		expect(axisX(4, 5, 400)).toBe(400);
		expect(axisX(0, 1, 400)).toBe(0);
	});

	it('a flat zero series lies on the baseline; negatives clamp to 0', () => {
		expect(axisPoints([0, -5], 2, 10, 20, 0)).toBe('0,20 10,20');
	});
});

describe('donutSegments', () => {
	it('splits the circumference by share; zero slices get no length', () => {
		expect(donutSegments([3, 1, 0], 100)).toEqual([
			{ length: 75, offset: 0 },
			{ length: 25, offset: 75 },
			{ length: 0, offset: 100 }
		]);
		expect(donutSegments([0, 0], 100)).toEqual([
			{ length: 0, offset: 0 },
			{ length: 0, offset: 0 }
		]);
	});
});

describe('stackRects', () => {
	it('stacks bottom-up proportionally to the tallest stack', () => {
		expect(stackRects([50, 25], 100, 200)).toEqual([
			{ y: 100, height: 100 },
			{ y: 50, height: 50 }
		]);
		expect(stackRects([5], 0, 200)).toEqual([{ y: 200, height: 0 }]);
	});
});

describe('flowLayout (money flow, FN-35)', () => {
	const columns = [
		[
			{ key: 'in:gaji', value: 900 },
			{ key: 'in:bonus', value: 100 }
		],
		[
			{ key: 'w:bca', value: 900 },
			{ key: 'w:gopay', value: 100 }
		],
		[{ key: 'out:kopi', value: 600 }]
	];
	const links = [
		{ from: 'in:gaji', to: 'w:bca', value: 900 },
		{ from: 'in:bonus', to: 'w:gopay', value: 100 },
		{ from: 'w:bca', to: 'out:kopi', value: 500 },
		{ from: 'w:gopay', to: 'out:kopi', value: 100 }
	];

	const k = FLOW_SCALE_HEIGHT / 1000;
	/** Top-left y of a ribbon at its source and its target (its path starts `M x0,y0 C … x1,y1`). */
	const edges = (d: string) => {
		const nums = d.match(/-?[\d.]+/g)!.map(Number);
		return { x0: nums[0]!, y0: nums[1]!, x1: nums[6]!, y1: nums[7]! };
	};

	it('places the bars across the width: first after its labels, last before its labels, the middle between', () => {
		const l = flowLayout(columns, links, 640);
		expect(l.barX).toHaveLength(3);
		const label = Math.max(76, Math.round(640 * 0.24));
		expect(l.barX[0]).toBe(label);
		expect(l.barX[2]).toBe(640 - label - FLOW_BAR);
		expect(l.barX[1]).toBeCloseTo((l.barX[0]! + l.barX[2]!) / 2, 1);
		// Labels sit beside the bar, inside the width: first column on the left, the others on the right.
		for (const node of l.nodes) {
			if (node.column === 0) {
				expect(node.label.anchor).toBe('end');
				expect(node.label.x - node.label.width).toBeGreaterThanOrEqual(-0.01);
			} else {
				expect(node.label.anchor).toBe('start');
				expect(node.label.x).toBeGreaterThan(node.bar.x + node.bar.width);
				expect(node.label.x + node.label.width).toBeLessThanOrEqual(640.01);
			}
		}
		// The middle labels end before the next column's bar.
		for (const node of l.nodes.filter((x) => x.column === 1))
			expect(node.label.x + node.label.width).toBeLessThan(l.barX[2]!);
	});

	it('on a phone the right labels get a fixed column and the middle labels sit centred on their bar', () => {
		const W = 320;
		const l = flowLayout(columns, links, W);
		expect(l.barX[0]).toBe(Math.max(76, Math.round(W * 0.24)));
		expect(l.barX[2]).toBe(W - 104 - FLOW_BAR);
		for (const node of l.nodes.filter((x) => x.column === 2)) {
			expect(node.label.anchor).toBe('start');
			expect(node.label.width).toBeGreaterThanOrEqual(90);
			expect(node.label.x + node.label.width).toBeLessThanOrEqual(W + 0.01);
		}
		for (const node of l.nodes.filter((x) => x.column === 1)) {
			expect(node.label.anchor).toBe('middle');
			expect(node.label.x).toBeCloseTo(node.bar.x + FLOW_BAR / 2, 1);
			// Wider than the old squeeze between two bars, and clear of both neighbouring bars.
			expect(node.label.width).toBeGreaterThan(80);
			expect(node.label.x - node.label.width / 2).toBeGreaterThan(l.barX[0]! + FLOW_BAR);
			expect(node.label.x + node.label.width / 2).toBeLessThan(l.barX[2]!);
		}
	});

	it('two columns give their labels a wider share of the width', () => {
		const l = flowLayout(
			[[{ key: 'w:bca', value: 100 }], [{ key: 'out:kopi', value: 100 }]],
			[{ from: 'w:bca', to: 'out:kopi', value: 100 }],
			360
		);
		expect(l.barX[0]).toBe(Math.round(360 * 0.32));
		expect(l.barX[1]).toBe(360 - Math.round(360 * 0.32) - FLOW_BAR);
	});

	it('the largest column gets the full scale; every slot is a touch target; columns are centred', () => {
		const l = flowLayout(columns, links, 360);
		const gaji = l.nodes.find((x) => x.key === 'in:gaji')!;
		expect(gaji.bar.height).toBe(900 * k);
		expect(Math.min(...l.nodes.map((x) => x.height))).toBe(FLOW_MIN_NODE);
		expect(l.height).toBeGreaterThanOrEqual(Math.max(...l.nodes.map((x) => x.y + x.height)) - 0.01);
		// Kopi (one node) is centred on the tallest column.
		const kopi = l.nodes.find((x) => x.key === 'out:kopi')!;
		expect(kopi.y + kopi.height / 2).toBeCloseTo(l.height / 2, 1);
		for (const node of l.nodes) {
			expect(node.bar.y).toBeGreaterThanOrEqual(node.y - 0.01);
			expect(node.bar.y + node.bar.height).toBeLessThanOrEqual(node.y + node.height + 0.01);
		}
	});

	it('ribbons are proportional to their amount and stack inside both bars', () => {
		const l = flowLayout(columns, links, 360);
		expect(l.bands.map((b) => b.thickness)).toEqual([900 * k, 100 * k, 500 * k, 100 * k]);
		expect(l.bands[2]!.thickness / l.bands[3]!.thickness).toBeCloseTo(5, 5);
		const kopi = l.nodes.find((x) => x.key === 'out:kopi')!;
		// Two ribbons enter Kopi stacked: bca's (order 0) above gopay's, centred on the bar.
		const top = kopi.bar.y + (kopi.bar.height - 600 * k) / 2;
		expect(edges(l.bands[2]!.d).y1).toBeCloseTo(top, 1);
		expect(edges(l.bands[3]!.d).y1).toBeCloseTo(top + 500 * k, 1);
		const bca = l.nodes.find((x) => x.key === 'w:bca')!;
		expect(edges(l.bands[2]!.d).x0).toBe(bca.bar.x + FLOW_BAR);
		expect(edges(l.bands[2]!.d).x1).toBe(kopi.bar.x);
		for (const b of l.bands)
			expect(b.d).toMatch(
				/^M[\d.]+,[\d.]+ C[\d.]+,[\d.]+ [\d.]+,[\d.]+ [\d.]+,[\d.]+ L[\d.]+,[\d.]+ C[\d.]+,[\d.]+ [\d.]+,[\d.]+ [\d.]+,[\d.]+ Z$/
			);
	});

	it('a tiny amount still gets a visible ribbon of at least FLOW_MIN_BAND; the bar grows to carry it', () => {
		const l = flowLayout(
			[
				[{ key: 'in:gaji', value: 9_000_000 }],
				[{ key: 'w:bca', value: 9_000_000 }],
				[
					{ key: 'out:makan', value: 1_450_000 },
					{ key: 'out:parkir', value: 2_000 },
					{ key: 'out:kopi', value: 1_000 }
				]
			],
			[
				{ from: 'in:gaji', to: 'w:bca', value: 9_000_000 },
				{ from: 'w:bca', to: 'out:makan', value: 1_450_000 },
				{ from: 'w:bca', to: 'out:parkir', value: 2_000 },
				{ from: 'w:bca', to: 'out:kopi', value: 1_000 }
			],
			360
		);
		const scale = FLOW_SCALE_HEIGHT / 9_000_000;
		expect(l.bands[1]!.thickness).toBeCloseTo(1_450_000 * scale, 1);
		expect(l.bands[2]!.thickness).toBe(FLOW_MIN_BAND);
		expect(l.bands[3]!.thickness).toBe(FLOW_MIN_BAND);
		const parkir = l.nodes.find((x) => x.key === 'out:parkir')!;
		expect(parkir.bar.height).toBe(FLOW_MIN_BAND);
		// The outgoing stack on BCA (with the minimums) still fits its bar.
		const bca = l.nodes.find((x) => x.key === 'w:bca')!;
		const out = l.bands.slice(1).reduce((s, b) => s + b.thickness, 0);
		expect(bca.bar.height).toBeGreaterThanOrEqual(out - 0.01);
		for (const b of l.bands.slice(1)) {
			const { y0 } = edges(b.d);
			expect(y0).toBeGreaterThanOrEqual(bca.bar.y - 0.01);
			expect(y0 + b.thickness).toBeLessThanOrEqual(bca.bar.y + bca.bar.height + 0.01);
		}
	});

	it('no data: no node, no band, no height; a link to a missing node or of zero is not drawn', () => {
		expect(flowLayout([[], [], []], [], 360)).toMatchObject({ nodes: [], bands: [], height: 0 });
		const l = flowLayout(
			columns,
			[
				{ from: 'in:gaji', to: 'w:x', value: 5 },
				{ from: 'in:gaji', to: 'w:bca', value: 0 }
			],
			360
		);
		expect(l.bands).toEqual([]);
	});
});

describe('trendPoints (FN-25b)', () => {
	it('fewer than two values draw nothing (no one-point or invented flat line)', () => {
		expect(trendPoints([], 100, 50)).toEqual([]);
		expect(trendPoints([5], 100, 50)).toEqual([]);
	});

	it('scales between the series min and max, not from zero; negatives stay readable', () => {
		expect(trendPoints([100, 150, 200], 100, 50)).toEqual([
			{ x: 0, y: 50 },
			{ x: 50, y: 25 },
			{ x: 100, y: 0 }
		]);
		expect(trendPoints([-200, -100], 10, 40)).toEqual([
			{ x: 0, y: 40 },
			{ x: 10, y: 0 }
		]);
	});

	it('a flat series sits in the middle', () => {
		expect(trendPoints([7, 7, 7], 20, 30).map((p) => p.y)).toEqual([15, 15, 15]);
	});
});
