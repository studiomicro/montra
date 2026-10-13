import { describe, expect, it } from 'vitest';
import { collectiblesTotalsOf, type Collectible } from './repo';

const item = (over: Partial<Collectible>): Collectible => {
	const base = {
		id: crypto.randomUUID(),
		name: 'Kartu',
		purchasePriceMinor: 100_000,
		currency: 'IDR',
		purchasedOn: '2026-10-08',
		valueMinor: 100_000,
		hasPhoto: false,
		note: null,
		isDemo: false,
		createdAt: 0,
		updatedAt: 0,
		...over
	};
	return { ...base, gainMinor: base.valueMinor - base.purchasePriceMinor };
};

describe('collectiblesTotalsOf', () => {
	it('is empty for no items and for demo items only', () => {
		expect(collectiblesTotalsOf([])).toEqual([]);
		expect(collectiblesTotalsOf([item({ isDemo: true, valueMinor: 9_000 })])).toEqual([]);
	});

	it('sums values and gains exactly, leaving Data demo rows out', () => {
		expect(
			collectiblesTotalsOf([
				item({ valueMinor: 250_000 }),
				item({ valueMinor: 40_000 }),
				item({ isDemo: true, valueMinor: 7_000_000 })
			])
		).toEqual([{ currency: 'IDR', valueMinor: 290_000, gainMinor: 90_000 }]);
		expect(collectiblesTotalsOf([item({ valueMinor: 0 })])).toEqual([
			{ currency: 'IDR', valueMinor: 0, gainMinor: -100_000 }
		]);
	});

	it('names a sum past the safe integer range too large (null), never rounds it', () => {
		const huge = item({ valueMinor: 999_999_999_999_900, purchasePriceMinor: 0 });
		expect(collectiblesTotalsOf(Array.from({ length: 10 }, () => ({ ...huge })))).toEqual([
			{ currency: 'IDR', valueMinor: null, gainMinor: null }
		]);
		const loss = item({ valueMinor: 0, purchasePriceMinor: 999_999_999_999_900 });
		expect(collectiblesTotalsOf(Array.from({ length: 10 }, () => ({ ...loss })))).toEqual([
			{ currency: 'IDR', valueMinor: 0, gainMinor: null }
		]);
	});

	it('300 items at the maximum: exact BigInt sum, reported too large rather than rounded', () => {
		const max = item({ valueMinor: 999_999_999_999_900, purchasePriceMinor: 999_999_999_999_900 });
		const [total] = collectiblesTotalsOf(Array.from({ length: 300 }, () => ({ ...max })));
		expect(total).toEqual({ currency: 'IDR', valueMinor: null, gainMinor: 0 });
	});
});
