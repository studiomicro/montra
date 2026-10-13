import { describe, expect, it } from 'vitest';
import { parseDecimal, type Decimal } from '#lib/shared/net-worth';
import { emptyPriceBook, PRICE_STALE_AFTER_MS, type PriceBook } from './prices';
import type { NetWorthItem } from './repo';
import { summarizeNetWorth } from './summary';

const NOW = Date.UTC(2026, 9, 8, 3, 0);
const dec = (t: string) => parseDecimal(t, 12) as Decimal;

let n = 0;
function item(over: Partial<NetWorthItem>): NetWorthItem {
	n++;
	return {
		id: `i${n}`,
		kind: 'property',
		name: `Item ${n}`,
		currency: 'IDR',
		priceSource: 'manual',
		priceSymbol: null,
		quantityScaled: null,
		quantityScale: null,
		manualValueMinor: null,
		acquiredOn: null,
		note: null,
		isDemo: false,
		createdAt: 0,
		updatedAt: 0,
		...over
	};
}

function book(over: Partial<PriceBook> = {}): PriceBook {
	return { ...emptyPriceBook(), ...over };
}

describe('summarizeNetWorth', () => {
	it('lists a Data demo item with its value but leaves it out of the total, classes, rates and missing count', () => {
		const real = item({ kind: 'property', manualValueMinor: 900_000_00 });
		const demo = [
			item({ kind: 'vehicle', manualValueMinor: 150_000_00, isDemo: true }),
			item({ kind: 'debt', manualValueMinor: 400_000_00, isDemo: true }),
			item({ kind: 'cash', currency: 'USD', manualValueMinor: 1_000_00, isDemo: true }),
			item({ kind: 'investment_crypto', priceSource: 'indodax', priceSymbol: 'btc', isDemo: true })
		];
		const s = summarizeNetWorth([], [real, ...demo], book(), NOW);
		expect(s.totalMinor).toBe(900_000_00);
		expect(s.classes).toEqual([{ cls: 'property', minor: 900_000_00 }]);
		expect(s.unconverted).toEqual([]);
		expect(s.rates).toEqual([]);
		expect(s.missingCount).toBe(0);
		expect(s.items.map((i) => [i.isDemo, i.valueMinor])).toEqual([
			[false, 900_000_00],
			[true, 150_000_00],
			[true, 400_000_00],
			[true, 1_000_00],
			[true, null]
		]);
	});

	it('total = wallets + assets − debts, exact, and the classes add up to it', () => {
		const s = summarizeNetWorth(
			[
				{ currency: 'IDR', balanceMinor: 5_000_000_00 },
				{ currency: 'IDR', balanceMinor: -1_000_000_00 }
			],
			[
				item({ kind: 'property', manualValueMinor: 900_000_000_00 }),
				item({ kind: 'vehicle', manualValueMinor: 150_000_000_00 }),
				item({ kind: 'cash', manualValueMinor: 2_500_000_00 }),
				item({ kind: 'investment_stock', manualValueMinor: 30_000_000_00 }),
				item({ kind: 'debt', manualValueMinor: 400_000_000_00 })
			],
			book(),
			NOW
		);
		expect(s.totalMinor).toBe(
			4_000_000_00 + 900_000_000_00 + 150_000_000_00 + 2_500_000_00 + 30_000_000_00 - 400_000_000_00
		);
		expect(s.classes).toEqual([
			{ cls: 'wallets', minor: 4_000_000_00 },
			{ cls: 'cash', minor: 2_500_000_00 },
			{ cls: 'investment', minor: 30_000_000_00 },
			{ cls: 'property', minor: 1_050_000_000_00 },
			{ cls: 'debt', minor: -400_000_000_00 }
		]);
		expect(s.classes.reduce((a, c) => a + (c.minor ?? 0), 0)).toBe(s.totalMinor);
		expect(s.missingCount).toBe(0);
	});

	it('prices crypto and gold from the book, marking stale prices with their time', () => {
		const old = NOW - PRICE_STALE_AFTER_MS - 1;
		const s = summarizeNetWorth(
			[],
			[
				item({
					kind: 'investment_crypto',
					priceSource: 'indodax',
					priceSymbol: 'btc',
					quantityScaled: '1500000',
					quantityScale: 8
				}),
				item({
					kind: 'investment_gold',
					priceSource: 'gold_api',
					quantityScaled: '1000',
					quantityScale: 3
				})
			],
			book({
				coins: new Map([['btc', { price: dec('1493387000'), at: NOW }]]),
				gold: { usdPerOunce: dec('4105.299805'), at: old },
				fx: new Map([['USD', { rate: dec('17881'), text: '17881', date: '2026-10-07', at: NOW }]])
			}),
			NOW
		);
		expect(s.items.map((i) => [i.valueMinor, i.basis, i.stale])).toEqual([
			[22_400_805_00, 'price', false],
			[2_360_085_54, 'price', true]
		]);
		expect(s.items[1]?.priceAt).toBe(old);
		// The USD rate behind the gold value is listed with its own date.
		expect(s.rates).toEqual([{ currency: 'USD', rate: '17881', date: '2026-10-07' }]);
		expect(s.totalMinor).toBe(22_400_805_00 + 2_360_085_54);
	});

	it('no price: falls back to the manual value, or leaves the item out and counts it', () => {
		const s = summarizeNetWorth(
			[],
			[
				item({
					kind: 'investment_crypto',
					priceSource: 'indodax',
					priceSymbol: 'btc',
					quantityScaled: '1',
					quantityScale: 8,
					manualValueMinor: 7_00
				}),
				item({
					kind: 'investment_gold',
					priceSource: 'gold_api',
					quantityScaled: '1000',
					quantityScale: 3
				})
			],
			// Gold without a USD rate cannot be priced either.
			book({ gold: { usdPerOunce: dec('4105.3'), at: NOW } }),
			NOW
		);
		expect(s.items.map((i) => [i.valueMinor, i.basis])).toEqual([
			[7_00, 'fallback'],
			[null, null]
		]);
		expect(s.totalMinor).toBe(7_00);
		expect(s.missingCount).toBe(1);
	});

	it('converts foreign sums once per class at the stored rate; without a rate they stay apart', () => {
		const s = summarizeNetWorth(
			[
				{ currency: 'USD', balanceMinor: 1_00 },
				{ currency: 'USD', balanceMinor: 1_00 },
				{ currency: 'EUR', balanceMinor: 5_00 }
			],
			[item({ kind: 'cash', currency: 'USD', manualValueMinor: 1_000_00 })],
			book({
				fx: new Map([
					['USD', { rate: dec('17881.5'), text: '17881.5', date: '2026-10-07', at: NOW }]
				])
			}),
			NOW
		);
		// Wallets: USD 2,00 → Rp 35.763 (one rounding for the sum, not 2 × 17.882).
		expect(s.classes).toEqual([
			{ cls: 'wallets', minor: 35_763_00 },
			{ cls: 'cash', minor: 17_881_500_00 }
		]);
		expect(s.totalMinor).toBe(35_763_00 + 17_881_500_00);
		expect(s.unconverted).toEqual([{ currency: 'EUR', minor: 5_00 }]);
		expect(s.rates).toEqual([{ currency: 'USD', rate: '17881.5', date: '2026-10-07' }]);
	});

	it('a wallet balance or a total past the safe range is "too large", never a rounded number', () => {
		expect(
			summarizeNetWorth([{ currency: 'IDR', balanceMinor: null }], [], book(), NOW).totalMinor
		).toBeNull();
		const big = summarizeNetWorth(
			[{ currency: 'IDR', balanceMinor: Number.MAX_SAFE_INTEGER }],
			[item({ kind: 'cash', manualValueMinor: 10_000_000_000_000 })],
			book(),
			NOW
		);
		expect(big.totalMinor).toBeNull();
		expect(big.classes.find((c) => c.cls === 'cash')?.minor).toBe(10_000_000_000_000);
		const huge = summarizeNetWorth(
			[],
			[
				item({
					kind: 'investment_crypto',
					priceSource: 'indodax',
					priceSymbol: 'pepe',
					quantityScaled: '999999999999999999999999',
					quantityScale: 8
				})
			],
			book({ coins: new Map([['pepe', { price: dec('9999999999999'), at: NOW }]]) }),
			NOW
		);
		expect(huge.items[0]?.valueMinor).toBeNull();
		expect(huge.items[0]?.basis).toBe('price');
		expect(huge.totalMinor).toBeNull();
	});

	it('an Indodax item whose code is not in a non-empty cached ticker is flagged unlisted', () => {
		const coin = (priceSymbol: string) =>
			item({
				kind: 'investment_crypto',
				priceSource: 'indodax',
				priceSymbol,
				quantityScaled: '1',
				quantityScale: 8,
				manualValueMinor: 5_00
			});
		const withTicker = book({ coins: new Map([['btc', { price: dec('1000'), at: NOW }]]) });
		const s = summarizeNetWorth([], [coin('btc'), coin('a0001')], withTicker, NOW);
		expect(s.items.map((i) => [i.unlisted, i.basis])).toEqual([
			[false, 'price'],
			[true, 'fallback']
		]);
		// No ticker cached at all: nothing is called unlisted (it may simply not be fetched yet).
		expect(summarizeNetWorth([], [coin('a0001')], book(), NOW).items[0]?.unlisted).toBe(false);
	});
});
