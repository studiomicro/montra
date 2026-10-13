import { describe, expect, it } from 'vitest';
import { budgetSafeCelebrates, dayClosedCelebrates, transactionSavedHop } from './mascot-moments';

describe('Koko reacts only to a server-confirmed success (FN-44 Part 3)', () => {
	it('Riwayat: a hop only after the redirect of a new transaction', () => {
		expect(transactionSavedHop('created')).toBe(true);
		for (const saved of ['updated', 'deleted', 'adjusted', '', null, undefined])
			expect(transactionSavedHop(saved), String(saved)).toBe(false);
	});

	it('Beranda: a celebration only right after ?/closeDay answered — not on a later plain load', () => {
		expect(dayClosedCelebrates({ saved: 'closed' })).toBe(true);
		expect(dayClosedCelebrates(null)).toBe(false); // a reload of an already closed day
		expect(dayClosedCelebrates(undefined)).toBe(false);
		expect(dayClosedCelebrates({ saved: 'set' })).toBe(false); // a budget save on Beranda
		expect(dayClosedCelebrates({ error: 'x' })).toBe(false);
	});

	it.each([
		['left', true],
		['spent', false],
		['over', false]
	] as const)('Anggaran: monthly budget saved with safe-to-spend "%s" → %s', (kind, expected) => {
		expect(budgetSafeCelebrates({ saved: 'set' }, { kind })).toBe(expected);
	});

	it('Anggaran: nothing for other results, a refusal, no budget or before any save', () => {
		const left = { kind: 'left' as const };
		for (const saved of ['deleted', 'categorySet', 'categoryDeleted'])
			expect(budgetSafeCelebrates({ saved }, left), saved).toBe(false);
		expect(budgetSafeCelebrates({ error: 'x', action: 'setBudget' }, left)).toBe(false);
		expect(budgetSafeCelebrates({ saved: 'set' }, null)).toBe(false);
		expect(budgetSafeCelebrates(null, left)).toBe(false);
	});
});
