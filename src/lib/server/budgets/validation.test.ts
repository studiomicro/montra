import { describe, expect, it } from 'vitest';
import {
	BUDGET_AMOUNT_INVALID,
	BUDGET_AMOUNT_INVALID_CENTS,
	BUDGET_CURRENCY_INVALID,
	BUDGET_TOO_LARGE
} from './messages';
import { expectedUpdatedAt, parseBudgetForm } from './validation';

const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};

describe('parseBudgetForm', () => {
	it('reads whole units of the form’s currency as minor units', () => {
		expect(parseBudgetForm(form({ amount: '5.000.000', currency: 'IDR' }), 'id')).toEqual({
			ok: true,
			value: { amountMinor: 500_000_000, currency: 'IDR' }
		});
		expect(parseBudgetForm(form({ amount: '1200', currency: 'JPY' }), 'id')).toEqual({
			ok: true,
			value: { amountMinor: 1_200, currency: 'JPY' }
		});
		// The cap is one transaction's: 10^13 minor units (Rp 100.000.000.000) is still accepted.
		expect(
			parseBudgetForm(form({ amount: '100.000.000.000', currency: 'IDR' }), 'id')
		).toMatchObject({
			ok: true,
			value: { amountMinor: 10_000_000_000_000 }
		});
	});

	it('refuses an amount past the 10^13 cap (L2: the same cap as one transaction)', () => {
		for (const amount of ['100.000.000.001', '9999999999999'])
			expect(parseBudgetForm(form({ amount, currency: 'IDR' }), 'id')).toEqual({
				ok: false,
				error: BUDGET_TOO_LARGE
			});
	});

	it.each([
		['blank', ''],
		['zero', '0'],
		['zeros', '000.000'],
		['negative', '-50.000'],
		['decimal comma', '50.000,50'],
		['decimal point', '12.50'],
		['spaces', '1 200'],
		['letters', '50rb'],
		['14 digits', '12345678901234']
	])('refuses %s (shared wholeAmountMinor contract)', (_, amount) => {
		expect(parseBudgetForm(form({ amount, currency: 'IDR' }), 'id')).toEqual({
			ok: false,
			error: BUDGET_AMOUNT_INVALID
		});
	});

	it('refuses a currency off the wallet list', () => {
		expect(parseBudgetForm(form({ amount: '100', currency: 'XAU' }), 'id')).toEqual({
			ok: false,
			error: BUDGET_CURRENCY_INVALID
		});
		expect(parseBudgetForm(form({ amount: '100' }), 'id')).toEqual({
			ok: false,
			error: BUDGET_CURRENCY_INVALID
		});
	});

	it('FN-47: cents in a currency that has them (the shared amount rule), refused past 2 digits', () => {
		expect(parseBudgetForm(form({ amount: '1.234,56', currency: 'CNY' }), 'id')).toEqual({
			ok: true,
			value: { amountMinor: 123_456, currency: 'CNY' }
		});
		expect(parseBudgetForm(form({ amount: '1,234.56', currency: 'HKD' }), 'en')).toEqual({
			ok: true,
			value: { amountMinor: 123_456, currency: 'HKD' }
		});
		for (const [amount, locale] of [
			['1.234,567', 'id'],
			['12.345', 'en']
		] as const)
			expect(parseBudgetForm(form({ amount, currency: 'TWD' }), locale)).toEqual({
				ok: false,
				error: BUDGET_AMOUNT_INVALID_CENTS
			});
		expect(parseBudgetForm(form({ amount: '50.000,50', currency: 'IDR' }), 'id')).toEqual({
			ok: false,
			error: BUDGET_AMOUNT_INVALID
		});
	});
});

describe('expectedUpdatedAt', () => {
	it('null for a create, the number for an edit, -1 when malformed', () => {
		expect(expectedUpdatedAt(form({}))).toBeNull();
		expect(expectedUpdatedAt(form({ updatedAt: '' }))).toBeNull();
		expect(expectedUpdatedAt(form({ updatedAt: '1791398368247' }))).toBe(1_791_398_368_247);
		expect(expectedUpdatedAt(form({ updatedAt: '1e3' }))).toBe(-1);
		expect(expectedUpdatedAt(form({ updatedAt: '9'.repeat(20) }))).toBe(-1);
	});
});
