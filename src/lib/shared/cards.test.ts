import { describe, expect, it } from 'vitest';
import {
	availableCredit,
	billRemaining,
	cardAmountText,
	clampedMonthDay,
	dueChip,
	nextDueDate,
	owedMinor,
	reconciliationGap
} from './cards';
import { wibDateString } from './dates';

describe('card due dates (FN-55a AC 8)', () => {
	it('clamps a day past the month to its last day, leap years included', () => {
		expect(clampedMonthDay(2026, 2, 31)).toBe('2026-02-28');
		expect(clampedMonthDay(2028, 2, 31)).toBe('2028-02-29');
		expect(clampedMonthDay(2026, 4, 31)).toBe('2026-04-30');
		expect(clampedMonthDay(2026, 1, 12)).toBe('2026-01-12');
	});

	it('next due date: this month when today or later, else next month (December rolls the year)', () => {
		expect(nextDueDate('2026-02-10', 31)).toBe('2026-02-28');
		expect(nextDueDate('2028-02-10', 31)).toBe('2028-02-29');
		expect(nextDueDate('2026-02-28', 28)).toBe('2026-02-28');
		expect(nextDueDate('2026-10-13', 12)).toBe('2026-11-12');
		expect(nextDueDate('2026-12-20', 5)).toBe('2027-01-05');
	});

	it('chip: today, in N days, late N days only while owed', () => {
		expect(dueChip('2026-02-28', null, false, 28)).toEqual({ kind: 'today', date: '2026-02-28' });
		expect(dueChip('2026-02-10', null, false, 31)).toEqual({
			kind: 'in',
			days: 18,
			date: '2026-02-28'
		});
		expect(dueChip('2026-10-20', '2026-10-12', true, 12)).toEqual({
			kind: 'late',
			days: 8,
			date: '2026-10-12'
		});
		// Paid (nothing outstanding): the next typed due day instead of a late chip.
		expect(dueChip('2026-10-20', '2026-10-12', false, 12)).toEqual({
			kind: 'in',
			days: 23,
			date: '2026-11-12'
		});
		expect(dueChip('2026-10-20', '2026-10-12', false, null)).toBeNull();
		expect(dueChip('2026-10-20', null, false, null)).toBeNull();
		// A printed due date wins over the typed day.
		expect(dueChip('2026-10-01', '2026-10-05', true, 25)).toEqual({
			kind: 'in',
			days: 4,
			date: '2026-10-05'
		});
	});

	it('today comes from the WIB date of now: 23:30 WIB on the 27th and 00:30 WIB on the 28th differ by one day', () => {
		const late27 = wibDateString(Date.parse('2026-02-27T16:30:00Z'));
		const early28 = wibDateString(Date.parse('2026-02-27T17:30:00Z'));
		expect(late27).toBe('2026-02-27');
		expect(early28).toBe('2026-02-28');
		expect(dueChip(late27, null, false, 28)).toEqual({
			kind: 'in',
			days: 1,
			date: '2026-02-28'
		});
		expect(dueChip(early28, null, false, 28)).toEqual({ kind: 'today', date: '2026-02-28' });
	});
});

describe('available credit and the bill (FN-55a AC 5, 6, 7)', () => {
	it('limit minus owed to the sen; over the limit is named, never negative; no limit, no line', () => {
		expect(availableCredit(1500000000, -125000050)).toEqual({
			kind: 'available',
			minor: 1374999950n
		});
		expect(availableCredit(100, -100)).toEqual({ kind: 'available', minor: 0n });
		expect(availableCredit(100, -101)).toEqual({ kind: 'over' });
		expect(availableCredit(null, -5)).toBeNull();
		// A credit balance owes nothing: the whole limit is available.
		expect(availableCredit(1000, 250)).toEqual({ kind: 'available', minor: 1000n });
		expect(owedMinor(250)).toBe(0n);
		expect(owedMinor(-125000050)).toBe(125000050n);
	});

	it('remaining = printed new balance − paid, never below zero', () => {
		expect(billRemaining(-125000050, 100000000n)).toBe(25000050n);
		expect(billRemaining(-125000050, 125000050n)).toBe(0n);
		expect(billRemaining(-125000050, 200000000n)).toBe(0n);
		// A printed credit balance owes nothing.
		expect(billRemaining(5000, 0n)).toBe(0n);
	});

	it('reconciliation: balance against new balance + paid − unbilled, exact', () => {
		// N = 1.250.000,50 owed, paid 1.000.000, then 25.000 spent: the wallet should be at −275.000,50.
		expect(reconciliationGap(-27500050, -125000050, 100000000n, 2500000n)).toBe(0n);
		expect(reconciliationGap(-27500051, -125000050, 100000000n, 2500000n)).toBe(-1n);
	});

	it('works past the safe integer range without rounding', () => {
		const big = BigInt(Number.MAX_SAFE_INTEGER) * 3n;
		expect(billRemaining(-Number.MAX_SAFE_INTEGER, -big)).toBe(
			BigInt(Number.MAX_SAFE_INTEGER) + big
		);
	});
});

describe('card amount text', () => {
	it('shows sen only when not zero, in the UI language', () => {
		expect(cardAmountText(125000050, 'IDR', 'id')).toBe('1.250.000,50');
		expect(cardAmountText(125000000, 'IDR', 'id')).toBe('1.250.000');
		expect(cardAmountText(125000050, 'IDR', 'en')).toBe('1,250,000.50');
		expect(cardAmountText(1250, 'USD', 'en')).toBe('12.50');
		expect(cardAmountText(1250, 'JPY', 'id')).toBe('1.250');
		expect(cardAmountText(5, 'IDR', 'id')).toBe('0,05');
		expect(cardAmountText(0, 'IDR', 'id')).toBe('');
		expect(cardAmountText(null, 'IDR', 'id')).toBe('');
	});
});
