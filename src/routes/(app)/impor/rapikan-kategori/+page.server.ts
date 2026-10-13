import { fail } from '@sveltejs/kit';
import {
	applyCleanup,
	CLEANUP_PREVIEW_MAX,
	latestCleanup,
	previewCleanup,
	undoCleanup
} from '#lib/server/categories/cleanup';
import {
	CLEANUP_ALREADY_APPLIED,
	CLEANUP_ALREADY_UNDONE,
	CLEANUP_LOAD_FAILED,
	CLEANUP_NONE_SELECTED,
	CLEANUP_NOT_FOUND,
	CLEANUP_NOTHING
} from '#lib/server/categories/messages';
import { listCategories } from '#lib/server/categories/repo';
import { readFormBody, textField } from '#lib/server/forms';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { TRANSACTION_CHANGED } from '#lib/server/transactions/messages';
import { ID_MAX_LENGTH } from '#lib/server/transactions/validation';
import { errorLabel, newId } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

const UPDATED_AT = /^\d{1,15}$/;
/** The review's nonce (`newId`, a UUID): the id the batch is written under, so a resent form is recognised. */
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Room for CLEANUP_PREVIEW_MAX ids (`id=<uuid>&`, about 40 bytes each) plus the nonce. */
const APPLY_BODY_MAX_BYTES = 32 * 1024;

/**
 * FN-48 "Rapikan kategori" (sub-view of /impor). Every load and action re-checks the membership through
 * `currentSpaceScope`; the write statements repeat `isLiveMember` (categories/cleanup.ts). The review is computed
 * on the server; the form sends row ids only.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const scope = await currentSpaceScope(locals);
	const db = locals.db;
	try {
		const preview = await previewCleanup(db, scope, Date.now());
		const [categories, latest] = await Promise.all([
			listCategories(db, scope.spaceId, { includeHidden: true }),
			latestCleanup(db, scope.spaceId)
		]);
		const used = new Set(preview.proposals.flatMap((p) => [p.fromCategoryId, p.toCategoryId]));
		return {
			batchId: newId(),
			preview,
			max: CLEANUP_PREVIEW_MAX,
			categories: categories
				.filter((c) => used.has(c.id))
				.map(({ id, name, tileKey, isPreset }) => ({ id, name, tileKey, isPreset })),
			latest,
			loadError: null
		};
	} catch (e) {
		console.error('rapikan-kategori: load failed', errorLabel(e));
		return {
			batchId: newId(),
			preview: null,
			max: CLEANUP_PREVIEW_MAX,
			categories: [],
			latest: null,
			loadError: CLEANUP_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	apply: async (event) => {
		const form = await readFormBody(event.request, APPLY_BODY_MAX_BYTES);
		const scope = await currentSpaceScope(event.locals);
		const batchId = textField(form, 'batchId');
		const ids = form
			.getAll('id')
			.filter((v): v is string => typeof v === 'string' && v !== '' && v.length <= ID_MAX_LENGTH)
			.slice(0, CLEANUP_PREVIEW_MAX);
		if (ids.length === 0) return fail(400, { error: CLEANUP_NONE_SELECTED });
		// A malformed nonce matches nothing a later resend could find: refused like a stale page.
		if (!BATCH_ID.test(batchId)) return fail(409, { error: TRANSACTION_CHANGED });
		const result = await applyCleanup(event.locals.db, scope, batchId, ids, Date.now());
		if (result.status === 'already')
			return { done: 'already' as const, message: CLEANUP_ALREADY_APPLIED };
		if (result.status === 'none') return fail(409, { error: CLEANUP_NOTHING });
		if (result.status === 'stale') return fail(409, { error: TRANSACTION_CHANGED });
		return { done: 'applied' as const, applied: result.applied, changed: result.changed };
	},

	undo: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const id = textField(form, 'id');
		const updatedAt = textField(form, 'updatedAt');
		// A malformed id or version matches nothing: the same answers as an unknown batch or a stale page.
		const result = await undoCleanup(
			event.locals.db,
			scope,
			id.length > ID_MAX_LENGTH ? '' : id,
			UPDATED_AT.test(updatedAt) ? Number(updatedAt) : -1,
			Date.now()
		);
		if (result.status === 'missing') return fail(404, { error: CLEANUP_NOT_FOUND });
		if (result.status === 'stale') return fail(409, { error: TRANSACTION_CHANGED });
		if (result.status === 'already')
			return { done: 'already' as const, message: CLEANUP_ALREADY_UNDONE };
		return { done: 'undone' as const, reverted: result.reverted, kept: result.kept };
	}
};
