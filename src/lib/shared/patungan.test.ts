import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT_MINOR } from './money-parse';
import {
	equalShares,
	exactShares,
	isLocked,
	MAX_PARTICIPANTS,
	sharesDifference,
	typedUnitMinor
} from './patungan';

const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + BigInt(x), 0n);

describe('equalShares', () => {
	it('AC-1: Rp 100.000 among 3 is 33.333, 33.333 and 33.334 for the payer (IDR is typed in whole rupiah)', () => {
		expect(equalShares(10_000_000, 3, 0, typedUnitMinor('IDR'))).toEqual({
			ok: true,
			shares: [3_333_400, 3_333_300, 3_333_300]
		});
	});

	it('AC-2: 100 cents among 3 is 33/33/34, the 34 to the payer', () => {
		expect(equalShares(100, 3, 0, typedUnitMinor('USD'))).toEqual({
			ok: true,
			shares: [34, 33, 33]
		});
		expect(equalShares(100, 3, 2, 1)).toEqual({ ok: true, shares: [33, 33, 34] });
	});

	it('keeps the sen of a bill that has them on the payer (an imported Rp 33.333,50)', () => {
		expect(equalShares(3_333_350, 2, 0, 100)).toEqual({ ok: true, shares: [1_666_750, 1_666_600] });
	});

	it('always adds up exactly, everyone but the payer equal, the payer at most one unit per person more', () => {
		const totals = [
			1,
			2,
			99,
			100,
			101,
			999,
			1_000,
			99_999,
			10_000_000,
			999_999_900,
			MAX_AMOUNT_MINOR,
			7_777_777_777_777
		];
		for (const unit of [1, 100])
			for (let count = 2; count <= MAX_PARTICIPANTS; count++)
				for (const total of totals) {
					const r = equalShares(total, count, 0, unit);
					if (!r.ok) {
						expect(r.reason).toBe('total_too_small');
						expect(total).toBeLessThan(count * unit);
						continue;
					}
					expect(sum(r.shares)).toBe(BigInt(total));
					expect(r.shares).toHaveLength(count);
					const [payer, ...others] = r.shares as [number, ...number[]];
					expect(new Set(others).size).toBe(1);
					const other = others[0] as number;
					expect(other % unit).toBe(0);
					expect(payer - other).toBeGreaterThanOrEqual(0);
					expect(payer - other).toBeLessThan(count * unit);
				}
	});

	it("refuses too few or too many people and a total smaller than everyone's unit", () => {
		expect(equalShares(1_000, 1, 0)).toEqual({ ok: false, reason: 'count' });
		expect(equalShares(1_000, MAX_PARTICIPANTS + 1, 0)).toEqual({ ok: false, reason: 'count' });
		expect(equalShares(2, 3, 0)).toEqual({ ok: false, reason: 'total_too_small' });
		expect(equalShares(299, 3, 0, 100)).toEqual({ ok: false, reason: 'total_too_small' });
		expect(equalShares(300, 3, 0, 100)).toEqual({ ok: true, shares: [100, 100, 100] });
	});

	it('throws on a programming error (never user input)', () => {
		expect(() => equalShares(100, 3, 3)).toThrow(RangeError);
		expect(() => equalShares(0, 3, 0)).toThrow(RangeError);
		expect(() => equalShares(MAX_AMOUNT_MINOR + 1, 3, 0)).toThrow(RangeError);
		expect(() => equalShares(100, 3, 0, 0)).toThrow(RangeError);
	});
});

describe('exactShares', () => {
	it('accepts amounts that add up exactly, in order', () => {
		expect(exactShares(10_000_000, [7_000_000, 3_000_000])).toEqual({
			ok: true,
			shares: [7_000_000, 3_000_000]
		});
	});

	it('refuses a sum that is off by even one minor unit, either way (AC-3)', () => {
		expect(exactShares(10_000_000, [7_000_000, 2_999_999])).toEqual({
			ok: false,
			reason: 'sum_mismatch'
		});
		expect(exactShares(10_000_000, [7_000_000, 3_000_001])).toEqual({
			ok: false,
			reason: 'sum_mismatch'
		});
	});

	it('refuses a missing, zero, fractional or too large share', () => {
		for (const bad of [null, 0, -1, 1.5, MAX_AMOUNT_MINOR + 1])
			expect(exactShares(100, [100, bad as number | null])).toEqual({
				ok: false,
				reason: 'share_invalid'
			});
	});

	it('sums exactly past 2^53 (BigInt), never rounding', () => {
		const big = MAX_AMOUNT_MINOR;
		expect(exactShares(big, [big - 1, 1])).toEqual({ ok: true, shares: [big - 1, 1] });
		expect(exactShares(big, [big, big])).toEqual({ ok: false, reason: 'sum_mismatch' });
	});

	it('refuses fewer than 2 or more than MAX_PARTICIPANTS people', () => {
		expect(exactShares(100, [100])).toEqual({ ok: false, reason: 'count' });
		expect(
			exactShares(
				21,
				Array.from({ length: 21 }, () => 1)
			)
		).toEqual({ ok: false, reason: 'count' });
	});
});

describe('sharesDifference and the lock', () => {
	it('says how far the typed shares are from the total (blank counts as 0)', () => {
		expect(sharesDifference(100, [60, null])).toBe(-40n);
		expect(sharesDifference(100, [60, 50])).toBe(10n);
		expect(sharesDifference(100, [60, 40])).toBe(0n);
	});

	it('locks once anyone but the payer has paid something', () => {
		expect(
			isLocked([
				{ isPayer: true, paidAmountMinor: 500 },
				{ isPayer: false, paidAmountMinor: 0 }
			])
		).toBe(false);
		expect(
			isLocked([
				{ isPayer: true, paidAmountMinor: 500 },
				{ isPayer: false, paidAmountMinor: 1 }
			])
		).toBe(true);
	});

	it('typedUnitMinor: IDR is typed in whole rupiah (stored in sen), cents elsewhere, JPY has none', () => {
		expect(typedUnitMinor('IDR')).toBe(100);
		expect(typedUnitMinor('USD')).toBe(1);
		expect(typedUnitMinor('JPY')).toBe(1);
	});
});
