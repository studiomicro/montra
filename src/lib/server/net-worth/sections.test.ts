import { describe, expect, it } from 'vitest';
import type { NetWorthKind } from '#lib/shared/net-worth';
import { sectionTotals } from './sections';
import type { ValuedNetWorthItem, WalletLine } from './summary';

const wallet = (currency: string, balanceMinor: number | null, n = 0): WalletLine => ({
	id: `w${n}`,
	name: `Dompet ${n}`,
	type: 'bank',
	lastFour: null,
	currency,
	balanceMinor
});

let ids = 0;
const item = (
	kind: NetWorthKind,
	currency: string,
	valueMinor: number | null,
	over: Partial<ValuedNetWorthItem> = {}
): ValuedNetWorthItem => ({
	id: `i${++ids}`,
	kind,
	name: 'Aset',
	currency,
	priceSource: 'manual',
	priceSymbol: null,
	quantityScaled: null,
	quantityScale: null,
	manualValueMinor: valueMinor,
	acquiredOn: null,
	note: null,
	isDemo: false,
	createdAt: 0,
	updatedAt: 0,
	valueMinor,
	basis: valueMinor === null ? null : 'manual',
	priceAt: null,
	stale: false,
	unlisted: false,
	...over
});

describe('sectionTotals (FN-25b)', () => {
	it('sums each section per currency, never across currencies, IDR first', () => {
		const t = sectionTotals(
			[wallet('USD', 12_50, 1), wallet('IDR', 16_356_000_00, 2), wallet('IDR', 3_643_000_00, 3)],
			[
				item('investment_stock', 'IDR', 4_937_500_00),
				item('investment_gold', 'IDR', 1_000_000_00),
				item('investment_stock', 'USD', 99_99),
				item('investment_crypto', 'IDR', 5_195_398_00),
				item('property', 'IDR', 18_500_000_00),
				item('debt', 'IDR', 250_000_000_00)
			]
		);
		expect(t.wallets).toEqual([
			{ currency: 'IDR', totalMinor: 19_999_000_00 },
			{ currency: 'USD', totalMinor: 12_50 }
		]);
		expect(t.investment).toEqual([
			{ currency: 'IDR', totalMinor: 5_937_500_00 },
			{ currency: 'USD', totalMinor: 99_99 }
		]);
		expect(t.crypto).toEqual([{ currency: 'IDR', totalMinor: 5_195_398_00 }]);
	});

	it('leaves out Data demo items and items without a price or manual value', () => {
		const t = sectionTotals(
			[],
			[
				item('investment_crypto', 'IDR', 7_000_00),
				item('investment_crypto', 'IDR', 1_000_000_00, { isDemo: true }),
				item('investment_crypto', 'IDR', null)
			]
		);
		expect(t.crypto).toEqual([{ currency: 'IDR', totalMinor: 7_000_00 }]);
		expect(t.investment).toEqual([]);
		expect(t.wallets).toEqual([]);
	});

	it('a value too large to show makes its currency subtotal too large, never a rounded figure', () => {
		const t = sectionTotals(
			[wallet('IDR', null, 1), wallet('IDR', 5_00, 2)],
			[
				item('investment_stock', 'IDR', null, { basis: 'manual' }),
				item('investment_stock', 'USD', 1_00)
			]
		);
		expect(t.wallets).toEqual([{ currency: 'IDR', totalMinor: null }]);
		expect(t.investment).toEqual([
			{ currency: 'IDR', totalMinor: null },
			{ currency: 'USD', totalMinor: 1_00 }
		]);
	});
});
