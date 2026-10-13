import { describe, expect, it } from 'vitest';
import { statementRow } from '#lib/shared/statements/rows';
import type { StatementParse } from '#lib/shared/statements/types';
import { planContinuity, statementSpan, type StoredStatement } from './continuity';

const parse = (
	rows: [string | null, string][],
	opening: number | null,
	closing: number | null
): StatementParse => ({
	rows: rows.map(([date, amount], i) =>
		statementRow(i, { date, direction: 'debit', amount, description: 'X' })
	),
	openingBalanceMinor: opening,
	closingBalanceMinor: closing
});

const stored = (
	id: string,
	periodFrom: string,
	periodTo: string,
	opening: number | null,
	closing: number | null,
	createdAt = 1
): StoredStatement => ({
	id,
	walletId: 'w',
	periodFrom,
	periodTo,
	openingBalanceMinor: opening,
	closingBalanceMinor: closing,
	createdAt
});

describe('statementSpan', () => {
	it('spans every readable row, in any order, and keeps the printed balances', () => {
		expect(
			statementSpan(
				parse(
					[
						['2026-07-15', '1,00'],
						['2026-07-01', '1,00'],
						[null, '1,00'],
						['2026-07-31', '1,00']
					],
					100,
					200
				),
				false
			)
		).toEqual({
			periodFrom: '2026-07-01',
			periodTo: '2026-07-31',
			openingBalanceMinor: 100,
			closingBalanceMinor: 200
		});
	});

	it('drops the closing balance when rows were cut, and has no span without a readable row', () => {
		expect(statementSpan(parse([['2026-07-01', '1,00']], 100, 200), true)).toMatchObject({
			openingBalanceMinor: 100,
			closingBalanceMinor: null
		});
		expect(statementSpan(parse([[null, '1,00']], 100, 200), false)).toBeNull();
	});
});

describe('planContinuity', () => {
	const july = stored('jul', '2026-07-01', '2026-07-31', 0, 500);
	const candidate = (from: string, to: string, opening: number | null = 500) => ({
		id: null,
		periodFrom: from,
		periodTo: to,
		openingBalanceMinor: opening,
		closingBalanceMinor: 900
	});

	it('compares the first statement with the wallet, a later one with the nearest earlier by date', () => {
		expect(planContinuity(candidate('2026-07-01', '2026-07-31'), [])).toEqual({ kind: 'wallet' });
		const sept = stored('sep', '2026-09-01', '2026-09-30', 700, 900);
		// August arrives after September was imported: it still follows July, by date.
		expect(planContinuity(candidate('2026-08-01', '2026-08-31'), [sept, july])).toMatchObject({
			kind: 'statement',
			previous: { id: 'jul', closingBalanceMinor: 500 }
		});
		expect(planContinuity(candidate('2026-06-01', '2026-06-30'), [sept, july])).toEqual({
			kind: 'wallet'
		});
	});

	it('never compares overlapping statements, but ignores the same statement imported again', () => {
		expect(planContinuity(candidate('2026-07-15', '2026-08-14'), [july])).toEqual({
			kind: 'overlap'
		});
		// The last day of one is the first day of the other: they overlap.
		expect(planContinuity(candidate('2026-07-31', '2026-08-30'), [july])).toEqual({
			kind: 'overlap'
		});
		const twin = { ...july, id: null };
		expect(planContinuity(twin, [july])).toEqual({ kind: 'wallet' });
	});

	it('makes no claim without an opening balance, a previous closing balance, or the older batches', () => {
		expect(planContinuity(candidate('2026-08-01', '2026-08-31', null), [july])).toEqual({
			kind: 'none'
		});
		const open = stored('jul', '2026-07-01', '2026-07-31', 0, null);
		expect(planContinuity(candidate('2026-08-01', '2026-08-31'), [open])).toEqual({ kind: 'none' });
		expect(planContinuity(candidate('2026-08-01', '2026-08-31'), [], false)).toEqual({
			kind: 'none'
		});
	});

	it('leaves a stored statement out of its own comparison', () => {
		expect(planContinuity({ ...july }, [july])).toEqual({ kind: 'wallet' });
	});

	it('picks the latest-ending earlier statement, ties by start, import time and id', () => {
		const a = stored('a', '2026-06-01', '2026-06-30', 0, 10, 5);
		const b = stored('b', '2026-06-15', '2026-06-30', 0, 20, 1);
		const c = stored('c', '2026-05-01', '2026-05-31', 0, 30, 9);
		expect(planContinuity(candidate('2026-07-01', '2026-07-31'), [c, a, b])).toMatchObject({
			kind: 'statement',
			previous: { id: 'b' }
		});
	});
});
