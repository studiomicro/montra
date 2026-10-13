import { describe, expect, it } from 'vitest';
import type { CategoryKind, TileKey } from '../transactions';
import {
	isMerchantReason,
	layerKey,
	MERCHANT_REASON_LABELS,
	MERCHANT_REASONS,
	resolveDeterministic,
	type DeterministicSources,
	type LayerHit
} from './resolve';

const RAW = 'QRIS*KOPI KENANGAN JKT 0812 3456 7890';
const LK = layerKey('expense', 'kopi kenangan');
const categories: Record<string, CategoryKind> = {
	rule: 'expense',
	hist: 'expense',
	cache: 'expense',
	kopi: 'expense',
	gaji: 'income',
	hidden: 'expense',
	lainnya: 'expense',
	fee: 'expense',
	trfOut: 'expense',
	trfIn: 'income',
	bunga: 'income'
};
const tiles: Partial<Record<TileKey, string>> = { kopi: 'kopi', gaji: 'gaji' };
/** FN-48 bank tiles per kind ("Transfer" has an expense and an income category). */
const bankTiles: Partial<Record<string, string>> = {
	'biaya-bank:expense': 'fee',
	'transfer:expense': 'trfOut',
	'transfer:income': 'trfIn',
	'bunga:income': 'bunga',
	'gaji:income': 'gaji'
};

function sources(layers: { rule?: string; history?: string; cache?: string | null }) {
	const one = (id: string | null | undefined) =>
		id === undefined ? new Map<string, LayerHit>() : new Map([[LK, { categoryId: id }]]);
	return {
		rules: one(layers.rule),
		history: one(layers.history),
		cache: one(layers.cache),
		usable: (id: string, kind: CategoryKind) => id !== 'hidden' && categories[id] === kind,
		tileCategory: (tile: TileKey, kind: CategoryKind) =>
			bankTiles[`${tile}:${kind}`] ??
			(categories[tiles[tile] ?? ''] === kind ? tiles[tile] : undefined),
		isFallback: (id: string) => id === 'lainnya'
	} satisfies DeterministicSources;
}
const item = { rawText: RAW, kind: 'expense' as const };

describe('resolveDeterministic order (FN-20 AC-3)', () => {
	it('rule beats history, cache and dictionary', () => {
		const r = resolveDeterministic(
			item,
			sources({ rule: 'rule', history: 'hist', cache: 'cache' })
		);
		expect(r).toEqual({
			merchant: 'Kopi Kenangan',
			key: 'kopi kenangan',
			categoryId: 'rule',
			reason: 'rule'
		});
	});
	it('without a rule: history', () => {
		expect(resolveDeterministic(item, sources({ history: 'hist', cache: 'cache' }))).toMatchObject({
			categoryId: 'hist',
			reason: 'history'
		});
	});
	it('without rule and history: the cache', () => {
		expect(resolveDeterministic(item, sources({ cache: 'cache' }))).toMatchObject({
			categoryId: 'cache',
			reason: 'cache'
		});
	});
	it('without the three: the keyword layer ("kopi")', () => {
		expect(resolveDeterministic(item, sources({}))).toMatchObject({
			categoryId: 'kopi',
			reason: 'keyword'
		});
	});
	it('a cached "none" (null) falls through to the dictionary', () => {
		expect(resolveDeterministic(item, sources({ cache: null }))).toMatchObject({
			reason: 'keyword'
		});
	});
	it('a hidden or other-kind category is skipped (AC-7)', () => {
		expect(resolveDeterministic(item, sources({ rule: 'hidden', history: 'gaji' }))).toMatchObject({
			categoryId: 'kopi',
			reason: 'keyword'
		});
	});
	it('nothing names it: none, merchant still cleaned', () => {
		const r = resolveDeterministic({ rawText: 'TOKO BUKU SENJA', kind: 'expense' }, sources({}));
		expect(r).toEqual({
			merchant: 'Toko Buku Senja',
			key: 'toko buku senja',
			categoryId: null,
			reason: 'none'
		});
	});
	it('a voice hint counts as a keyword when nothing else matched', () => {
		const r = resolveDeterministic(
			{ rawText: 'TOKO BUKU', kind: 'expense', hintTileKey: 'kopi' },
			sources({})
		);
		expect(r).toMatchObject({ categoryId: 'kopi', reason: 'keyword' });
	});
	it('an empty key resolves to none without reading any layer', () => {
		expect(resolveDeterministic({ rawText: '0812 3456', kind: 'expense' }, sources({}))).toEqual({
			merchant: '',
			key: '',
			categoryId: null,
			reason: 'none'
		});
	});
	it('every reason has a label', () => {
		for (const r of MERCHANT_REASONS) expect(MERCHANT_REASON_LABELS[r]).toBeTruthy();
		expect(isMerchantReason('rule')).toBe(true);
		expect(isMerchantReason('<b>')).toBe(false);
	});
});

describe('FN-48 narrative layer in the resolver order', () => {
	const fee = { rawText: 'BIAYA ADM', kind: 'expense' as const };
	const feeKey = layerKey('expense', 'biaya adm');
	const withLayers = (layer: 'rules' | 'history' | 'cache', id: string) => ({
		...sources({}),
		[layer]: new Map([[feeKey, { categoryId: id }]])
	});
	it('names a bank fee "narrative" when no rule, history or cache does (AC-1)', () => {
		expect(resolveDeterministic(fee, sources({}))).toMatchObject({
			categoryId: 'fee',
			reason: 'narrative'
		});
	});
	it("a space's own rule or history still wins (AC-12)", () => {
		expect(resolveDeterministic(fee, withLayers('rules', 'kopi'))).toMatchObject({
			categoryId: 'kopi',
			reason: 'rule'
		});
		expect(resolveDeterministic(fee, withLayers('history', 'kopi'))).toMatchObject({
			categoryId: 'kopi',
			reason: 'history'
		});
	});
	it('a history or cache answer that is only the fallback ("Lainnya") does not stop it', () => {
		for (const layer of ['history', 'cache'] as const)
			expect(resolveDeterministic(fee, withLayers(layer, 'lainnya'))).toMatchObject({
				categoryId: 'fee',
				reason: 'narrative'
			});
	});
	it("a member's rule naming the fallback still wins", () => {
		expect(resolveDeterministic(fee, withLayers('rules', 'lainnya'))).toMatchObject({
			categoryId: 'lainnya',
			reason: 'rule'
		});
	});
	it('both transfer directions land on their own kind (AC-7, AC-8)', () => {
		expect(
			resolveDeterministic(
				{ rawText: 'TRSF E-BANKING DB 10/01 ZQ181 ERWIN PRIA', kind: 'expense' },
				sources({})
			)
		).toMatchObject({ categoryId: 'trfOut', reason: 'narrative' });
		expect(
			resolveDeterministic(
				{ rawText: 'TRSF E-BANKING CR 1407/FTSCY/WS95031', kind: 'income' },
				sources({})
			)
		).toMatchObject({ categoryId: 'trfIn', reason: 'narrative' });
	});
	it('a purpose word beats a bare transfer code ("TRSF … GAJI" is salary)', () => {
		expect(
			resolveDeterministic(
				{ rawText: 'TRSF E-BANKING CR GAJI OKTOBER', kind: 'income' },
				sources({})
			)
		).toMatchObject({ categoryId: 'gaji', reason: 'dictionary' });
	});
	it('a narrative tile the space lacks falls through to none', () => {
		expect(
			resolveDeterministic({ rawText: 'TARIKAN ATM 19/0872', kind: 'expense' }, sources({}))
		).toMatchObject({ categoryId: null, reason: 'none' });
	});
	it('interest on an income row is "Bunga", not "Pemasukan Lain" (AC-2)', () => {
		expect(
			resolveDeterministic({ rawText: 'BUNGA 0,00', kind: 'income' }, sources({}))
		).toMatchObject({ categoryId: 'bunga', reason: 'narrative' });
	});
});
