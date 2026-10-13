import { describe, expect, it } from 'vitest';
import {
	convertToIdrMinor,
	divRound,
	formatQuantity,
	goldGramUnitPrice,
	idrUnitPrice,
	netWorthValueMinor,
	parseDecimal,
	type Decimal,
	type ValuedItem
} from './net-worth.ts';

const dec = (text: string) => parseDecimal(text, 12) as Decimal;

describe('parseDecimal', () => {
	it('reads plain decimal text exactly', () => {
		expect(parseDecimal('1493387000', 12)).toEqual({ n: 1493387000n, exp: 0 });
		expect(parseDecimal('0.073354', 12)).toEqual({ n: 73354n, exp: 6 });
		expect(parseDecimal('4105.299805', 8)).toEqual({ n: 4105299805n, exp: 6 });
	});

	it('refuses signs, exponents, separators, blanks and excess precision', () => {
		for (const bad of [
			'-1',
			'+1',
			'1e5',
			'1E-7',
			'1,5',
			'1 000',
			'',
			'.5',
			'5.',
			'NaN',
			'Infinity'
		])
			expect(parseDecimal(bad, 12), bad).toBeNull();
		expect(parseDecimal('0.123456789', 8)).toBeNull();
		expect(parseDecimal('0.12345678', 8)).toEqual({ n: 12345678n, exp: 8 });
	});
});

describe('divRound', () => {
	it('rounds half away from zero, once', () => {
		expect(divRound(5n, 2n)).toBe(3n);
		expect(divRound(4n, 2n)).toBe(2n);
		expect(divRound(7n, 3n)).toBe(2n);
		expect(divRound(-5n, 2n)).toBe(-3n);
		expect(divRound(-7n, 3n)).toBe(-2n);
		expect(divRound(0n, 9n)).toBe(0n);
	});

	it('refuses a non-positive divisor', () => {
		expect(() => divRound(1n, 0n)).toThrow(RangeError);
	});
});

const manual = (manualValueMinor: number | null): ValuedItem => ({
	kind: 'investment_stock',
	priceSource: 'manual',
	quantityScaled: null,
	quantityScale: null,
	manualValueMinor
});
const crypto = (quantityScaled: string, manualValueMinor: number | null = null): ValuedItem => ({
	kind: 'investment_crypto',
	priceSource: 'indodax',
	quantityScaled,
	quantityScale: 8,
	manualValueMinor
});
const gold = (grams1000: string, manualValueMinor: number | null = null): ValuedItem => ({
	kind: 'investment_gold',
	priceSource: 'gold_api',
	quantityScaled: grams1000,
	quantityScale: 3,
	manualValueMinor
});

describe('netWorthValueMinor', () => {
	it('a manual item is exactly its manual value, whatever price is passed', () => {
		expect(netWorthValueMinor(manual(12_500_000_00), null)).toEqual({
			valueMinor: 12_500_000_00n,
			basis: 'manual'
		});
		expect(netWorthValueMinor(manual(100), idrUnitPrice(dec('999')))).toEqual({
			valueMinor: 100n,
			basis: 'manual'
		});
	});

	it('a priced item is quantity × price, rounded once', () => {
		// 0.015 BTC × Rp 1.493.387.000 = Rp 22.400.805
		expect(netWorthValueMinor(crypto('1500000'), idrUnitPrice(dec('1493387000')))).toEqual({
			valueMinor: 22_400_805_00n,
			basis: 'price'
		});
		// 1 satoshi × Rp 1.493.387.000 = Rp 14,93387 → 1.493 sen
		expect(netWorthValueMinor(crypto('1'), idrUnitPrice(dec('1493387000')))?.valueMinor).toBe(
			1493n
		);
		// 1.000.000.000 PEPE × Rp 0,073354 = Rp 73.354.000 (quantity past 2^53 when scaled)
		expect(
			netWorthValueMinor(crypto('100000000000000000'), idrUnitPrice(dec('0.073354')))?.valueMinor
		).toBe(73_354_000_00n);
	});

	it('a priced item without a price falls back to its manual value, else has none', () => {
		expect(netWorthValueMinor(crypto('1500000', 20_000_000_00), null)).toEqual({
			valueMinor: 20_000_000_00n,
			basis: 'fallback'
		});
		expect(netWorthValueMinor(crypto('1500000'), null)).toBeNull();
		expect(netWorthValueMinor(manual(null), null)).toBeNull();
	});
});

describe('gold: (USD/oz ÷ 31,1034768) × USD/IDR, rounded once', () => {
	const usdOz = dec('4105.299805');
	const usdIdr = dec('17881');
	const price = goldGramUnitPrice(usdOz, usdIdr);

	/** The exact reference: q/1000 g × usdOz × rate × 100 / 31.1034768, half-up, by hand in BigInt. */
	const reference = (grams1000: bigint) => {
		const num = grams1000 * 4105299805n * 17881n * 100n * 10_000_000n;
		const den = 1000n * 1_000_000n * 311034768n;
		return (2n * num + den) / (2n * den);
	};

	it('matches the exact reference for 1 g, 2,5 g, 100 g and 1 kg', () => {
		expect(netWorthValueMinor(gold('1000'), price)?.valueMinor).toBe(reference(1000n));
		expect(reference(1000n)).toBe(2_360_085_54n); // Rp 2.360.085,54 per gram
		expect(netWorthValueMinor(gold('2500'), price)?.valueMinor).toBe(reference(2500n));
		expect(netWorthValueMinor(gold('100000'), price)?.valueMinor).toBe(reference(100000n));
		expect(netWorthValueMinor(gold('1000000'), price)?.valueMinor).toBe(reference(1000000n));
	});

	it('equals the exact reference across 632 quantities from 1 mg to 5 kg (no float drift)', () => {
		for (let q = 1n; q <= 5_000_000n; q += 7_919n)
			expect(netWorthValueMinor(gold(q.toString()), price)?.valueMinor).toBe(reference(q));
	});
});

describe('convertToIdrMinor', () => {
	it('converts a whole sum at the stored rate, rounding once', () => {
		// USD 1.000,00 at 17.881 = Rp 17.881.000
		expect(convertToIdrMinor(100_000n, 2, dec('17881'))).toBe(1_788_100_000n);
		// USD 0,01 at 17.881,5 = Rp 178,815 → 17.882 sen (half away from zero)
		expect(convertToIdrMinor(1n, 2, dec('17881.5'))).toBe(17882n);
		// JPY (exponent 0): ¥1.000 at 108,25 = Rp 108.250
		expect(convertToIdrMinor(1000n, 0, dec('108.25'))).toBe(10_825_000n);
		// A debt (negative) converts symmetrically.
		expect(convertToIdrMinor(-1n, 2, dec('17881.5'))).toBe(-17882n);
	});
});

describe('formatQuantity', () => {
	it('shows a scaled quantity as Indonesian decimal text', () => {
		expect(formatQuantity('1500000', 8)).toBe('0,015');
		expect(formatQuantity('100000000', 8)).toBe('1');
		expect(formatQuantity('2500', 3)).toBe('2,5');
		expect(formatQuantity('100000000000000000', 8)).toBe('1.000.000.000');
		expect(formatQuantity('1', 8)).toBe('0,00000001');
		// Ungrouped for a form field (parseQuantity refuses thousands dots).
		expect(formatQuantity('100000000000000000', 8, false)).toBe('1000000000');
		expect(formatQuantity('123456789012', 3, false)).toBe('123456789,012');
	});
});
