import { describe, expect, it } from 'vitest';
import {
	chooseAutoMatches,
	groupTransferPairs,
	type AutoMatchCandidate,
	type TransferPair
} from './match';

const side = (id: string, walletId: string, occurredOn = '2026-07-10') => ({
	id,
	title: id.toUpperCase(),
	occurredOn,
	walletId,
	updatedAt: 1
});
const pair = (debit: string, credit: string, amountMinor = 500_000_000): TransferPair => ({
	kind: 'own',
	debit: side(debit, 'A'),
	credit: side(credit, 'B'),
	amountMinor,
	currency: 'IDR'
});

describe('groupTransferPairs (AC-5: ambiguous candidates listed whole, never auto-picked)', () => {
	it('a pair that shares no row with another is its own, unambiguous group', () => {
		const groups = groupTransferPairs([pair('d1', 'c1'), pair('d2', 'c2', 250_000_00)]);
		expect(groups.map((g) => [g.key, g.ambiguous, g.pairs.length, g.amountMinor])).toEqual([
			['d1:c1', false, 1, 500_000_000],
			['d2:c2', false, 1, 250_000_00]
		]);
	});

	it('one debit with two candidate credits is one ambiguous group holding both pairs', () => {
		const groups = groupTransferPairs([pair('d1', 'c1'), pair('d1', 'c2')]);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ key: 'd1:c1', ambiguous: true });
		expect(groups[0]!.pairs.map((p) => p.credit.id)).toEqual(['c1', 'c2']);
	});

	it('a chain (two debits, two credits, same amount and window) is one group of every combination', () => {
		const groups = groupTransferPairs([
			pair('d1', 'c1'),
			pair('d1', 'c2'),
			pair('d2', 'c1'),
			pair('d2', 'c2')
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.pairs).toHaveLength(4);
	});

	it('keeps the listing order (newest first) for groups and for pairs inside a group', () => {
		const groups = groupTransferPairs([pair('d9', 'c9'), pair('d1', 'c2'), pair('d1', 'c1')]);
		expect(groups.map((g) => g.key)).toEqual(['d9:c9', 'd1:c2']);
		expect(groups[1]!.pairs.map((p) => p.credit.id)).toEqual(['c2', 'c1']);
	});

	it('no pairs: no groups', () => {
		expect(groupTransferPairs([])).toEqual([]);
	});
});

/** An auto-match candidate: debit `d` on `dOn`, credit `c` on `cOn`; own, touched, never auto-merged by default. */
const auto = (
	d: string,
	c: string,
	over: Partial<AutoMatchCandidate> & { dOn?: string; cOn?: string } = {}
): AutoMatchCandidate => {
	const { dOn = '2026-07-10', cOn = '2026-07-11', ...rest } = over;
	return {
		kind: 'own',
		debit: { id: d, occurredOn: dOn, updatedAt: 1 },
		credit: { id: c, occurredOn: cOn, updatedAt: 2 },
		amountMinor: 500_000_000,
		currency: 'IDR',
		touched: true,
		autoBefore: false,
		...rest
	};
};
const ids = (ps: AutoMatchCandidate[]) => ps.map((p) => `${p.debit.id}:${p.credit.id}`);

describe('chooseAutoMatches (FN-48d: only pairs with one possible reading merge by themselves)', () => {
	it('an unambiguous, touched own pair is chosen', () => {
		expect(ids(chooseAutoMatches([auto('d1', 'c1')], 1000, 20))).toEqual(['d1:c1']);
	});

	it('a group of more than one pair is never chosen, not even one of its pairs', () => {
		expect(chooseAutoMatches([auto('d1', 'c1'), auto('d1', 'c2')], 1000, 20)).toEqual([]);
		expect(chooseAutoMatches([auto('d1', 'c1'), auto('d2', 'c1')], 1000, 20)).toEqual([]);
	});

	it('a card payment pair is never chosen, and it makes an own pair sharing its row ambiguous', () => {
		expect(chooseAutoMatches([auto('d1', 'k1', { kind: 'card' })], 1000, 20)).toEqual([]);
		expect(
			chooseAutoMatches([auto('d1', 'c1'), auto('d1', 'k1', { kind: 'card' })], 1000, 20)
		).toEqual([]);
	});

	it('a pair the import did not touch, or one an auto-merge named before, is left for the user', () => {
		expect(chooseAutoMatches([auto('d1', 'c1', { touched: false })], 1000, 20)).toEqual([]);
		expect(chooseAutoMatches([auto('d1', 'c1', { autoBefore: true })], 1000, 20)).toEqual([]);
	});

	it('newest first (later date of the two, then the debit date, then ids), at most `max`', () => {
		const chosen = chooseAutoMatches(
			[
				auto('d1', 'c1', { amountMinor: 1, dOn: '2026-07-01', cOn: '2026-07-02' }),
				auto('d2', 'c2', { amountMinor: 2, dOn: '2026-07-05', cOn: '2026-07-04' }),
				auto('d4', 'c4', { amountMinor: 4, dOn: '2026-07-04', cOn: '2026-07-05' }),
				auto('d3', 'c3', { amountMinor: 3, dOn: '2026-07-03', cOn: '2026-07-03' })
			],
			1000,
			3
		);
		expect(ids(chosen)).toEqual(['d2:c2', 'd4:c4', 'd3:c3']);
	});

	it('past the scan cap, the last amount read is dropped whole (it may be incomplete)', () => {
		// Read in amount order with scanMax + 1 rows: amount 2's second pair (d2:c3) lies past the cap.
		const read = [
			auto('d1', 'c1', { amountMinor: 1 }),
			auto('d2', 'c2', { amountMinor: 2 }),
			auto('d2', 'c3', { amountMinor: 2 })
		];
		expect(ids(chooseAutoMatches(read, 2, 20))).toEqual(['d1:c1']);
		// The same amount in another currency is a different set of rows, kept.
		const other = [
			auto('d1', 'c1', { amountMinor: 2, currency: 'IDR' }),
			auto('d2', 'c2', { amountMinor: 2, currency: 'USD' })
		];
		expect(ids(chooseAutoMatches(other, 1, 20))).toEqual(['d1:c1']);
		// Within the cap nothing is dropped.
		expect(ids(chooseAutoMatches(read.slice(0, 2), 2, 20))).toEqual(['d1:c1', 'd2:c2']);
	});
});
