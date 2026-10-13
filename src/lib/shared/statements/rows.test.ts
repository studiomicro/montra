import { describe, expect, it } from 'vitest';
import { balanceCheck, dateInPeriod, statementRow } from './rows';
import type { MappedRow } from './types';

const row = (amount: string, direction: 'debit' | 'credit' | null = 'debit') =>
	statementRow(0, { date: '2026-01-02', direction, amount, description: 'Contoh fiktif' });
const minor = (r: MappedRow) => (r.ok ? r.value.amountMinor : r.reason);

describe('statementRow', () => {
	it('reads amounts only through the shared money parser (integer minor units)', () => {
		expect(minor(row('Rp 1.250.000'))).toBe(125_000_000);
		expect(minor(row('1.250.000,50'))).toBe(125_000_050);
		expect(minor(row('Rp 28.000,00'))).toBe(2_800_000);
		expect(minor(row('IDR 1,250,000.00'))).toBe(125_000_000);
		expect(minor(row('25.000'))).toBe(2_500_000);
	});

	it('maps debit to expense and credit to income; a DB/CR mark decides when no column does', () => {
		expect(row('25.000', 'debit')).toMatchObject({ ok: true, value: { type: 'expense' } });
		expect(row('25.000', 'credit')).toMatchObject({ ok: true, value: { type: 'income' } });
		expect(row('50.000 DB', null)).toMatchObject({ ok: true, value: { type: 'expense' } });
		expect(row('50.000 CR', null)).toMatchObject({ ok: true, value: { type: 'income' } });
	});

	it('keeps a negative refund positive with the direction from the statement', () => {
		expect(row('-25.000', 'credit')).toMatchObject({
			ok: true,
			value: { type: 'income', amountMinor: 2_500_000 }
		});
	});

	it('rejects with a typed reason: no date, bad date, no amount, zero, unreadable, no direction', () => {
		const base = { direction: 'debit' as const, description: 'x' };
		expect(statementRow(3, { ...base, date: null, amount: '1' })).toEqual({
			index: 3,
			ok: false,
			reason: 'missing_date'
		});
		expect(statementRow(0, { ...base, date: '2026-02-30', amount: '1' })).toMatchObject({
			reason: 'unparseable_date'
		});
		expect(statementRow(0, { ...base, date: '2026-01-01', amount: ' ' })).toMatchObject({
			reason: 'missing_amount'
		});
		expect(minor(row('0,00'))).toBe('unparseable_amount');
		expect(minor(row('dua puluh'))).toBe('unparseable_amount');
		expect(minor(row('25.000', null))).toBe('unparseable_amount');
		// Above the one-transaction cap (10^13 minor units) — never stored, never summed.
		expect(minor(row('100.000.000.000,00'))).toBe(10_000_000_000_000);
		expect(minor(row('100.000.000.000,01'))).toBe('unparseable_amount');
		expect(minor(row('90,071,992,547,409.91'))).toBe('unparseable_amount');
	});

	it('never stores the row as a transfer or a foreign currency', () => {
		expect(row('25.000')).toMatchObject({ ok: true, value: { currency: 'IDR', walletName: '' } });
	});
});

describe('dateInPeriod', () => {
	const rollover = { from: '2025-12-01', to: '2026-01-31' };

	it('takes the year from the printed period across a December–January boundary', () => {
		expect(dateInPeriod(31, 12, rollover)).toBe('2025-12-31');
		expect(dateInPeriod(1, 1, rollover)).toBe('2026-01-01');
		expect(dateInPeriod(2, 1, rollover)).toBe('2026-01-02');
	});

	it('is null outside the period or for an impossible date — never "this year"', () => {
		expect(dateInPeriod(15, 3, rollover)).toBeNull();
		expect(dateInPeriod(29, 2, { from: '2025-02-01', to: '2025-02-28' })).toBeNull();
		expect(dateInPeriod(29, 2, { from: '2024-02-01', to: '2024-02-29' })).toBe('2024-02-29');
		expect(dateInPeriod(1, 1, { from: 'x', to: '2026-01-31' })).toBeNull();
		expect(dateInPeriod(1, 1, { from: '2026-02-01', to: '2026-01-01' })).toBeNull();
	});

	it('keeps WIB month-edge days exact (the last and first day of a month)', () => {
		const month = { from: '2026-09-30', to: '2026-10-01' };
		expect(dateInPeriod(30, 9, month)).toBe('2026-09-30');
		expect(dateInPeriod(1, 10, month)).toBe('2026-10-01');
	});
});

describe('balanceCheck', () => {
	const rows: MappedRow[] = [row('25.000', 'debit'), row('100.000', 'credit')];

	it('passes when opening + Σ signed rows = closing', () => {
		expect(
			balanceCheck({ rows, openingBalanceMinor: 1_000_000, closingBalanceMinor: 8_500_000 })
		).toEqual({ status: 'pass' });
	});

	it('reports the gap in minor units when rows are missing or rejected', () => {
		const withReject: MappedRow[] = [...rows, row('0', 'debit')];
		expect(
			balanceCheck({
				rows: withReject,
				openingBalanceMinor: 1_000_000,
				closingBalanceMinor: 8_000_000
			})
		).toEqual({ status: 'gap', gapMinor: -500_000 });
	});

	it('is omitted, never guessed, when a balance is not printed', () => {
		expect(balanceCheck({ rows, openingBalanceMinor: null, closingBalanceMinor: 1 })).toEqual({
			status: 'omitted'
		});
		expect(balanceCheck({ rows, openingBalanceMinor: 1, closingBalanceMinor: null })).toEqual({
			status: 'omitted'
		});
	});
});
