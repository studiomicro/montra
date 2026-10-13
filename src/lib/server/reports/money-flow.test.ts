import { describe, expect, it } from 'vitest';
import type { MoneyFlowRow } from '../transactions/aggregate';
import { shapeMoneyFlow } from './money-flow';

const cat = (id: string, tileKey: 'gaji' | 'kopi' | 'makan' | 'bonus' = 'kopi') => ({
	id,
	name: id,
	tileKey,
	isPreset: true
});
const row = (over: Partial<MoneyFlowRow>): MoneyFlowRow => ({
	type: 'expense',
	category: cat('kopi'),
	wallet: { id: 'bca', name: 'BCA' },
	currency: 'IDR',
	count: 1,
	amountMinor: 100,
	...over
});

describe('shapeMoneyFlow', () => {
	it('builds income → wallet → expense nodes and links, largest first; totals are exact sums', () => {
		const r = shapeMoneyFlow(
			[
				row({ type: 'income', category: cat('gaji', 'gaji'), amountMinor: 9_000 }),
				row({
					type: 'income',
					category: cat('bonus', 'bonus'),
					wallet: { id: 'gopay', name: 'GoPay' },
					amountMinor: 500
				}),
				row({ amountMinor: 300 }),
				row({ category: cat('makan', 'makan'), amountMinor: 700, count: 3 }),
				row({ wallet: { id: 'gopay', name: 'GoPay' }, amountMinor: 200 })
			],
			'2026-10',
			'IDR'
		);
		expect(r.income.map((n) => [n.key, n.minor])).toEqual([
			['in:gaji', 9_000],
			['in:bonus', 500]
		]);
		expect(r.wallets.map((n) => [n.key, n.inMinor, n.outMinor])).toEqual([
			['w:bca', 9_000, 1_000],
			['w:gopay', 500, 200]
		]);
		expect(r.expense.map((n) => [n.key, n.minor])).toEqual([
			['out:makan', 700],
			['out:kopi', 500]
		]);
		expect(r.links).toEqual([
			{ from: 'in:bonus', to: 'w:gopay', amountMinor: 500 },
			{ from: 'in:gaji', to: 'w:bca', amountMinor: 9_000 },
			{ from: 'w:bca', to: 'out:kopi', amountMinor: 300 },
			{ from: 'w:bca', to: 'out:makan', amountMinor: 700 },
			{ from: 'w:gopay', to: 'out:kopi', amountMinor: 200 }
		]);
		expect(r).toMatchObject({
			inMinor: 9_500,
			outMinor: 1_200,
			otherCurrencies: [],
			otherCount: 0
		});
	});

	it('draws one currency only: other currencies are named and counted, never added in', () => {
		const r = shapeMoneyFlow(
			[
				row({ amountMinor: 100 }),
				row({ currency: 'USD', wallet: { id: 'wise', name: 'Wise' }, amountMinor: 999, count: 2 }),
				row({
					type: 'income',
					currency: 'SGD',
					wallet: { id: 'wise', name: 'Wise' },
					amountMinor: 5
				})
			],
			'2026-10',
			'IDR'
		);
		expect(r.wallets.map((w) => w.walletId)).toEqual(['bca']);
		expect(r.outMinor).toBe(100);
		expect(r.inMinor).toBe(0);
		expect(r.otherCurrencies).toEqual(['SGD', 'USD']);
		expect(r.otherCount).toBe(3);
	});

	it('nothing in the month: no node, no link (never a zero-width link)', () => {
		const r = shapeMoneyFlow([], '2026-10', 'IDR');
		expect(r).toMatchObject({
			income: [],
			wallets: [],
			expense: [],
			links: [],
			inMinor: 0,
			outMinor: 0
		});
	});

	it('rows without a category are one node with categoryId ""', () => {
		const r = shapeMoneyFlow([row({ category: null, amountMinor: 40 })], '2026-10', 'IDR');
		expect(r.expense).toEqual([
			{ key: 'out:', categoryId: '', name: null, isPreset: false, tileKey: 'lain', minor: 40 }
		]);
	});

	it('a too-large sum is null and everything built on it is null, never rounded', () => {
		const max = Number.MAX_SAFE_INTEGER;
		const r = shapeMoneyFlow(
			[row({ amountMinor: max }), row({ category: cat('makan', 'makan'), amountMinor: 1 })],
			'2026-10',
			'IDR'
		);
		expect(r.wallets[0]).toMatchObject({ inMinor: 0, outMinor: null });
		expect(r.outMinor).toBeNull();
		expect(r.expense.map((n) => n.minor)).toEqual([max, 1]);
		const big = shapeMoneyFlow([row({ amountMinor: null })], '2026-10', 'IDR');
		expect(big.expense[0]!.minor).toBeNull();
		expect(big.links[0]!.amountMinor).toBeNull();
	});
});
