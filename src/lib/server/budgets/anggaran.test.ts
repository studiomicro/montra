import { describe, expect, it } from 'vitest';
import type { CategorySummary } from '../categories/repo';
import type { CategoryTotals, CurrencyTotals, PeriodTotals } from '../transactions/aggregate';
import { anggaranFigures } from './anggaran';

const idr = (outMinor: number | null): CurrencyTotals => ({
	currency: 'IDR',
	inMinor: 0,
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
const cat = (id: string, over: Partial<CategorySummary> = {}): CategorySummary => ({
	id,
	kind: 'expense',
	name: `Kategori ${id}`,
	tileKey: 'makan',
	isPreset: false,
	isHidden: false,
	updatedAt: 1,
	...over
});
const spend = (id: string, totals: CurrencyTotals[]): CategoryTotals => ({
	category: { id, name: `Kategori ${id}`, tileKey: 'makan', isPreset: false },
	totals
});
const base = {
	today: '2026-10-08',
	currency: 'IDR',
	budget: null,
	monthTotals: period([]),
	categories: [] as CategorySummary[],
	spending: [] as CategoryTotals[],
	categoryBudgets: []
};

describe('anggaranFigures', () => {
	it('the period is the WIB month of today, with the days after today and the pace', () => {
		const f = anggaranFigures(base);
		expect(f).toMatchObject({ from: '2026-10-01', to: '2026-10-31', daysLeft: 23, pace: 25 });
		expect(anggaranFigures({ ...base, today: '2026-10-31' }).daysLeft).toBe(0);
		expect(f.total).toBeNull();
		expect(f.safeToSpend).toBeNull();
	});

	it('the total uses the same month total as Beranda, in the budget currency only', () => {
		const f = anggaranFigures({
			...base,
			budget: { amountMinor: 650_000_000, currency: 'IDR', updatedAt: 5 },
			monthTotals: period([idr(153_000_000), usd(9_999)])
		});
		expect(f.total).toMatchObject({ spentMinor: 153_000_000, remainingMinor: 497_000_000 });
		expect(f.safeToSpend).toMatchObject({ kind: 'left', remainingMinor: 497_000_000, days: 24 });
		expect(f.currency).toBe('IDR');
	});

	it('budgeted categories compare their own currency; others are listed without a budget', () => {
		const f = anggaranFigures({
			...base,
			categories: [
				cat('a'),
				cat('b'),
				cat('c'),
				cat('hidden', { isHidden: true }),
				cat('gaji', { kind: 'income' })
			],
			spending: [
				spend('a', [idr(83_600_000), usd(500)]),
				spend('b', [idr(10_000)]),
				spend('c', [idr(90_000)])
			],
			categoryBudgets: [
				{ categoryId: 'a', amountMinor: 120_000_000, currency: 'IDR', updatedAt: 1 },
				// A budget for a category that is gone (or another space's) is ignored.
				{ categoryId: 'gone', amountMinor: 5, currency: 'IDR', updatedAt: 1 }
			]
		});
		expect(f.categories).toHaveLength(1);
		expect(f.categories[0]).toMatchObject({
			categoryId: 'a',
			progress: { spentMinor: 83_600_000, remainingMinor: 36_400_000, state: 'ahead' }
		});
		// Most spent first; hidden and income categories never appear.
		expect(f.unbudgeted.map((c) => [c.categoryId, c.spentMinor])).toEqual([
			['c', 90_000],
			['b', 10_000]
		]);
	});

	it('a hidden category with a budget still shows its budget', () => {
		const f = anggaranFigures({
			...base,
			categories: [cat('h', { isHidden: true })],
			categoryBudgets: [{ categoryId: 'h', amountMinor: 100, currency: 'IDR', updatedAt: 1 }]
		});
		expect(f.categories.map((c) => c.categoryId)).toEqual(['h']);
		expect(f.unbudgeted).toEqual([]);
	});

	it('spending too large to show sorts first and stays null', () => {
		const f = anggaranFigures({
			...base,
			categories: [cat('a'), cat('b')],
			spending: [spend('a', [idr(5)]), spend('b', [idr(null)])]
		});
		expect(f.unbudgeted.map((c) => [c.categoryId, c.spentMinor])).toEqual([
			['b', null],
			['a', 5]
		]);
	});

	it('without a budget the page currency is the favourite wallet currency passed in', () => {
		const f = anggaranFigures({
			...base,
			currency: 'USD',
			categories: [cat('a')],
			spending: [spend('a', [idr(7), usd(3)])]
		});
		expect(f.currency).toBe('USD');
		expect(f.unbudgeted[0]?.spentMinor).toBe(3);
	});
});
