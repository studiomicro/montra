import { describe, expect, it } from 'vitest';
import { budgetUsedPercent } from './budget-progress';

describe('budgetUsedPercent', () => {
	it('is the used share of the budget, rounded down', () => {
		expect(budgetUsedPercent(300_000_000, { kind: 'left', remainingMinor: 300_000_000 })).toBe(0);
		expect(budgetUsedPercent(300_000_000, { kind: 'left', remainingMinor: 200_000_000 })).toBe(33);
		expect(budgetUsedPercent(300_000_000, { kind: 'left', remainingMinor: 1 })).toBe(99);
	});
	it('is full once the budget is spent or passed', () => {
		expect(budgetUsedPercent(300_000_000, { kind: 'spent' })).toBe(100);
		expect(budgetUsedPercent(300_000_000, { kind: 'over' })).toBe(100);
	});
	it('stays exact at the 10^13 budget cap', () => {
		const cap = 10_000_000_000_000;
		expect(budgetUsedPercent(cap, { kind: 'left', remainingMinor: cap / 4 })).toBe(75);
	});
});
