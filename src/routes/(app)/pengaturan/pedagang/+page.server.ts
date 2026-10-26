import { fail, redirect } from '@sveltejs/kit';
import { expectedUpdatedAt, idField, readFormBody, textField } from '#lib/server/forms';
import {
	DELETE_ALL_UNCONFIRMED,
	RULE_CHANGED,
	RULE_NOT_FOUND,
	RULES_LOAD_FAILED
} from '#lib/server/merchants/messages';
import {
	deleteAllRules,
	deleteRule,
	listRules,
	MERCHANT_SEARCH_MAX_LENGTH
} from '#lib/server/merchants/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { errorLabel } from '#lib/server/util';
import { cleanText } from '#lib/shared/text';
import type { Actions, PageServerLoad } from './$types';

/**
 * FN-20 "Pedagang & aturan": the current space's learned merchant rules (search, delete one, delete all; no
 * editor, owner decision 8). Owner and member manage them alike. The space is the session's, re-checked by
 * `currentSpaceScope` on every load and action; a rule id from the form is only looked up inside it, so another
 * space's id, a deleted one and an unknown one get the same 404.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const search = cleanText(url.searchParams.get('q') ?? '', MERCHANT_SEARCH_MAX_LENGTH);
	try {
		return { rules: await listRules(locals.db, spaceId, search), search, loadError: null };
	} catch (e) {
		console.error('pengaturan/pedagang: load failed', errorLabel(e));
		return { rules: [], search, loadError: RULES_LOAD_FAILED };
	}
};

export const actions: Actions = {
	hapus: async ({ locals, request }) => {
		const form = await readFormBody(request);
		const scope = await currentSpaceScope(locals);
		const id = idField(form, 'id');
		const result = await deleteRule(locals.db, scope, id, expectedUpdatedAt(form), Date.now());
		if (result === 'missing') return fail(404, { error: RULE_NOT_FOUND });
		if (result === 'stale') return fail(409, { error: RULE_CHANGED });
		return { done: 'deleted' as const, count: 1 };
	},

	hapusSemua: async ({ locals, request }) => {
		const form = await readFormBody(request);
		const scope = await currentSpaceScope(locals);
		if (textField(form, 'confirm') !== '1') return fail(400, { error: DELETE_ALL_UNCONFIRMED });
		const count = await deleteAllRules(locals.db, scope, Date.now());
		redirect(303, `/pengaturan/pedagang?dihapus=${count}`);
	}
};
