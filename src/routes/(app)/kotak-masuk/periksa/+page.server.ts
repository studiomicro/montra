import { fail, redirect } from '@sveltejs/kit';
import { listCategories } from '#lib/server/categories/repo';
import {
	ALREADY_RECORDED,
	CATEGORY_KIND_MISMATCH,
	CATEGORY_NOT_FOUND,
	CATEGORY_REQUIRED,
	DRAFTS_LOAD_FAILED,
	MIXED_KIND,
	NONE_COMPLETE,
	NOTHING_SELECTED,
	SELECTION_CHANGED,
	SELECTION_GONE,
	TRANSACTION_LIMIT,
	WALLET_NOT_FOUND,
	WALLET_REQUIRED
} from '#lib/server/drafts/messages';
import { setSavedNotice } from '#lib/server/drafts/notice';
import {
	countPendingDrafts,
	listPendingDrafts,
	saveDrafts,
	setDraftsCategory,
	setDraftsWallet
} from '#lib/server/drafts/repo';
import { parseSelection } from '#lib/server/drafts/validation';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField, ID_MAX_LENGTH } from '#lib/server/forms';
import type { MerchantReason } from '#lib/shared/merchants/resolve';
import { draftHints, suggestDraftCategories } from '#lib/server/merchants/drafts';
import {
	AI_FAILED,
	AI_KEY_HINT,
	AI_NOT_CONFIGURED,
	AI_RATE_LIMITED
} from '#lib/server/merchants/messages';
import type { AiStepState } from '#lib/server/merchants/resolve';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { listWallets } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { errorLabel } from '#lib/server/util';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const scope = await currentSpaceScope(locals);
	const { spaceId } = scope;
	const today = wibTodayString();
	try {
		const db = locals.db;
		const [drafts, total, wallets, categories] = await Promise.all([
			listPendingDrafts(db, spaceId),
			countPendingDrafts(db, spaceId),
			listWallets(db, spaceId, { includeArchived: true }),
			listCategories(db, spaceId, { includeHidden: true })
		]);
		return {
			today,
			drafts,
			// FN-20: why each draft's category is what it is (a chip); none for a category the user picked.
			reasons: (await draftHints(db, scope, drafts)).reasons,
			total,
			wallets: wallets.map(({ id, name, currency, archived }) => ({
				id,
				name,
				currency,
				archived
			})),
			categories: categories.map(({ id, name, kind, tileKey, isPreset, isHidden }) => ({
				id,
				name,
				kind,
				tileKey,
				isPreset,
				isHidden
			})),
			loadError: null
		};
	} catch (e) {
		console.error('kotak-masuk/periksa: load failed', errorLabel(e));
		return {
			today,
			drafts: [],
			reasons: {} as Record<string, MerchantReason>,
			total: 0,
			wallets: [],
			categories: [],
			loadError: DRAFTS_LOAD_FAILED
		};
	}
};

/** The form, the guarded scope and the posted selection (bounded, de-duplicated) of a bulk action. */
async function bulk(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const scope = await currentSpaceScope(event.locals);
	return { form, scope, db: event.locals.db, selection: parseSelection(form) };
}

/** A posted id field, cut so an over-long one costs the same lookup (and matches nothing). */
const idField = (form: FormData, name: string) => {
	const value = textField(form, name);
	return value.length > ID_MAX_LENGTH ? '-' : value;
};

/** What the page says about the AI step after "Isi kategori otomatis" (null: nothing to say). */
function aiNotice(state: AiStepState): string | null {
	switch (state) {
		case 'no_key':
			return AI_KEY_HINT;
		case 'not_configured':
			return AI_NOT_CONFIGURED;
		case 'rate_limited':
			return AI_RATE_LIMITED;
		case 'failed':
			return AI_FAILED;
		default:
			return null;
	}
}

const gone = (reason: 'none' | 'stale') =>
	fail(409, { error: reason === 'none' ? SELECTION_GONE : SELECTION_CHANGED });

export const actions: Actions = {
	/**
	 * FN-20 "Isi kategori otomatis": every pending draft without a category (the page's list) gets the one the
	 * space's rules, history, cache, dictionary or — with the user's own key — AI names. Never overwrites a
	 * category, never saves a transaction; a missing key only adds a hint.
	 */
	suggest: async (event) => {
		await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const db = event.locals.db;
		const drafts = await listPendingDrafts(db, scope.spaceId);
		const r = await suggestDraftCategories(db, scope, drafts, { env: getEnv(), now: Date.now() });
		return { done: 'suggested' as const, updated: r.filled, skipped: 0, aiNotice: aiNotice(r.ai) };
	},

	setCategory: async (event) => {
		const { form, scope, db, selection } = await bulk(event);
		if (selection.items.length === 0) return fail(400, { error: NOTHING_SELECTED });
		const categoryId = idField(form, 'categoryId');
		if (!categoryId) return fail(400, { error: CATEGORY_REQUIRED });
		const r = await setDraftsCategory(db, scope, selection.items, categoryId, Date.now());
		if (r.ok) return { done: 'category' as const, updated: r.updated, skipped: 0 };
		if (r.reason === 'none' || r.reason === 'stale') return gone(r.reason);
		const error =
			r.reason === 'mixed'
				? MIXED_KIND
				: r.reason === 'kind'
					? CATEGORY_KIND_MISMATCH
					: CATEGORY_NOT_FOUND;
		return fail(400, { error });
	},

	setWallet: async (event) => {
		const { form, scope, db, selection } = await bulk(event);
		if (selection.items.length === 0) return fail(400, { error: NOTHING_SELECTED });
		const walletId = idField(form, 'walletId');
		if (!walletId) return fail(400, { error: WALLET_REQUIRED });
		const r = await setDraftsWallet(db, scope, selection.items, walletId, Date.now());
		if (r.ok) return { done: 'wallet' as const, updated: r.updated, skipped: r.skipped };
		if (r.reason === 'wallet') return fail(400, { error: WALLET_NOT_FOUND });
		return gone(r.reason);
	},

	save: async (event) => {
		const { scope, db, selection } = await bulk(event);
		if (selection.items.length === 0) return fail(400, { error: NOTHING_SELECTED });
		const r = await saveDrafts(db, scope, selection.items, Date.now());
		if (!r.ok) {
			if (r.reason === 'none' || r.reason === 'stale') return gone(r.reason);
			return fail(409, { error: r.reason === 'limit' ? TRANSACTION_LIMIT : ALREADY_RECORDED });
		}
		// Nothing complete in the selection: nothing was written, so stay and say what is missing.
		if (r.saved === 0) return fail(400, { error: NONE_COMPLETE });
		setSavedNotice(event.cookies, event.locals.secure, {
			saved: r.saved,
			total: r.saved + r.incomplete,
			incomplete: r.incomplete,
			remaining: selection.remaining
		});
		redirect(303, '/kotak-masuk');
	}
};
