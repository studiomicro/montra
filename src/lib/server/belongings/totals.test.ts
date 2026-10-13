import { describe, expect, it } from 'vitest';
import { totalsOf, type Belonging } from './repo';

const item = (over: Partial<Belonging>): Belonging => ({
	id: crypto.randomUUID(),
	name: 'Barang',
	purchasePriceMinor: 100_000,
	currency: 'IDR',
	purchasedOn: '2026-10-08',
	currentValueMinor: null,
	hasPhoto: false,
	note: null,
	isDemo: false,
	createdAt: 0,
	updatedAt: 0,
	...over
});

describe('totalsOf', () => {
	it('is empty for no items', () => {
		expect(totalsOf([], '2026-10-08')).toEqual([]);
	});

	it('sums own figures and estimates exactly and says whether any estimate is in it', () => {
		expect(
			totalsOf(
				[item({ currentValueMinor: 5_000 }), item({ purchasePriceMinor: 7_000 })],
				'2026-10-08'
			)
		).toEqual([{ currency: 'IDR', totalMinor: 12_000, estimated: true }]);
		expect(totalsOf([item({ currentValueMinor: 5_000 })], '2026-10-08')).toEqual([
			{ currency: 'IDR', totalMinor: 5_000, estimated: false }
		]);
	});

	it('leaves Data demo rows out of the sum and of the estimate mark', () => {
		expect(
			totalsOf(
				[item({ currentValueMinor: 5_000 }), item({ purchasePriceMinor: 7_000, isDemo: true })],
				'2026-10-08'
			)
		).toEqual([{ currency: 'IDR', totalMinor: 5_000, estimated: false }]);
		expect(totalsOf([item({ currentValueMinor: 5_000, isDemo: true })], '2026-10-08')).toEqual([]);
	});

	it('names a sum past the safe integer range too large (null), never rounds it', () => {
		const huge = item({ currentValueMinor: 999_999_999_999_900 });
		expect(
			totalsOf(
				Array.from({ length: 10 }, () => ({ ...huge })),
				'2026-10-08'
			)
		).toEqual([{ currency: 'IDR', totalMinor: null, estimated: false }]);
	});
});
