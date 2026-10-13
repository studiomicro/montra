import { describe, expect, it } from 'vitest';
import { budgetDayStatus, countBudgetStreak } from './streak';

describe('budgetDayStatus (FN-34b owner decision F)', () => {
	// October 2026 has 31 days; on the 22nd, 10 days remain (22nd included).
	it('within at or under the floored allowance, over above it', () => {
		// 3,100,000 budget, 1,000,000 spent through the 21st: allowance floor(2,100,000 / 10) = 210,000.
		expect(budgetDayStatus(3_100_000, 1_000_000, 210_000, '2026-10-22')).toBe('within');
		expect(budgetDayStatus(3_100_000, 1_000_000, 210_001, '2026-10-22')).toBe('over');
		expect(budgetDayStatus(3_100_000, 1_000_000, 0, '2026-10-22')).toBe('within');
	});

	it('floors the allowance, never more generous than the real remainder', () => {
		// 1,000,001 left over 10 days: 100,000 per day (not 100,000.1).
		expect(budgetDayStatus(2_000_001, 1_000_000, 100_000, '2026-10-22')).toBe('within');
		expect(budgetDayStatus(2_000_001, 1_000_000, 100_001, '2026-10-22')).toBe('over');
	});

	it('a budget spent past before the day makes the day over whatever it spent', () => {
		expect(budgetDayStatus(1_000_000, 1_000_001, 0, '2026-10-22')).toBe('over');
	});

	it('exactly spent before the day: the allowance is 0, so only a day without spending is within', () => {
		expect(budgetDayStatus(1_000_000, 1_000_000, 0, '2026-10-22')).toBe('within');
		expect(budgetDayStatus(1_000_000, 1_000_000, 1, '2026-10-22')).toBe('over');
	});

	it('too large to show (null) is over every budget', () => {
		expect(budgetDayStatus(1_000_000, null, 0, '2026-10-22')).toBe('over');
		expect(budgetDayStatus(1_000_000, 0, null, '2026-10-22')).toBe('over');
	});

	it('the last WIB day of a month gets the whole remainder (its own month length)', () => {
		expect(budgetDayStatus(3_000_000, 2_500_000, 500_000, '2026-10-31')).toBe('within');
		expect(budgetDayStatus(2_800_000, 2_500_000, 300_000, '2026-02-28')).toBe('within');
		// On 1 Oct the whole budget is split over 31 days.
		expect(budgetDayStatus(3_100_000, 0, 100_000, '2026-10-01')).toBe('within');
		expect(budgetDayStatus(3_100_000, 0, 100_001, '2026-10-01')).toBe('over');
	});
});

describe('countBudgetStreak', () => {
	const d = (date: string, status: 'within' | 'over') => ({ date, status });

	it('counts within days through yesterday; an over day resets; today and later are never counted', () => {
		const days = [
			d('2026-10-01', 'within'),
			d('2026-10-02', 'within'),
			d('2026-10-03', 'within'),
			d('2026-10-04', 'over'),
			d('2026-10-05', 'within'),
			d('2026-10-06', 'within'),
			d('2026-10-07', 'within')
		];
		expect(countBudgetStreak(days, '2026-10-07')).toEqual({ current: 2, longest: 3 });
		expect(countBudgetStreak(days, '2026-10-08')).toEqual({ current: 3, longest: 3 });
	});

	it('a day without a verdict (no budget) is a skip, never a break', () => {
		const days = [d('2026-10-01', 'within'), d('2026-10-02', 'within'), d('2026-10-09', 'within')];
		expect(countBudgetStreak(days, '2026-10-10')).toEqual({ current: 3, longest: 3 });
	});

	it('order of the rows does not matter; no rows is 0', () => {
		expect(
			countBudgetStreak([d('2026-10-02', 'over'), d('2026-10-01', 'within')], '2026-10-03')
		).toEqual({ current: 0, longest: 1 });
		expect(countBudgetStreak([], '2026-10-03')).toEqual({ current: 0, longest: 0 });
	});
});
