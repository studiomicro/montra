import { describe, expect, it } from 'vitest';
import { groupTransferPairs, type TransferPair } from './match';

const side = (id: string, walletId: string, occurredOn = '2026-07-10') => ({
	id,
	title: id.toUpperCase(),
	occurredOn,
	walletId,
	updatedAt: 1
});
const pair = (debit: string, credit: string, amountMinor = 500_000_000): TransferPair => ({
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
