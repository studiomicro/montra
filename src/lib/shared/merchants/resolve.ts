import { msg } from '../i18n.ts';
import type { CategoryKind, TileKey } from '../transactions.ts';
import { narrativeTile } from './bank-narratives.ts';
import { cleanDescriptor } from './clean.ts';
import { tileFromWords } from './dictionary.ts';

/**
 * FN-20 resolution order (owner decision 1): the space's own rule, then the space's history, then the AI cache,
 * then FN-48's bank-narrative codes, then the dictionary and the keyword groups; the AI step (server only) comes
 * last. This module holds the
 * deterministic part, pure and shared; the server supplies the space's rules, history and cache, and which
 * categories are usable. The reason is an enum: the UI derives its chip from it, never from free text.
 */
export const MERCHANT_REASONS = [
	'rule',
	'history',
	'cache',
	'narrative',
	'dictionary',
	'keyword',
	'ai',
	'none'
] as const;
export type MerchantReason = (typeof MERCHANT_REASONS)[number];

export const MERCHANT_REASON_LABELS: Readonly<Record<MerchantReason, string>> = {
	rule: msg('Dari aturanmu'),
	history: msg('Dari riwayat'),
	cache: msg('Dari ingatan'),
	narrative: msg('Dari kode mutasi bank'),
	dictionary: msg('Dari daftar pedagang'),
	keyword: msg('Dari kata kunci'),
	ai: msg('Saran AI'),
	none: msg('Tanpa kategori')
};

export const isMerchantReason = (v: unknown): v is MerchantReason =>
	typeof v === 'string' && (MERCHANT_REASONS as readonly string[]).includes(v);

/** A category one layer points at (rule, history or cache). */
export interface LayerHit {
	categoryId: string | null;
}

export interface DeterministicSources {
	/** The space's live rules, by `kind:key`. */
	rules: ReadonlyMap<string, LayerHit>;
	/** The space's most used category per `kind:key` from recent saved transactions. */
	history: ReadonlyMap<string, LayerHit>;
	/** Unexpired AI answers, by `kind:key`. */
	cache: ReadonlyMap<string, LayerHit>;
	/** Whether a category id is a visible category of the space of `kind` (a hidden or deleted one is skipped). */
	usable: (categoryId: string, kind: CategoryKind) => boolean;
	/** The space's visible category for a preset tile and kind, or undefined. */
	tileCategory: (tile: TileKey, kind: CategoryKind) => string | undefined;
	/**
	 * FN-48: whether a category is a fallback ("Lainnya", "Pemasukan Lain"; `isFallbackCategory`). A history or
	 * cache answer naming one is no answer (it only remembers that nothing better was known), so the later layers
	 * still get their turn; a rule naming one still wins (a member chose it).
	 */
	isFallback: (categoryId: string) => boolean;
}

export interface ResolveItem {
	rawText: string;
	kind: CategoryKind;
	/** A tile the caller already guessed (voice `categoryHint`): one more keyword input. */
	hintTileKey?: TileKey;
}

export interface Resolution {
	/** Cleaned merchant name ('' when nothing is left of the text). */
	merchant: string;
	/** Normalised key ('' when nothing is left). */
	key: string;
	categoryId: string | null;
	reason: MerchantReason;
}

/** The `kind:key` a rule, history or cache map is keyed by. */
export const layerKey = (kind: CategoryKind, key: string) => `${kind}:${key}`;

/**
 * The deterministic answer for one item: the first layer that names a usable category of the item's kind, in
 * the order rule, history, cache, narrative, dictionary, keyword (a bare transfer code after the dictionary and
 * keyword words). `none` when no layer does (the server may then ask AI). The narrative layer reads the raw text
 * (`narrativeTile`), the others the cleaned key.
 */
export function resolveDeterministic(item: ResolveItem, sources: DeterministicSources): Resolution {
	const { name, key } = cleanDescriptor(item.rawText);
	const kind = item.kind;
	const none: Resolution = { merchant: name, key, categoryId: null, reason: 'none' };
	if (key) {
		const lk = layerKey(kind, key);
		const layers: [MerchantReason, LayerHit | undefined][] = [
			['rule', sources.rules.get(lk)],
			['history', sources.history.get(lk)],
			['cache', sources.cache.get(lk)]
		];
		for (const [reason, hit] of layers) {
			if (!hit?.categoryId || !sources.usable(hit.categoryId, kind)) continue;
			if (reason !== 'rule' && sources.isFallback(hit.categoryId)) continue;
			return { merchant: name, key, categoryId: hit.categoryId, reason };
		}
	}
	// A bank code that names a purpose (fee, tax, interest, cash, card bill) outranks the dictionary; a bare
	// transfer code names only the channel, so a purpose word in the same text ("TRSF … GAJI") goes first.
	const narrative = narrativeTile(item.rawText, kind);
	const narrativeCategory = narrative ? sources.tileCategory(narrative, kind) : undefined;
	const byNarrative: Resolution | null = narrativeCategory
		? { merchant: name, key, categoryId: narrativeCategory, reason: 'narrative' }
		: null;
	if (byNarrative && narrative !== 'transfer') return byNarrative;
	const words = key ? tileFromWords(key.split(' '), kind) : undefined;
	if (words) {
		const categoryId = sources.tileCategory(words.tile, kind);
		if (categoryId) return { merchant: name, key, categoryId, reason: words.layer };
	}
	if (byNarrative) return byNarrative;
	if (!key) return none;
	if (item.hintTileKey) {
		const categoryId = sources.tileCategory(item.hintTileKey, kind);
		if (categoryId) return { merchant: name, key, categoryId, reason: 'keyword' };
	}
	return none;
}

/** Tiles a space may lack (a preset hidden or retiled) and the broader preset that stands in for each. */
export const TILE_FALLBACK: Readonly<Partial<Record<TileKey, TileKey>>> = {
	'ojek-online': 'transportasi',
	'pesan-antar-makanan': 'makan'
};

/** How a rule came to be: a user's correction (FN-20), or `manual` (reserved in the schema; no editor yet). */
export const MERCHANT_RULE_SOURCES = ['correction', 'manual'] as const;
/** What wrote a cache row: only the AI step caches (deterministic layers are cheap to recompute). */
export const MERCHANT_CACHE_REASONS = ['ai'] as const;
