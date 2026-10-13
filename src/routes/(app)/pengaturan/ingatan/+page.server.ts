import { fail, redirect } from '@sveltejs/kit';
import { readFormBody } from '#lib/server/forms';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { TANYA_CLEAR_FAILED, TANYA_LOAD_FAILED } from '#lib/server/tanya/messages';
import { countMessages, deleteConversation } from '#lib/server/tanya/repo';
import { errorLabel } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/**
 * FN-22 "Ingatan asisten": how many Tanya messages are stored for the signed-in user in the current space, and
 * "Hapus semua percakapan" (a hard delete of exactly those rows). The request carries no id: the scope is the
 * session's, re-checked by `currentSpaceScope`.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const scope = await currentSpaceScope(locals);
	const space = locals.space ? { name: locals.space.name, kind: locals.space.kind } : null;
	try {
		return { count: await countMessages(locals.db, scope, Date.now()), space, loadError: null };
	} catch (e) {
		console.error('pengaturan/ingatan: load failed', errorLabel(e));
		return { count: null, space, loadError: TANYA_LOAD_FAILED };
	}
};

export const actions: Actions = {
	hapus: async ({ locals, request }) => {
		const scope = await currentSpaceScope(locals);
		await readFormBody(request);
		try {
			await deleteConversation(locals.db, scope);
		} catch (e) {
			console.error('pengaturan/ingatan: delete failed', errorLabel(e));
			return fail(503, { error: TANYA_CLEAR_FAILED });
		}
		redirect(303, '/pengaturan/ingatan?dihapus=1');
	}
};
