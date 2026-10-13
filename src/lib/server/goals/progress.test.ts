import { describe, expect, it } from 'vitest';
import { goalsSetAside } from './progress';

describe('goalsSetAside (Dompet)', () => {
	it('sums the live goals per currency and leaves archived and empty goals out', () => {
		expect(
			goalsSetAside([
				{ savedMinor: 450_000_000, currency: 'IDR', archived: false },
				{ savedMinor: 120_000_000, currency: 'IDR', archived: false },
				{ savedMinor: 999, currency: 'IDR', archived: true },
				{ savedMinor: 0, currency: 'IDR', archived: false }
			])
		).toEqual([{ currency: 'IDR', savedMinor: 570_000_000 }]);
	});

	it('is empty without savings, and null past the safe range', () => {
		expect(goalsSetAside([])).toEqual([]);
		expect(
			goalsSetAside([
				{ savedMinor: Number.MAX_SAFE_INTEGER, currency: 'IDR', archived: false },
				{ savedMinor: 1, currency: 'IDR', archived: false }
			])
		).toEqual([{ currency: 'IDR', savedMinor: null }]);
	});
});
