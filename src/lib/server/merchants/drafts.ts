import type { MerchantReason } from '#lib/shared/merchants/resolve';
import type { CategoryKind } from '#lib/shared/transactions';
import type { Db } from '../db';
import { fillDraftCategories } from '../drafts/repo';
import type { SpaceScope } from '../spaces/access';
import { resolveMerchants, type AiStepState, type ResolveOptions } from './resolve';

/**
 * FN-20 on the draft screens (Kotak masuk, Periksa draf). `draftHints` explains a draft's current category and offers its AI-recognised name
 * with a chip (deterministic layers only, a read: no AI, no write); `suggestDraftCategories` is the explicit
 * "Isi kategori otomatis" action, the only place drafts get an AI suggestion.
 */

interface DraftLike {
	id: string;
	type: CategoryKind;
	title: string | null;
	categoryId: string | null;
	updatedAt: number;
}

/** What the draft screens show next to each draft (FN-20). */
export interface DraftHints {
	/** Why its category is what it is (the layer that names that very category today). */
	reasons: Record<string, MerchantReason>;
	/**
	 * A merchant name the AI recognised for it (red team L2, owner decision 2026-10-13): offered as "Pakai nama …",
	 * never written into the title on its own.
	 */
	names: Record<string, string>;
}

/**
 * Per draft id, why its category is what it is: the reason of the layer that names that very category today
 * (rule, history, cache, dictionary, keyword). Drafts whose category no layer names (the user picked it) get no
 * entry, so a changed category never keeps the old chip. Also the AI-recognised name of each draft that has one
 * and does not carry it already. Deterministic layers and the cache only (a read: no AI call, no write). Never
 * throws: a failure only hides the chips.
 */
export async function draftHints(
	db: Db,
	scope: SpaceScope,
	drafts: readonly DraftLike[]
): Promise<DraftHints> {
	const withTitle = drafts.filter((d) => d.title);
	const out: DraftHints = { reasons: {}, names: {} };
	if (withTitle.length === 0) return out;
	try {
		const { items } = await resolveMerchants(
			db,
			scope,
			withTitle.map((d) => ({ rawText: d.title ?? '', type: d.type })),
			{ userId: scope.userId, allowAi: false }
		);
		withTitle.forEach((d, i) => {
			const r = items[i];
			if (!r) return;
			if (d.categoryId && r.reason !== 'none' && r.categoryId === d.categoryId)
				out.reasons[d.id] = r.reason;
			if (r.suggestedName && r.suggestedName !== d.title) out.names[d.id] = r.suggestedName;
		});
	} catch (e) {
		console.error('merchants: draft hints failed', e instanceof Error ? e.message : 'unknown');
	}
	return out;
}

/** The AI-recognised name of one draft (the "Pakai nama …" action re-resolves it on the server), or null. */
export async function draftSuggestedName(
	db: Db,
	scope: SpaceScope,
	draft: DraftLike
): Promise<string | null> {
	return (await draftHints(db, scope, [draft])).names[draft.id] ?? null;
}

/**
 * Fills the categories of `drafts` that have none, with every layer and (when allowed and configured) the AI
 * step. Returns how many drafts got a category and what happened to the AI step.
 */
export async function suggestDraftCategories(
	db: Db,
	scope: SpaceScope,
	drafts: readonly DraftLike[],
	opts: Omit<ResolveOptions, 'userId' | 'allowAi'> & { now: number }
): Promise<{ filled: number; ai: AiStepState }> {
	const open = drafts.filter((d) => !d.categoryId && d.title);
	if (open.length === 0) return { filled: 0, ai: 'not_needed' };
	const { items, ai } = await resolveMerchants(
		db,
		scope,
		open.map((d) => ({ rawText: d.title ?? '', type: d.type })),
		{ ...opts, userId: scope.userId, allowAi: true }
	);
	const fills = open.flatMap((d, i) => {
		const categoryId = items[i]?.categoryId;
		return categoryId ? [{ id: d.id, updatedAt: d.updatedAt, categoryId }] : [];
	});
	return { filled: await fillDraftCategories(db, scope, fills, opts.now), ai };
}
