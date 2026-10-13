import { describe, expect, it } from 'vitest';
import { balanceTotals, walletBalanceMinor } from './balance';

describe('balanceTotals (Dompet "Total saldo")', () => {
	it('sums per currency, never across currencies, with the hero currency first', () => {
		expect(
			balanceTotals(
				[
					{ currency: 'USD', balanceMinor: 1_000 },
					{ currency: 'IDR', balanceMinor: 1_500_000 },
					{ currency: 'IDR', balanceMinor: -500_000 },
					{ currency: 'EUR', balanceMinor: 200 }
				],
				'IDR'
			)
		).toEqual([
			{ currency: 'IDR', totalMinor: 1_000_000 },
			{ currency: 'EUR', totalMinor: 200 },
			{ currency: 'USD', totalMinor: 1_000 }
		]);
	});

	it('leads with another hero currency when the favourite wallet holds it', () => {
		const totals = balanceTotals(
			[
				{ currency: 'IDR', balanceMinor: 1 },
				{ currency: 'USD', balanceMinor: 2 }
			],
			'USD'
		);
		expect(totals.map((t) => t.currency)).toEqual(['USD', 'IDR']);
	});

	it('is null (too large to show) when a balance is too large or the exact sum passes 2^53', () => {
		expect(
			balanceTotals(
				[
					{ currency: 'IDR', balanceMinor: null },
					{ currency: 'IDR', balanceMinor: 5 },
					{ currency: 'USD', balanceMinor: 5 }
				],
				'IDR'
			)
		).toEqual([
			{ currency: 'IDR', totalMinor: null },
			{ currency: 'USD', totalMinor: 5 }
		]);
		expect(
			balanceTotals(
				[
					{ currency: 'IDR', balanceMinor: Number.MAX_SAFE_INTEGER },
					{ currency: 'IDR', balanceMinor: 1 }
				],
				'IDR'
			)
		).toEqual([{ currency: 'IDR', totalMinor: null }]);
	});

	it('is empty without wallets', () => {
		expect(balanceTotals([], 'IDR')).toEqual([]);
	});

	it('walletBalanceMinor is unchanged: opening balance plus the transaction sum', () => {
		expect(walletBalanceMinor({ openingBalanceMinor: 100 }, -30)).toBe(70);
	});
});
