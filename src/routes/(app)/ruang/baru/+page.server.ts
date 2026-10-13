import { fail, redirect } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { setSpaceCookie } from '#lib/server/spaces/access';
import { SPACE_NAME_REQUIRED } from '#lib/server/spaces/messages';
import { createSharedSpace, SPACE_NAME_MAX_LENGTH } from '#lib/server/spaces/spaces';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ nameMax: SPACE_NAME_MAX_LENGTH });

export const actions: Actions = {
	/** Creates a shared space owned by the user, makes it current and opens it. */
	default: async ({ request, locals, cookies }) => {
		const user = locals.user;
		if (!user) redirect(303, '/masuk?next=%2Fruang%2Fbaru');
		const form = await readFormBody(request);
		const name = textField(form, 'name');
		const spaceId = await createSharedSpace(locals.db, user.id, name, Date.now());
		if (!spaceId)
			return fail(400, {
				error: SPACE_NAME_REQUIRED,
				values: { name: name.slice(0, SPACE_NAME_MAX_LENGTH * 4) }
			});
		setSpaceCookie(cookies, spaceId, locals.secure);
		redirect(303, `/ruang/${spaceId}`);
	}
};
