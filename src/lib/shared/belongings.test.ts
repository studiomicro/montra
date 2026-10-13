import { describe, expect, it } from 'vitest';
import { belongingValue, DEPRECIATION_DAYS, estimatedValueMinor } from './belongings';

const TEN_MILLION = 1_000_000_000; // Rp 10.000.000 in minor units (sen)

describe('estimatedValueMinor (FN-27 straight-line to 20 % over 5 years)', () => {
	it.each([
		// [purchased on, today, expected minor]
		['2026-10-08', '2026-10-08', TEN_MILLION], // 0 years
		['2025-10-08', '2026-10-08', 840_087_700], // 1 year (365 days): 10.000.000 − ⌊800.000.000·365/182.600⌋ units
		['2021-10-08', '2026-10-08', 200_000_000], // 5 years (1826 days incl. 29 Feb 2024): the 20 % floor
		['2006-10-08', '2026-10-08', 200_000_000], // 20 years: flat at the floor
		['1926-10-08', '2026-10-08', 200_000_000], // 100 years: still the floor, never negative
		['2027-01-01', '2026-10-08', TEN_MILLION] // future purchase date (typing mistake): age 0
	])('bought %s, today %s → %i', (bought, today, expected) => {
		const value = estimatedValueMinor(TEN_MILLION, bought, today);
		expect(value).toBe(expected);
		expect(Number.isSafeInteger(value)).toBe(true);
		expect(value).toBeGreaterThanOrEqual(0);
	});

	it('is exactly the floor at DEPRECIATION_DAYS and one day before is above it', () => {
		expect(estimatedValueMinor(TEN_MILLION, '2021-10-09', '2026-10-08')).toBeGreaterThan(
			200_000_000
		);
		expect(DEPRECIATION_DAYS).toBe(1826);
	});

	it('rounds the loss down so an odd price never falls below 20 %', () => {
		// Rp 999: 20 % is 199,8; the estimate stays at Rp 200.
		expect(estimatedValueMinor(99_900, '2000-01-01', '2026-10-08')).toBe(20_000);
		expect(estimatedValueMinor(0, '2000-01-01', '2026-10-08')).toBe(0);
	});

	it('handles the largest form amount (13 digits) exactly, without float drift', () => {
		const max = 9_999_999_999_999 * 100;
		expect(estimatedValueMinor(max, '2000-01-01', '2026-10-08')).toBe(200_000_000_000_000);
		// Half-way: 913 days → loss ⌊9.999.999.999.999·80·913/182.600⌋ units, computed in BigInt.
		const lost = (9_999_999_999_999n * 80n * 913n) / 182_600n;
		expect(estimatedValueMinor(max, '2024-04-08', '2026-10-08')).toBe(
			Number(9_999_999_999_999n * 100n - lost * 100n)
		);
	});

	it('refuses a negative or unsafe price and a non-date', () => {
		expect(() => estimatedValueMinor(-1, '2026-01-01', '2026-10-08')).toThrow(RangeError);
		expect(() => estimatedValueMinor(1.5, '2026-01-01', '2026-10-08')).toThrow(RangeError);
		expect(() => estimatedValueMinor(100, '2026-02-30', '2026-10-08')).toThrow(RangeError);
		expect(() => estimatedValueMinor(100, 'kemarin', '2026-10-08')).toThrow(RangeError);
	});
});

describe('belongingValue', () => {
	it('uses the stored figure when set, unlabelled', () => {
		expect(
			belongingValue(
				{ purchasePriceMinor: TEN_MILLION, purchasedOn: '2020-01-01', currentValueMinor: 123_400 },
				'2026-10-08'
			)
		).toEqual({ valueMinor: 123_400, estimated: false });
	});

	it('falls back to the estimate for today, labelled', () => {
		expect(
			belongingValue(
				{ purchasePriceMinor: TEN_MILLION, purchasedOn: '2026-10-08', currentValueMinor: null },
				'2026-10-08'
			)
		).toEqual({ valueMinor: TEN_MILLION, estimated: true });
	});

	it('a stored zero is the user’s figure, not "use the estimate"', () => {
		expect(
			belongingValue(
				{ purchasePriceMinor: TEN_MILLION, purchasedOn: '2026-10-08', currentValueMinor: 0 },
				'2026-10-08'
			)
		).toEqual({ valueMinor: 0, estimated: false });
	});
});
