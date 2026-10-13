import { describe, expect, it } from 'vitest';
import type { CurrencyTotals, PeriodTotals } from '../transactions/aggregate';
import type { CategorySlice } from '../budgets/math';
import type { CategoryMonthTotals } from '../transactions/aggregate';
import {
	categoryGrid,
	floorPer,
	floorPercent,
	GRID_CATEGORIES,
	heatLevel,
	heatmapDays,
	laporanStats,
	monthLines,
	OTHER_KEY,
	runningTotals,
	yearLines,
	yearStack
} from './laporan';

const idr = (inMinor: number | null, outMinor: number | null): CurrencyTotals => ({
	currency: 'IDR',
	inMinor,
	outMinor
});
const period = (totals: CurrencyTotals[]): PeriodTotals => ({
	count: 0,
	expenseCount: 0,
	incomeCount: 0,
	transferCount: 0,
	adjustmentCount: 0,
	totals
});

describe('laporanStats (in, out and Selisih per currency)', () => {
	it('Selisih = in − out per currency; the report currency first, zeros when it has no rows', () => {
		const usd = { currency: 'USD', inMinor: 0, outMinor: 999 };
		expect(laporanStats(period([idr(1_000, 3_000), usd]), 'IDR')).toEqual([
			{ currency: 'IDR', inMinor: 1_000, outMinor: 3_000, netMinor: -2_000 },
			{ currency: 'USD', inMinor: 0, outMinor: 999, netMinor: -999 }
		]);
		expect(laporanStats(period([idr(5, 0)]), 'USD')).toEqual([
			{ currency: 'USD', inMinor: 0, outMinor: 0, netMinor: 0 },
			{ currency: 'IDR', inMinor: 5, outMinor: 0, netMinor: 5 }
		]);
		expect(laporanStats(period([]), 'IDR')).toEqual([
			{ currency: 'IDR', inMinor: 0, outMinor: 0, netMinor: 0 }
		]);
	});

	it('a too-large side makes Selisih too large too; an exact difference past 2^53 is null, never rounded', () => {
		expect(laporanStats(period([idr(null, 5)]), 'IDR')[0]!.netMinor).toBeNull();
		expect(laporanStats(period([idr(5, null)]), 'IDR')[0]!.netMinor).toBeNull();
		const max = Number.MAX_SAFE_INTEGER;
		expect(laporanStats(period([idr(max, 0)]), 'IDR')[0]!.netMinor).toBe(max);
		expect(laporanStats(period([idr(max, max)]), 'IDR')[0]!.netMinor).toBe(0);
		expect(laporanStats(period([idr(0, max)]), 'IDR')[0]!.netMinor).toBe(-max);
	});
});

describe('floorPercent', () => {
	it('floors (never rounds up), exact for large figures', () => {
		expect(floorPercent(2_500_000, 9_800_000)).toBe(25); // 25.51…
		expect(floorPercent(7_300_000, 9_800_000)).toBe(74); // 74.48…
		expect(floorPercent(1, 3)).toBe(33);
		expect(floorPercent(2, 3)).toBe(66); // 66.6…, never 67
		expect(floorPercent(5, 5)).toBe(100);
		const max = Number.MAX_SAFE_INTEGER;
		expect(floorPercent(max - 1, max)).toBe(99); // Number math would give 100
	});

	it('is null when a figure is too large or there is no total', () => {
		expect(floorPercent(null, 5)).toBeNull();
		expect(floorPercent(5, null)).toBeNull();
		expect(floorPercent(0, 0)).toBeNull();
	});
});

describe('floorPer (per day / per month)', () => {
	it('floors exactly; a too-large figure stays null; a zero count divides by 1', () => {
		expect(floorPer(1_000, 3)).toBe(333);
		expect(floorPer(Number.MAX_SAFE_INTEGER, 2)).toBe(4_503_599_627_370_495);
		expect(floorPer(null, 3)).toBeNull();
		expect(floorPer(7, 0)).toBe(7);
	});
});

describe('heatLevel', () => {
	it('0 for nothing, 1–4 by quarters of the largest, 4 only near the largest', () => {
		expect(heatLevel(0, 100)).toBe(0);
		expect(heatLevel(1, 100)).toBe(1);
		expect(heatLevel(25, 100)).toBe(1);
		expect(heatLevel(26, 100)).toBe(2);
		expect(heatLevel(75, 100)).toBe(3);
		expect(heatLevel(76, 100)).toBe(4);
		expect(heatLevel(100, 100)).toBe(4);
		expect(heatLevel(0, 0)).toBe(0);
	});

	it('a too-large value is the darkest; beside one, others are the lightest', () => {
		expect(heatLevel(null, 5)).toBe(4);
		expect(heatLevel(5, null)).toBe(1);
		expect(heatLevel(0, null)).toBe(0);
	});
});

describe('runningTotals', () => {
	it('adds up exactly and turns null from the first too-large value on', () => {
		expect(runningTotals([1, 2, 3])).toEqual([1, 3, 6]);
		expect(runningTotals([1, null, 3])).toEqual([1, null, null]);
		expect(runningTotals([Number.MAX_SAFE_INTEGER, 1])).toEqual([Number.MAX_SAFE_INTEGER, null]);
		expect(runningTotals([])).toEqual([]);
	});
});

const day = (date: string, outMinor: number | null, inMinor = 0) => ({
	date,
	totals: [idr(inMinor, outMinor)]
});

describe('monthLines', () => {
	it('a past month: both lines span the month; a shorter month before carries its last total', () => {
		const lines = monthLines(
			[day('2027-02-28', 300), day('2027-03-01', 100), day('2027-03-31', 200)],
			'2027-03',
			31,
			'IDR',
			'outMinor'
		);
		expect(lines.current).toHaveLength(31);
		expect(lines.previous).toHaveLength(31);
		expect(lines.current[0]).toBe(100);
		expect(lines.current.at(-1)).toBe(300);
		expect(lines.previous.slice(26)).toEqual([0, 300, 300, 300, 300]);
		expect(lines.diffMinor).toBe(0);
	});

	it('this month through today against the whole month before; the difference is at the same day', () => {
		const lines = monthLines(
			[day('2026-09-01', 50), day('2026-09-20', 999), day('2026-10-02', 70)],
			'2026-10',
			2,
			'IDR',
			'outMinor'
		);
		expect(lines.current).toEqual([0, 70]);
		expect(lines.previous).toHaveLength(31);
		expect(lines.previous.slice(0, 2)).toEqual([50, 50]);
		expect(lines.previous.at(-1)).toBe(1_049);
		expect(lines.diffMinor).toBe(20);
	});

	it('a longer month before (31 → 30 days) is cut at this month’s length', () => {
		const lines = monthLines([day('2026-10-31', 9)], '2026-11', 30, 'IDR', 'outMinor');
		expect(lines.previous).toHaveLength(30);
		expect(lines.previous.at(-1)).toBe(0);
	});

	it('reads money in for the Pemasukan direction, and only the asked currency', () => {
		const lines = monthLines(
			[{ date: '2026-10-01', totals: [idr(400, 1), { currency: 'USD', inMinor: 7, outMinor: 0 }] }],
			'2026-10',
			1,
			'IDR',
			'inMinor'
		);
		expect(lines.current).toEqual([400]);
	});

	it('a too-large day turns the running total and the difference null', () => {
		const lines = monthLines(
			[day('2026-10-01', 5), day('2026-10-02', null)],
			'2026-10',
			3,
			'IDR',
			'outMinor'
		);
		expect(lines.current).toEqual([5, null, null]);
		expect(lines.diffMinor).toBeNull();
	});
});

describe('heatmapDays', () => {
	it('every day of the month, shaded against the largest; days after today are future and blank', () => {
		const days = heatmapDays(
			[
				day('2026-09-30', 999),
				day('2026-10-01', 100),
				day('2026-10-02', 400),
				day('2026-10-20', 9)
			],
			'2026-10',
			'2026-10-08',
			'IDR',
			'outMinor'
		);
		expect(days).toHaveLength(31);
		expect(days[0]).toEqual({ date: '2026-10-01', minor: 100, level: 1, future: false });
		expect(days[1]).toEqual({ date: '2026-10-02', minor: 400, level: 4, future: false });
		expect(days[2]).toEqual({ date: '2026-10-03', minor: 0, level: 0, future: false });
		expect(days[7]!.future).toBe(false); // today
		expect(days[8]!.future).toBe(true);
		expect(days[19]).toEqual({ date: '2026-10-20', minor: 9, level: 0, future: true });
	});

	it('an empty month is all zeros; a leap February has 29 days', () => {
		const days = heatmapDays([], '2028-02', '2028-03-01', 'IDR', 'outMinor');
		expect(days).toHaveLength(29);
		expect(days.every((d) => d.minor === 0 && d.level === 0 && !d.future)).toBe(true);
	});
});

const month = (m: string, outMinor: number | null) => ({ month: m, totals: [idr(0, outMinor)] });

describe('yearLines', () => {
	it('the year so far against the whole year before, by month; difference at the same month', () => {
		const lines = yearLines(
			[month('2026-01', 10), month('2026-03', 5)],
			[month('2025-02', 4), month('2025-12', 100)],
			['2026-01', '2026-02', '2026-03'],
			'2025',
			'IDR',
			'outMinor'
		);
		expect(lines.current).toEqual([10, 10, 15]);
		expect(lines.previous).toHaveLength(12);
		expect(lines.previous.slice(0, 3)).toEqual([0, 4, 4]);
		expect(lines.previous.at(-1)).toBe(104);
		expect(lines.diffMinor).toBe(11);
	});
});

const slice = (key: string, minor: number): CategorySlice => ({
	key,
	tileKey: 'lain',
	name: key || null,
	isPreset: false,
	minor
});
const cm = (m: string, key: string, outMinor: number | null): CategoryMonthTotals => ({
	month: m,
	category: key ? { id: key, name: key, tileKey: 'lain', isPreset: false } : null,
	totals: [idr(0, outMinor)]
});

describe('yearStack', () => {
	const months = ['2026-01', '2026-02'];

	it('top 4 categories plus Lainnya; segments add up to the month total; floor average', () => {
		const slices = ['a', 'b', 'c', 'd', 'e', ''].map((k, i) => slice(k, 100 - i));
		const rows = [
			cm('2026-01', 'a', 10),
			cm('2026-01', 'e', 3),
			cm('2026-01', '', 4),
			cm('2026-02', 'd', 2)
		];
		const r = yearStack(rows, slices, months, 'IDR', 'outMinor');
		expect(r.stackKeys).toEqual(['a', 'b', 'c', 'd', OTHER_KEY]);
		expect(r.stack[0]).toEqual({
			month: '2026-01',
			segments: [
				{ key: 'a', minor: 10 },
				{ key: 'b', minor: 0 },
				{ key: 'c', minor: 0 },
				{ key: 'd', minor: 0 },
				{ key: OTHER_KEY, minor: 7 }
			],
			total: 17
		});
		expect(r.stack[1]!.total).toBe(2);
		expect(r.averageMinor).toBe(9); // floor(19 / 2)
	});

	it('no Lainnya segment with 4 categories or fewer; an empty year is zeros', () => {
		const r = yearStack([cm('2026-02', 'a', 5)], [slice('a', 5)], months, 'IDR', 'outMinor');
		expect(r.stackKeys).toEqual(['a']);
		expect(r.stack.map((m) => m.total)).toEqual([0, 5]);
		const empty = yearStack([], [], months, 'IDR', 'outMinor');
		expect(empty.stack.map((m) => m.segments)).toEqual([[], []]);
		expect(empty.averageMinor).toBe(0);
	});

	it('a too-large cell makes its segment, month total and the average null', () => {
		const r = yearStack([cm('2026-01', 'a', null)], [slice('a', 1)], months, 'IDR', 'outMinor');
		expect(r.stack[0]!.total).toBeNull();
		expect(r.averageMinor).toBeNull();
	});
});

describe('categoryGrid', () => {
	it('one row per category up to the cap, then Lainnya; levels against the table maximum; row totals', () => {
		const keys = Array.from({ length: GRID_CATEGORIES + 2 }, (_, i) => `k${i}`);
		const slices = keys.map((k, i) => slice(k, 1_000 - i));
		const rows = [
			cm('2026-01', 'k0', 400),
			cm('2026-02', 'k0', 100),
			cm('2026-02', `k${GRID_CATEGORIES}`, 7),
			cm('2026-02', `k${GRID_CATEGORIES + 1}`, 3)
		];
		const grid = categoryGrid(rows, slices, ['2026-01', '2026-02'], 'IDR', 'outMinor');
		expect(grid).toHaveLength(GRID_CATEGORIES + 1);
		expect(grid[0]).toMatchObject({
			key: 'k0',
			cells: [
				{ minor: 400, level: 4 },
				{ minor: 100, level: 1 }
			],
			total: 500
		});
		expect(grid.at(-1)).toMatchObject({
			key: OTHER_KEY,
			cells: [
				{ minor: 0, level: 0 },
				{ minor: 10, level: 1 }
			],
			total: 10
		});
	});
});
