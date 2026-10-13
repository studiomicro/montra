import { redirect } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { requireSpaceAccess, setSpaceCookie, takeLeftNotice } from '#lib/server/spaces/access';
import { listSpaces } from '#lib/server/spaces/spaces';
import type { Actions, PageServerLoad } from './$types';

// hooks.server.ts (auth/gate.ts) answers every signed-out request to this (app) route before it gets here;
// the user checks below only narrow the type and fail closed if that ever changes.

export const load: PageServerLoad = async ({ locals, cookies }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fruang');
	return {
		spaces: await listSpaces(locals.db, user.id),
		currentId: locals.space?.id ?? null,
		// Set only by a confirmed leave (cookie, not a query parameter anyone could link to).
		left: takeLeftNotice(cookies, locals.secure)
	};
};

export const actions: Actions = {
	/** Makes a space the current one; the membership is re-checked before the cookie changes. */
	switchSpace: async ({ request, locals, cookies }) => {
		const user = locals.user;
		if (!user) redirect(303, '/masuk?next=%2Fruang');
		const form = await readFormBody(request);
		const access = await requireSpaceAccess(locals.db, user.id, textField(form, 'spaceId'));
		setSpaceCookie(cookies, access.space.id, locals.secure);
		redirect(303, '/ruang');
	}
};
