import { fail, redirect } from '@sveltejs/kit';
import { flagsFrom, isModule } from '#lib/shared/feature-flags';
import { FLAGS_LOAD_FAILED, MODULE_INVALID } from '#lib/server/feature-flags/messages';
import { getFeatureFlags, setFeatureFlag } from '#lib/server/feature-flags/repo';
import { readFormBody, textField } from '#lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

// Flags belong to the signed-in user (locals.user), never to a space and never to an id from the request:
// a user can only ever read and change their own. hooks.server.ts answers signed-out requests first; the
// checks below only narrow the type and fail closed if that ever changes.

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fpengaturan%2Ffitur');
	try {
		return { flags: await getFeatureFlags(locals.db, user.id), loadError: null };
	} catch (e) {
		console.error('pengaturan/fitur: flags load failed', e);
		return { flags: flagsFrom([]), loadError: FLAGS_LOAD_FAILED };
	}
};

export const actions: Actions = {
	/** Stores one module's flag: `enabled=on` shows it, a missing `enabled` (unchecked box) hides it. */
	setFlag: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const module = textField(form, 'module');
		if (!isModule(module)) return fail(400, { error: MODULE_INVALID });
		const enabled = textField(form, 'enabled') === 'on';
		await setFeatureFlag(locals.db, user.id, module, enabled, Date.now());
		return { saved: module, enabled };
	}
};
