import { describe, expect, it } from 'vitest';
import { formatMonthName, formatShortDay, wibTodayString } from '#lib/shared/dates';
import type { CurrencyTotals, PeriodTotals } from '../transactions/aggregate';
import {
	berandaFigures,
	budgetProgress,
	comparisonWindows,
	dayOfMonth,
	daysInMonth,
	daysRemainingInclusive,
	lastDays,
	pacePercent,
	safeToSpend
} from './math';

const idr = (outMinor: number | null, inMinor = 0): CurrencyTotals => ({
	currency: 'IDR',
	inMinor,
	outMinor
});
const usd = (outMinor: number): CurrencyTotals => ({ currency: 'USD', inMinor: 0, outMinor });
const period = (totals: CurrencyTotals[]): PeriodTotals => ({
	count: 0,
	expenseCount: 0,
	incomeCount: 0,
	transferCount: 0,
	adjustmentCount: 0,
	totals
});

/** UTC epoch ms of a WIB wall-clock time (WIB = UTC+7). */
const wib = (iso: string) => Date.parse(`${iso}+07:00`);

describe('WIB day and month vectors', () => {
	it('23:30 WIB on the last day is still that day: day 31, one day left', () => {
		const today = wibTodayString(wib('2026-10-31T23:30:00'));
		expect(today).toBe('2026-10-31');
		expect(dayOfMonth(today)).toBe(31);
		expect(daysRemainingInclusive(today)).toBe(1);
	});

	it('00:30 WIB on the 1st is the new month even though UTC is still the previous day', () => {
		const instant = wib('2026-11-01T00:30:00');
		expect(new Date(instant).toISOString().slice(0, 10)).toBe('2026-10-31');
		const today = wibTodayString(instant);
		expect(today).toBe('2026-11-01');
		expect(dayOfMonth(today)).toBe(1);
		expect(daysRemainingInclusive(today)).toBe(30);
	});

	it('month lengths, leap February included', () => {
		expect(daysInMonth('2026-02')).toBe(28);
		expect(daysInMonth('2028-02')).toBe(29);
		expect(daysInMonth('2026-10')).toBe(31);
		expect(daysInMonth('2026-09')).toBe(30);
		expect(daysRemainingInclusive('2026-02-28')).toBe(1);
		expect(daysRemainingInclusive('2026-10-08')).toBe(24);
	});

	it('month names and short day labels in both languages', () => {
		expect(formatMonthName('2026-10', 'id')).toBe('Oktober');
		expect(formatMonthName('2026-10', 'en')).toBe('October');
		expect(formatShortDay('2026-10-08', 'en')).toBe('8 Oct');
	});
});

describe('safeToSpend (floor, never a negative daily figure)', () => {
	it('splits what is left over the remaining days, rounded down', () => {
		// Rp 1.000.000 left over 3 days = Rp 333.333,33… → floor to the sen, never up.
		expect(safeToSpend(150_000_000, 50_000_000, '2026-10-29')).toEqual({
			kind: 'left',
			remainingMinor: 100_000_000,
			perDayMinor: 33_333_333,
			days: 3
		});
		const r = safeToSpend(100, 0, '2026-10-29');
		expect(r).toMatchObject({ perDayMinor: 33 });
	});

	it('on the last day the whole remainder is for today', () => {
		expect(safeToSpend(10_000_000, 4_000_000, '2026-10-31')).toMatchObject({
			kind: 'left',
			perDayMinor: 6_000_000,
			days: 1
		});
	});

	it('exactly spent and over budget', () => {
		expect(safeToSpend(10_000_000, 10_000_000, '2026-10-08')).toEqual({ kind: 'spent' });
		expect(safeToSpend(10_000_000, 12_500_000, '2026-10-08')).toEqual({
			kind: 'over',
			overMinor: 2_500_000
		});
	});
});

describe('comparisonWindows (same days last month, cut at its length)', () => {
	it('the 8th compares with the 1st–8th of last month', () => {
		expect(comparisonWindows('2026-10-08')).toEqual({
			thisMonth: { from: '2026-10-01', to: '2026-10-08' },
			lastMonth: { from: '2026-09-01', to: '2026-09-08' }
		});
	});

	it('the 31st compares with all of a 30-day month', () => {
		expect(comparisonWindows('2026-10-31').lastMonth).toEqual({
			from: '2026-09-01',
			to: '2026-09-30'
		});
	});

	it('29–31 March compare with all of February (28 or 29 days)', () => {
		expect(comparisonWindows('2026-03-31').lastMonth.to).toBe('2026-02-28');
		expect(comparisonWindows('2026-03-29').lastMonth.to).toBe('2026-02-28');
		expect(comparisonWindows('2026-03-28').lastMonth.to).toBe('2026-02-28');
		expect(comparisonWindows('2028-03-30').lastMonth.to).toBe('2028-02-29');
	});

	it('January compares with December of the year before', () => {
		expect(comparisonWindows('2027-01-05').lastMonth).toEqual({
			from: '2026-12-01',
			to: '2026-12-05'
		});
	});
});

describe('lastDays', () => {
	it('14 WIB dates ending today, oldest first, across a month boundary', () => {
		const days = lastDays('2026-11-03');
		expect(days).toHaveLength(14);
		expect(days[0]).toBe('2026-10-21');
		expect(days.at(-1)).toBe('2026-11-03');
	});
});

describe('berandaFigures', () => {
	const base = {
		today: '2026-10-03',
		currency: 'IDR',
		budget: null,
		categories: []
	};

	it('sums only the hero currency; other currencies are listed, never added', () => {
		const f = berandaFigures({
			...base,
			monthTotals: period([idr(9_000_000, 5_000_000), usd(1_250)]),
			daily: []
		});
		expect(f.spentMinor).toBe(9_000_000);
		expect(f.otherCurrencies).toEqual([{ currency: 'USD', outMinor: 1_250 }]);
	});

	it('compares month-to-date with the same days last month; average is floor(S / N)', () => {
		const f = berandaFigures({
			...base,
			monthTotals: period([idr(1_000_001)]),
			daily: [
				{ date: '2026-09-02', totals: [idr(400_000)] },
				{ date: '2026-09-04', totals: [idr(9_999_999)] }, // after the same days: not compared
				{ date: '2026-10-01', totals: [idr(1_000_000), usd(99)] },
				{ date: '2026-10-03', totals: [idr(1)] }
			]
		});
		expect(f.diffMinor).toBe(1_000_001 - 400_000);
		expect(f.avgPerDayMinor).toBe(333_333);
		expect(f.dayOfMonth).toBe(3);
		expect(f.lines).toEqual({
			thisMonth: [1_000_000, 1_000_000, 1_000_001],
			lastMonth: [0, 400_000, 400_000]
		});
		expect(f.bars).toHaveLength(14);
		expect(f.bars.at(-1)).toEqual({ date: '2026-10-03', minor: 1 });
		expect(f.bars.find((b) => b.date === '2026-09-24')).toEqual({ date: '2026-09-24', minor: 0 });
	});

	it('lines are cut to the shorter month so both series align by day', () => {
		const f = berandaFigures({
			...base,
			today: '2026-03-31',
			monthTotals: period([]),
			daily: []
		});
		expect(f.lines.thisMonth).toHaveLength(28);
		expect(f.lines.lastMonth).toHaveLength(28);
	});

	it('safe-to-spend reads the budget’s own currency', () => {
		const f = berandaFigures({
			...base,
			today: '2026-10-31',
			budget: { amountMinor: 10_000, currency: 'USD', updatedAt: 1 },
			monthTotals: period([idr(5_000_000), usd(2_500)]),
			daily: []
		});
		expect(f.safeToSpend).toEqual({
			kind: 'left',
			remainingMinor: 7_500,
			perDayMinor: 7_500,
			days: 1
		});
	});

	it('categories in the hero currency, largest first, empty ones dropped', () => {
		const cat = (id: string, tileKey: 'kopi' | 'makan') => ({
			id,
			name: id,
			tileKey,
			isPreset: false
		});
		const f = berandaFigures({
			...base,
			monthTotals: period([]),
			daily: [],
			categories: [
				{ category: cat('a', 'kopi'), totals: [idr(100)] },
				{ category: cat('b', 'makan'), totals: [idr(300)] },
				{ category: null, totals: [idr(200)] },
				{ category: cat('c', 'kopi'), totals: [usd(900)] }
			]
		});
		expect(f.categories.map((c) => [c.key, c.tileKey, c.minor])).toEqual([
			['b', 'makan', 300],
			['', 'lain', 200],
			['a', 'kopi', 100]
		]);
	});
});

describe('too large to show (null) never becomes a number', () => {
	const MAX = Number.MAX_SAFE_INTEGER;

	it('spending too large is over every budget, by an amount not shown', () => {
		expect(safeToSpend(10_000_000, null, '2026-10-08')).toEqual({ kind: 'over', overMinor: null });
	});

	it('a null day, or safe days summing past 2^53, makes the month figures null', () => {
		const f = berandaFigures({
			today: '2026-10-02',
			currency: 'IDR',
			budget: { amountMinor: 100, currency: 'IDR', updatedAt: 1 },
			monthTotals: period([idr(null), usd(5)]),
			daily: [
				{ date: '2026-09-01', totals: [idr(null)] },
				{ date: '2026-10-01', totals: [idr(MAX)] },
				{ date: '2026-10-02', totals: [idr(1)] }
			],
			categories: [
				{ category: null, totals: [idr(5)] },
				{
					category: { id: 'x', name: 'x', tileKey: 'kopi', isPreset: false },
					totals: [idr(null)]
				}
			]
		});
		expect(f.spentMinor).toBeNull();
		expect(f.safeToSpend).toEqual({ kind: 'over', overMinor: null });
		expect(f.diffMinor).toBeNull(); // MAX + 1 is past the safe range
		expect(f.avgPerDayMinor).toBeNull();
		expect(f.bars.slice(-2).map((b) => b.minor)).toEqual([MAX, 1]);
		expect(f.lines).toEqual({ thisMonth: [MAX, null], lastMonth: [null, null] });
		expect(f.categories.map((c) => c.minor)).toEqual([null, 5]);
	});

	it('a safe month next to a too-large other currency keeps its own figures', () => {
		const f = berandaFigures({
			today: '2026-10-02',
			currency: 'IDR',
			budget: null,
			monthTotals: period([idr(300), { currency: 'USD', inMinor: 0, outMinor: null }]),
			daily: [{ date: '2026-10-02', totals: [idr(300)] }],
			categories: []
		});
		expect(f.spentMinor).toBe(300);
		expect(f.avgPerDayMinor).toBe(150);
		expect(f.otherCurrencies).toEqual([{ currency: 'USD', outMinor: null }]);
	});
});

describe('pacePercent (Anggaran pace marker)', () => {
	it('counts today as gone and rounds down', () => {
		expect(pacePercent('2026-10-08')).toBe(25); // 8 / 31
		expect(pacePercent('2026-10-01')).toBe(3); // 1 / 31
		expect(pacePercent('2026-10-31')).toBe(100);
		expect(pacePercent('2026-02-14')).toBe(50); // 14 / 28
	});
});

describe('budgetProgress (Anggaran)', () => {
	it('on pace: remaining, used percent and the month-end projection', () => {
		// Rp 6.500.000 budget, Rp 1.530.000 spent by 8 October: projected 1.530.000 × 31 / 8.
		expect(budgetProgress(650_000_000, 153_000_000, '2026-10-08')).toEqual({
			budgetMinor: 650_000_000,
			spentMinor: 153_000_000,
			remainingMinor: 497_000_000,
			usedPercent: 23,
			projectedMinor: 592_875_000,
			state: 'ok'
		});
	});

	it('ahead of pace: within the budget but projected past it', () => {
		const p = budgetProgress(120_000_000, 83_600_000, '2026-10-20');
		expect(p.state).toBe('ahead');
		expect(p.remainingMinor).toBe(36_400_000);
		expect(p.projectedMinor).toBe(129_580_000);
	});

	it('exactly the budget on the last day is on pace; one sen more is over', () => {
		expect(budgetProgress(1_000, 1_000, '2026-10-31').state).toBe('ok');
		const over = budgetProgress(1_000, 1_001, '2026-10-31');
		expect(over).toMatchObject({ state: 'over', remainingMinor: -1, usedPercent: 100 });
	});

	it('nothing spent is on pace with a zero projection', () => {
		expect(budgetProgress(1_000, 0, '2026-10-01')).toMatchObject({
			state: 'ok',
			usedPercent: 0,
			projectedMinor: 0,
			remainingMinor: 1_000
		});
	});

	it('spending too large to show is over, with no rounded figure', () => {
		expect(budgetProgress(1_000, null, '2026-10-08')).toEqual({
			budgetMinor: 1_000,
			spentMinor: null,
			remainingMinor: null,
			usedPercent: 100,
			projectedMinor: null,
			state: 'over'
		});
	});

	it('a projection past 2^53 is null and reads as ahead of pace', () => {
		const p = budgetProgress(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, '2026-10-01');
		expect(p).toMatchObject({ projectedMinor: null, state: 'ahead' });
	});

	it('uses the WIB month of today: 31 Jan vs 1 Feb', () => {
		expect(budgetProgress(3_100, 100, '2026-01-31').projectedMinor).toBe(100);
		expect(budgetProgress(3_100, 100, '2026-02-01').projectedMinor).toBe(2_800);
	});
});
