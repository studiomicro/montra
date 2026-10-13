import { describe, expect, it } from 'vitest';
import { collectibleGainMinor, formatPermille, gainPermille } from './collectibles';

describe('collectibleGainMinor', () => {
	it('is the exact integer difference, negative for a loss', () => {
		expect(collectibleGainMinor({ valueMinor: 250_000_000, purchasePriceMinor: 100_000_000 })).toBe(
			150_000_000
		);
		expect(collectibleGainMinor({ valueMinor: 40_000_000, purchasePriceMinor: 100_000_000 })).toBe(
			-60_000_000
		);
		expect(collectibleGainMinor({ valueMinor: 0, purchasePriceMinor: 0 })).toBe(0);
	});

	it('stays exact at the 13-digit form maximum', () => {
		const max = 999_999_999_999_900; // 9.999.999.999.999 rupiah in sen
		expect(collectibleGainMinor({ valueMinor: max, purchasePriceMinor: 100 })).toBe(
			999_999_999_999_800
		);
		expect(collectibleGainMinor({ valueMinor: 0, purchasePriceMinor: max })).toBe(-max);
	});

	it('refuses an unsafe amount', () => {
		expect(() => collectibleGainMinor({ valueMinor: 2 ** 53, purchasePriceMinor: 0 })).toThrow(
			RangeError
		);
		expect(() => collectibleGainMinor({ valueMinor: 1.5, purchasePriceMinor: 0 })).toThrow(
			RangeError
		);
	});
});

describe('gainPermille and formatPermille', () => {
	it('tenths of a percent, rounded toward zero; none for a gift', () => {
		expect(gainPermille(150_000_000, 100_000_000)).toBe(1500);
		expect(gainPermille(12_500, 100_000)).toBe(125);
		expect(gainPermille(-1, 3)).toBe(-333);
		expect(gainPermille(1, 3)).toBe(333);
		expect(gainPermille(-60, 100)).toBe(-600);
		expect(gainPermille(500, 0)).toBeNull();
	});

	it('formats with a sign, decimal comma and grouped thousands', () => {
		expect(formatPermille(125)).toBe('+12,5%');
		expect(formatPermille(-30)).toBe('−3%');
		expect(formatPermille(0)).toBe('0%');
		expect(formatPermille(123_450)).toBe('+12.345%');
	});
});
