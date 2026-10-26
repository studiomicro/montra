import { describe, expect, it } from 'vitest';
import type { MoneyFlowRow } from '../transactions/aggregate';
import { foldMoneyFlow, linkList, shapeMoneyFlow, type FlowLink } from './money-flow';

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
			'IDR'
		);
		expect(r.wallets.map((w) => w.walletId)).toEqual(['bca']);
		expect(r.outMinor).toBe(100);
		expect(r.inMinor).toBe(0);
		expect(r.otherCurrencies).toEqual(['SGD', 'USD']);
		expect(r.otherCount).toBe(3);
	});

	it('nothing in the month: no node, no link (never a zero-width link)', () => {
		const r = shapeMoneyFlow([], 'IDR');
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
		const r = shapeMoneyFlow([row({ category: null, amountMinor: 40 })], 'IDR');
		expect(r.expense).toEqual([
			{ key: 'out:', categoryId: '', name: null, isPreset: false, tileKey: 'lain', minor: 40 }
		]);
	});

	it('a too-large sum is null and everything built on it is null, never rounded', () => {
		const max = Number.MAX_SAFE_INTEGER;
		const r = shapeMoneyFlow(
			[row({ amountMinor: max }), row({ category: cat('makan', 'makan'), amountMinor: 1 })],
			'IDR'
		);
		expect(r.wallets[0]).toMatchObject({ inMinor: 0, outMinor: null });
		expect(r.outMinor).toBeNull();
		expect(r.expense.map((n) => n.minor)).toEqual([max, 1]);
		const big = shapeMoneyFlow([row({ amountMinor: null })], 'IDR');
		expect(big.expense[0]!.minor).toBeNull();
		expect(big.links[0]!.amountMinor).toBeNull();
	});
});

/** `n` expense categories c0…c(n-1) out of `wallets` wallets; category i spends 1000 + i (odd sums on purpose). */
function many(n: number, wallets = 1, type: 'income' | 'expense' = 'expense'): MoneyFlowRow[] {
	const rows: MoneyFlowRow[] = [];
	for (let i = 0; i < n; i++)
		for (let w = 0; w < wallets; w++)
			rows.push(
				row({
					type,
					category: { id: `c${i}`, name: `C${i}`, tileKey: 'lain', isPreset: false },
					wallet: { id: `w${w}`, name: `W${w}` },
					amountMinor: 1_000 + i * 7 + w
				})
			);
	return rows;
}
const sum = (xs: (number | null)[]) => xs.reduce((a: number, b) => a + (b ?? 0), 0);

describe('foldMoneyFlow (FN-53 AC 11, 40)', () => {
	it('9 expense categories: the 7 largest stay, the 2 smallest become one exact "Lainnya" node', () => {
		const shaped = shapeMoneyFlow(many(9), 'IDR');
		const r = foldMoneyFlow(shaped);
		expect(r.expense).toHaveLength(8);
		expect(r.expense.slice(0, 7).map((n) => n.categoryId)).toEqual([
			'c8',
			'c7',
			'c6',
			'c5',
			'c4',
			'c3',
			'c2'
		]);
		expect(r.expense[7]).toEqual({
			key: 'out:*',
			categoryId: '*',
			name: null,
			isPreset: false,
			tileKey: 'lain',
			minor: 1_000 + 1_007
		});
		expect(r.outMinor).toBe(shaped.outMinor);
		expect(sum(r.expense.map((n) => n.minor))).toBe(shaped.outMinor);
		expect(sum(r.links.map((l) => l.amountMinor))).toBe(shaped.outMinor);
		expect(r.links.filter((l) => l.to === 'out:*')).toEqual([
			{ from: 'w:w0', to: 'out:*', amountMinor: 2_007 }
		]);
	});

	it('exactly 8 categories: all 8 shown, never a "Lainnya" holding one', () => {
		const r = foldMoneyFlow(shapeMoneyFlow(many(8), 'IDR'));
		expect(r.expense).toHaveLength(8);
		expect(r.expense.some((n) => n.categoryId === '*')).toBe(false);
	});

	it('income folds the same way, on its own side', () => {
		const r = foldMoneyFlow(shapeMoneyFlow([...many(10, 1, 'income'), ...many(3)], 'IDR'));
		expect(r.income).toHaveLength(8);
		expect(r.income[7]).toMatchObject({ key: 'in:*', minor: 1_000 + 1_007 + 1_014 });
		expect(r.expense).toHaveLength(3);
	});

	it('more than 6 wallets: 6 kept, the rest one "Dompet lainnya"; links into it merge with exact sums', () => {
		const shaped = shapeMoneyFlow(many(2, 9), 'IDR');
		const r = foldMoneyFlow(shaped);
		expect(r.wallets).toHaveLength(7);
		const folded = r.wallets.at(-1)!;
		expect(folded).toMatchObject({ key: 'w:*', walletId: '*', name: '', inMinor: 0 });
		const dropped = shaped.wallets.slice(6);
		expect(folded.outMinor).toBe(sum(dropped.map((w) => w.outMinor)));
		// Per node, the links still add up to the node.
		for (const w of r.wallets)
			expect(sum(r.links.filter((l) => l.from === w.key).map((l) => l.amountMinor))).toBe(
				w.outMinor
			);
		expect(new Set(r.links.map((l) => `${l.from}>${l.to}`)).size).toBe(r.links.length);
		expect(r.outMinor).toBe(shaped.outMinor);
	});

	it('100 categories and 30 wallets: at most 8 + 7 + 8 nodes, every total exact', () => {
		const rows = [...many(100, 30), ...many(100, 30, 'income')];
		const shaped = shapeMoneyFlow(rows, 'IDR');
		const r = foldMoneyFlow(shaped);
		expect([r.income.length, r.wallets.length, r.expense.length]).toEqual([8, 7, 8]);
		expect(sum(r.expense.map((n) => n.minor))).toBe(shaped.outMinor);
		expect(sum(r.income.map((n) => n.minor))).toBe(shaped.inMinor);
		expect(sum(r.wallets.map((w) => w.outMinor))).toBe(shaped.outMinor);
		expect(sum(r.wallets.map((w) => w.inMinor))).toBe(shaped.inMinor);
	});

	it('a folded node too large to sum is null, never rounded', () => {
		const max = Number.MAX_SAFE_INTEGER;
		// Each category is exact on its own; the two folded ones together pass the safe range.
		const rows = many(9).map((x, i) => ({ ...x, amountMinor: max - i }));
		const r = foldMoneyFlow(shapeMoneyFlow(rows, 'IDR'));
		expect(r.expense.slice(0, 7).every((n) => n.minor !== null)).toBe(true);
		expect(r.expense.find((n) => n.categoryId === '*')?.minor).toBeNull();
		expect(r.links.find((l) => l.to === 'out:*')?.amountMinor).toBeNull();
		expect(r.outMinor).toBeNull();
	});

	it('nothing to fold: the same object back', () => {
		const shaped = shapeMoneyFlow(many(3), 'IDR');
		expect(foldMoneyFlow(shaped)).toBe(shaped);
	});
});

describe('linkList (FN-53: 12 links per direction plus one exact remainder row)', () => {
	const links = (n: number): FlowLink[] =>
		Array.from({ length: n }, (_, i) => ({ from: `w:${i}`, to: 'out:x', amountMinor: 100 + i }));

	it('keeps the 12 largest; the rest is one row with its count and exact sum', () => {
		const r = linkList(links(15), 12);
		expect(r.links).toHaveLength(12);
		expect(r.links[0]?.amountMinor).toBe(114);
		expect(r.rest).toEqual({ count: 3, minor: 100 + 101 + 102 });
		expect(sum(r.links.map((l) => l.amountMinor)) + r.rest!.minor!).toBe(
			sum(links(15).map((l) => l.amountMinor))
		);
	});

	it('12 or fewer: no remainder row', () => {
		expect(linkList(links(12), 12).rest).toBeNull();
	});
});
