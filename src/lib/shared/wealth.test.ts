import { describe, expect, it } from 'vitest';
import type { NetWorthClass, NetWorthKind } from './net-worth';
import {
	allocationOf,
	missingSuggestions,
	parseTrendRange,
	sectionOfKind,
	trendRangeStart
} from './wealth';

describe('trend ranges', () => {
	it('reads the four ranges and falls back to 1 month for anything else', () => {
		expect(['1m', '3m', '1y', 'all'].map(parseTrendRange)).toEqual(['1m', '3m', '1y', 'all']);
		for (const bad of [null, '', '1M', 'ALL', '6m', '1m ', 'constructor'])
			expect(parseTrendRange(bad)).toBe('1m');
	});

	it('starts the day after the same day n months earlier, from the WIB date', () => {
		expect(trendRangeStart('1m', '2026-10-11')).toBe('2026-09-12');
		expect(trendRangeStart('3m', '2026-10-11')).toBe('2026-07-12');
		expect(trendRangeStart('1y', '2026-10-11')).toBe('2025-10-12');
		expect(trendRangeStart('all', '2026-10-11')).toBeNull();
	});

	it('clamps to the shorter month and crosses year boundaries', () => {
		// 31 Mar → 28 Feb (2026 is no leap year) → starts 1 Mar.
		expect(trendRangeStart('1m', '2026-03-31')).toBe('2026-03-01');
		// 31 Mar 2028 → 29 Feb 2028 (leap) → starts 1 Mar.
		expect(trendRangeStart('1m', '2028-03-31')).toBe('2028-03-01');
		expect(trendRangeStart('1m', '2026-01-15')).toBe('2025-12-16');
		expect(trendRangeStart('3m', '2026-05-31')).toBe('2026-03-01');
		// The last day of a month: 1 month back from 1 Nov starts on 2 Oct.
		expect(trendRangeStart('1m', '2026-11-01')).toBe('2026-10-02');
	});
});

const cls = (c: NetWorthClass, minor: number | null) => ({ cls: c, minor });

describe('allocationOf', () => {
	it('splits assets only: debts are lines under the bar, never a segment or in the denominator', () => {
		const a = allocationOf([
			cls('wallets', 21_621_500_00),
			cls('cash', 3_643_000_00),
			cls('investment', 4_937_500_00),
			cls('crypto', 5_195_398_00),
			cls('gold', 1_000_000_00),
			cls('property', 18_500_000_00),
			cls('debt', -250_000_000_00)
		]);
		expect(a.slices.map((s) => s.cls)).toEqual([
			'wallets',
			'cash',
			'investment',
			'crypto',
			'gold',
			'property'
		]);
		const sum = a.slices.reduce((s, x) => s + BigInt(x.minor), 0n);
		expect(BigInt(a.assetsMinor!)).toBe(sum);
		expect(a.assetsMinor).toBe(54_897_398_00);
		expect(a.slices.reduce((s, x) => s + x.pct, 0)).toBe(100);
		expect(a.outside).toEqual([cls('debt', -250_000_000_00)]);
	});

	it('percentages add up to exactly 100 with the largest remainders (thirds)', () => {
		const a = allocationOf([cls('wallets', 1), cls('cash', 1), cls('gold', 1)]);
		expect(a.slices.map((s) => s.pct)).toEqual([34, 33, 33]);
	});

	it('a tiny class keeps its segment and shows 0 (the chip says "<1%")', () => {
		const a = allocationOf([cls('wallets', 1_000_000_00), cls('crypto', 1_00)]);
		expect(a.slices.map((s) => s.pct)).toEqual([100, 0]);
		expect(a.slices).toHaveLength(2);
	});

	it('an overdrawn class and a too-large class stay outside the bar; zero is left out', () => {
		const a = allocationOf([
			cls('wallets', -5_000_00),
			cls('cash', 0),
			cls('property', null),
			cls('gold', 10_00)
		]);
		expect(a.slices).toEqual([{ cls: 'gold', minor: 10_00, pct: 100 }]);
		expect(a.outside).toEqual([cls('wallets', -5_000_00), cls('property', null)]);
	});

	it('new user and debt-only spaces: no bar, no invented 0 %', () => {
		expect(allocationOf([])).toEqual({ slices: [], assetsMinor: null, outside: [] });
		expect(allocationOf([cls('debt', -1_000_00)])).toEqual({
			slices: [],
			assetsMinor: null,
			outside: [cls('debt', -1_000_00)]
		});
	});

	it('stays exact past 2^53 in the percentage arithmetic', () => {
		const big = Number.MAX_SAFE_INTEGER - 1;
		const a = allocationOf([cls('wallets', big), cls('property', 1)]);
		expect(a.slices.map((s) => s.pct)).toEqual([100, 0]);
		expect(a.assetsMinor).toBe(Number.MAX_SAFE_INTEGER);
	});
});

describe('sectionOfKind', () => {
	it('stocks and gold are Investasi, crypto Kripto, the rest stays per kind', () => {
		const kinds: NetWorthKind[] = [
			'cash',
			'investment_stock',
			'investment_crypto',
			'investment_gold',
			'property',
			'vehicle',
			'debt',
			'other_asset'
		];
		expect(kinds.map(sectionOfKind)).toEqual([
			null,
			'investment',
			'crypto',
			'investment',
			null,
			null,
			null,
			null
		]);
	});
});

const item = (kind: NetWorthKind, name: string, isDemo = false) => ({ kind, name, isDemo });

describe('missingSuggestions', () => {
	it('a new user sees both cards', () => {
		expect(missingSuggestions([])).toEqual(['gold', 'pension']);
	});

	it('a gold item hides the gold card; a pension-named item hides the pension card', () => {
		expect(missingSuggestions([item('investment_gold', 'Antam 10 g')])).toEqual(['pension']);
		for (const name of ['BPJS Ketenagakerjaan', 'Saldo JHT', 'dplk bni', 'Dana Pensiun', 'Pension'])
			expect(missingSuggestions([item('other_asset', name)])).toEqual(['gold']);
		expect(
			missingSuggestions([item('investment_gold', 'Emas'), item('other_asset', 'JHT')])
		).toEqual([]);
	});

	it('a Data demo item never hides a card; an unrelated name does not either', () => {
		expect(
			missingSuggestions([item('investment_gold', 'Emas', true), item('other_asset', 'BPJS', true)])
		).toEqual(['gold', 'pension']);
		expect(missingSuggestions([item('property', 'Rumah')])).toEqual(['gold', 'pension']);
	});
});
