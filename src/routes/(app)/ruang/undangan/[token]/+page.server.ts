import { fail, redirect } from '@sveltejs/kit';
import { readFormBody } from '#lib/server/forms';
import { MAX_SPACE_MEMBERS, setSpaceCookie } from '#lib/server/spaces/access';
import { acceptInvite, resolveInvite } from '#lib/server/spaces/invites';
import { INVITE_INVALID, SPACE_FULL } from '#lib/server/spaces/messages';
import type { Actions, PageServerLoad } from './$types';

// A signed-out visitor never gets here: the (app) gate sends them to /masuk?next=/ruang/undangan/<token>.

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	const invite = await resolveInvite(locals.db, params.token, user.id, Date.now());
	// Unknown, malformed, expired and revoked tokens are one state with one message.
	if (!invite) return { state: 'invalid' as const, spaceName: null };
	const state = invite.isMember
		? ('member' as const)
		: invite.memberCount >= MAX_SPACE_MEMBERS
			? ('full' as const)
			: ('open' as const);
	return { state, spaceName: invite.spaceName };
};

export const actions: Actions = {
	/** Joins the space (5-member cap checked inside the write), makes it current and opens Beranda. */
	accept: async ({ request, locals, params, cookies }) => {
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		await readFormBody(request);
		const result = await acceptInvite(locals.db, params.token, user.id, Date.now());
		if (result.status === 'invalid') return fail(404, { error: INVITE_INVALID });
		if (result.status === 'full') return fail(409, { error: SPACE_FULL });
		setSpaceCookie(cookies, result.spaceId, locals.secure);
		redirect(303, '/');
	}
};
