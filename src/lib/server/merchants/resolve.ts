import { cleanDescriptor } from '#lib/shared/merchants/clean';
import {
	layerKey,
	resolveDeterministic,
	TILE_FALLBACK,
	type MerchantReason
} from '#lib/shared/merchants/resolve';
import { isFallbackCategory, type CategoryKind, type TileKey } from '#lib/shared/transactions';
import { isAiGatewayConfigured, type AiGatewayEnv } from '../ai-keys/anthropic';
import type { AiKeysEnv } from '../ai-keys/crypto';
import { resolveAnthropicKey } from '../ai-keys/lookup';
import { overUserSlidingLimit } from '../auth/throttle';
import { listCategories, type CategorySummary } from '../categories/repo';
import type { Db } from '../db';
import type { SpaceScope } from '../spaces/access';
import { classifyMerchants, MERCHANT_AI_BATCH_MAX, type AiAnswer } from './ai';
import { cacheForKeys, historyForKeys, rulesForKeys, writeCache } from './repo';

/**
 * FN-20's one entry point: `resolveMerchants` cleans each descriptor and finds its category in the order the
 * owner set (decision 1): the space's rule, the space's history, the AI cache, the dictionary and keyword groups,
 * then — only when the caller allows it, the user has a readable key and the gateway is configured — one AI
 * call per batch of up to 40 distinct keys of one kind. A category is only ever one of the space's visible
 * categories of the row's kind; nothing is created, and no amount, date or wallet is read or written here.
 * Resolve first, write after: no D1 batch spans the AI call.
 */

/** Most items one call resolves; the rest come back `none` (PRD AC-19). */
export const RESOLVE_BATCH_MAX = 200;
/** Most AI requests one user action makes (owner decision 6). */
const MERCHANT_AI_BATCHES_MAX = 5;
/** AI-resolve requests one user may make per hour (owner decision 6). */
export const MERCHANT_AI_CALLS_PER_HOUR = 20;
/**
 * Suggestion requests (`/riwayat/saran`, deterministic, each reads up to HISTORY_ROWS_MAX rows) one user may make
 * per throttle window (10 minutes). The client sends at most one per 400 ms pause while typing, so a person
 * entering a transaction every few seconds stays far below; a script loop does not (FN-20 red team L1).
 */
export const MERCHANT_SUGGESTS_PER_WINDOW = 300;
const HOUR_MS = 60 * 60 * 1000;

/** How sure each layer is: a member's own rule most, an AI guess least. Below 0.75 asks for review. */
const REASON_CONFIDENCE: Readonly<Record<MerchantReason, number>> = {
	rule: 1,
	history: 0.9,
	dictionary: 0.85,
	keyword: 0.8,
	narrative: 0.85,
	cache: 0.6,
	ai: 0.6,
	none: 0
};

export interface ResolveRequestItem {
	rawText: string;
	type: CategoryKind;
	hintTileKey?: TileKey;
}

export interface ResolvedItem {
	/** The name cleaned from the bank or mail text itself (no AI): the only name ever written as a title. */
	merchant: string;
	/**
	 * A name the AI recognised (this call or the cache) when it differs from `merchant`: shown only as a
	 * tap-to-apply suggestion, never written into a title on its own (owner decision 2026-10-13, red team L2).
	 */
	suggestedName: string | null;
	categoryId: string | null;
	reason: MerchantReason;
	confidence: number;
}

/** What happened to the AI step (a page shows the key hint for `no_key`, "belum dikonfigurasi" for `not_configured`). */
export type AiStepState =
	'not_needed' | 'off' | 'no_key' | 'not_configured' | 'used' | 'rate_limited' | 'failed';

export interface ResolveOptions {
	userId: string;
	allowAi: boolean;
	env?: AiKeysEnv & AiGatewayEnv;
	now?: number;
	fetchFn?: typeof fetch;
}

/** The space's visible category for a tile and kind: its preset first, then any category on that tile. */
function tileLookup(categories: readonly CategorySummary[]) {
	return (tile: TileKey, kind: CategoryKind): string | undefined => {
		const find = (t: TileKey) =>
			categories.find((c) => c.tileKey === t && c.kind === kind && c.isPreset) ??
			categories.find((c) => c.tileKey === t && c.kind === kind);
		const fallback = TILE_FALLBACK[tile];
		return (find(tile) ?? (fallback ? find(fallback) : undefined))?.id;
	};
}

export async function resolveMerchants(
	db: Db,
	scope: SpaceScope,
	items: readonly ResolveRequestItem[],
	opts: ResolveOptions
): Promise<{ items: ResolvedItem[]; ai: AiStepState }> {
	const now = opts.now ?? Date.now();
	const { spaceId } = scope;
	const kept = items.slice(0, RESOLVE_BATCH_MAX);
	const overflow = items.slice(RESOLVE_BATCH_MAX).map((i): ResolvedItem => ({
		merchant: cleanDescriptor(i.rawText).name,
		suggestedName: null,
		categoryId: null,
		reason: 'none',
		confidence: 0
	}));
	const cleaned = kept.map((i) => cleanDescriptor(i.rawText));
	const layerKeys = [
		...new Set(cleaned.flatMap((c, i) => (c.key ? [layerKey(kept[i]!.type, c.key)] : [])))
	];
	const [categories, rules, history, cache] = await Promise.all([
		listCategories(db, spaceId),
		rulesForKeys(db, spaceId, layerKeys),
		historyForKeys(db, spaceId, layerKeys, now),
		cacheForKeys(db, spaceId, layerKeys, now)
	]);
	const visible = new Map(categories.map((c) => [c.id, c.kind]));
	const fallbacks = new Set(categories.filter(isFallbackCategory).map((c) => c.id));
	const sources = {
		rules,
		history,
		cache,
		usable: (id: string, kind: CategoryKind) => visible.get(id) === kind,
		tileCategory: tileLookup(categories),
		isFallback: (id: string) => fallbacks.has(id)
	};
	const resolved = kept.map((item) => {
		const r = resolveDeterministic(
			{ rawText: item.rawText, kind: item.type, hintTileKey: item.hintTileKey },
			sources
		);
		// A cached AI answer may carry a cleaner name: a suggestion only.
		const cachedName =
			r.reason === 'cache' ? cache.get(layerKey(item.type, r.key))?.merchantName : null;
		return { ...r, aiName: cachedName || null, kind: item.type };
	});

	// Keys still without a category and never asked before (a cached "none" is not asked again).
	const pending = new Map<string, { kind: CategoryKind; key: string }>();
	for (const r of resolved)
		if (r.reason === 'none' && r.key && !cache.has(layerKey(r.kind, r.key)))
			pending.set(layerKey(r.kind, r.key), { kind: r.kind, key: r.key });

	let ai: AiStepState = 'not_needed';
	const answers = new Map<string, AiAnswer>();
	if (pending.size > 0) {
		ai = await runAi(db, scope, [...pending.values()], categories, opts, now, answers);
	}

	const out = resolved.map((r): ResolvedItem => {
		const answer = r.reason === 'none' ? answers.get(layerKey(r.kind, r.key)) : undefined;
		if (answer?.categoryId && visible.get(answer.categoryId) === r.kind)
			return {
				merchant: r.merchant,
				suggestedName: suggestion(answer.merchantName, r.merchant),
				categoryId: answer.categoryId,
				reason: 'ai',
				confidence: REASON_CONFIDENCE.ai
			};
		return {
			merchant: r.merchant,
			suggestedName: suggestion(r.aiName, r.merchant),
			categoryId: r.categoryId,
			reason: r.reason,
			confidence: REASON_CONFIDENCE[r.reason]
		};
	});
	return { items: [...out, ...overflow], ai };
}

/** An AI-recognised name worth offering: set and not the cleaned name already. */
function suggestion(aiName: string | null | undefined, merchant: string): string | null {
	return aiName && aiName !== merchant ? aiName : null;
}

/** The AI step for `pending` keys; fills `answers` (by layer key) and caches them. Never throws. */
async function runAi(
	db: Db,
	scope: SpaceScope,
	pending: readonly { kind: CategoryKind; key: string }[],
	categories: readonly CategorySummary[],
	opts: ResolveOptions,
	now: number,
	answers: Map<string, AiAnswer>
): Promise<AiStepState> {
	if (!opts.allowAi) return 'off';
	if (!isAiGatewayConfigured(opts.env)) return 'not_configured';
	const apiKey = await resolveAnthropicKey(db, opts.userId, opts.env);
	if (!apiKey) return 'no_key';
	const batches: { kind: CategoryKind; keys: string[] }[] = [];
	for (const kind of ['expense', 'income'] as const) {
		const keys = pending.filter((p) => p.kind === kind).map((p) => p.key);
		for (let i = 0; i < keys.length; i += MERCHANT_AI_BATCH_MAX)
			batches.push({ kind, keys: keys.slice(i, i + MERCHANT_AI_BATCH_MAX) });
	}
	let state: AiStepState = 'used';
	for (const batch of batches.slice(0, MERCHANT_AI_BATCHES_MAX)) {
		const offered = categories
			.filter((c) => c.kind === batch.kind)
			.map((c) => ({ id: c.id, name: c.name }));
		if (offered.length === 0) continue;
		if (
			// FN-20 red team L4: a sliding hour, so no 60 minutes ever hold more than the cap.
			await overUserSlidingLimit(
				db,
				opts.userId,
				now,
				'merchant-ai',
				MERCHANT_AI_CALLS_PER_HOUR,
				HOUR_MS
			)
		)
			return 'rate_limited';
		const outcome = await classifyMerchants(
			opts.env,
			apiKey,
			batch.kind,
			batch.keys,
			offered,
			opts.fetchFn
		);
		if (outcome.kind !== 'ok') {
			state = 'failed';
			continue;
		}
		const entries = [...outcome.answers].map(([key, a]) => ({
			key,
			kind: batch.kind,
			merchantName: a.merchantName,
			categoryId: a.categoryId
		}));
		for (const [key, a] of outcome.answers) answers.set(layerKey(batch.kind, key), a);
		try {
			await writeCache(db, scope, entries, now);
		} catch (e) {
			console.error('merchants: cache write failed', e instanceof Error ? e.message : 'unknown');
		}
	}
	return state;
}
