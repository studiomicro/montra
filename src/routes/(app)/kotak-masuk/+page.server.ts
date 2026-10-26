import { dev } from '$app/env';
import { error, fail } from '@sveltejs/kit';
import { listCategories } from '#lib/server/categories/repo';
import { devRoutesEnabled } from '#lib/server/dev';
import { DRAFT_CHANGED, DRAFT_NOT_FOUND, DRAFTS_LOAD_FAILED } from '#lib/server/drafts/messages';
import { takeSavedNotice } from '#lib/server/drafts/notice';
import {
	clearDemoDrafts,
	countPendingDrafts,
	discardDraft,
	getDrafts,
	listPendingDrafts,
	renameDraft,
	seedDemoDrafts
} from '#lib/server/drafts/repo';
import { getEnv } from '#lib/server/env';
import { expectedUpdatedAt, idField, readFormBody } from '#lib/server/forms';
import type { MerchantReason } from '#lib/shared/merchants/resolve';
import { draftHints, draftSuggestedName } from '#lib/server/merchants/drafts';
import { countUnread } from '#lib/server/notifications/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { listWallets } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { errorLabel, sectionOr } from '#lib/server/util';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/** The dev-only seed tools exist only in `vite dev` or with DEV_ROUTES=1 (same gate as /dev/ui). */
const devTools = () => devRoutesEnabled(getEnv() as { DEV_ROUTES?: string }, dev);

export const load: PageServerLoad = async ({ locals, cookies }) => {
	const scope = await currentSpaceScope(locals);
	const { spaceId } = scope;
	const notice = takeSavedNotice(cookies, locals.secure);
	// FN-24: the unread notification count is the user's own (no space); a failure only hides the number.
	const unread = await sectionOr(
		'kotak-masuk: unread count failed',
		countUnread(locals.db, locals.user?.id ?? ''),
		null
	);
	const base = { today: wibTodayString(), devTools: devTools(), notice, unread };
	try {
		const db = locals.db;
		const [drafts, total, wallets, categories] = await Promise.all([
			listPendingDrafts(db, spaceId),
			countPendingDrafts(db, spaceId),
			listWallets(db, spaceId, { includeArchived: true }),
			listCategories(db, spaceId, { includeHidden: true })
		]);
		// FN-20: why each draft's category is what it is (a chip; none for a category the user picked), and the
		// AI-recognised name offered as "Pakai nama …" (never written into the title on its own).
		const hints = await draftHints(db, scope, drafts);
		return {
			...base,
			drafts,
			reasons: hints.reasons,
			names: hints.names,
			total,
			wallets: wallets.map(({ id, name }) => ({ id, name })),
			categories: categories.map(({ id, name, tileKey, isPreset }) => ({
				id,
				name,
				tileKey,
				isPreset
			})),
			loadError: null
		};
	} catch (e) {
		console.error('kotak-masuk: load failed', errorLabel(e));
		return {
			...base,
			drafts: [],
			reasons: {} as Record<string, MerchantReason>,
			names: {} as Record<string, string>,
			total: 0,
			wallets: [],
			categories: [],
			loadError: DRAFTS_LOAD_FAILED
		};
	}
};

/** Refuses a dev-only action (404, like /dev/ui) unless the gate is open; then the usual guarded scope. */
async function devAction(event: RequestEvent) {
	if (!devTools()) error(404, 'Not found');
	await readFormBody(event.request);
	return currentSpaceScope(event.locals);
}

export const actions: Actions = {
	discard: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const id = idField(form, 'id');
		// A malformed id or version matches nothing: the same answers as an unknown draft or a stale page.
		const result = await discardDraft(
			event.locals.db,
			scope,
			{
				id,
				updatedAt: expectedUpdatedAt(form)
			},
			Date.now()
		);
		if (result === 'missing') return fail(404, { error: DRAFT_NOT_FOUND });
		if (result === 'stale') return fail(409, { error: DRAFT_CHANGED });
		return { done: 'discarded' as const };
	},

	/**
	 * "Pakai nama …" (FN-20 red team L2, owner decision 2026-10-13): the draft takes the merchant name the server
	 * resolves for it now; the form carries only the draft's id and version, never a name.
	 */
	useName: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const id = idField(form, 'id');
		const ref = {
			id,
			updatedAt: expectedUpdatedAt(form)
		};
		const db = event.locals.db;
		const [draft] = ref.id ? await getDrafts(db, scope.spaceId, [ref.id]) : [];
		if (!draft) return fail(404, { error: DRAFT_NOT_FOUND });
		if (draft.updatedAt !== ref.updatedAt) return fail(409, { error: DRAFT_CHANGED });
		const name = await draftSuggestedName(db, scope, draft);
		if (!name) return fail(409, { error: DRAFT_CHANGED });
		const result = await renameDraft(db, scope, ref, name, Date.now());
		if (result === 'missing') return fail(404, { error: DRAFT_NOT_FOUND });
		if (result === 'stale') return fail(409, { error: DRAFT_CHANGED });
		return { done: 'renamed' as const };
	},

	seedDemoDrafts: async (event) => {
		const scope = await devAction(event);
		const added = await seedDemoDrafts(event.locals.db, scope, Date.now());
		return { done: 'seeded' as const, count: added };
	},

	clearDemoDrafts: async (event) => {
		const scope = await devAction(event);
		const cleared = await clearDemoDrafts(event.locals.db, scope, Date.now());
		return { done: 'cleared' as const, count: cleared };
	}
};
