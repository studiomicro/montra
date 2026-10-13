import { error, fail, redirect } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import {
	clearSpaceCookie,
	MAX_SPACE_MEMBERS,
	requireSpaceAccess,
	setLeftNotice,
	spaceCookieName
} from '#lib/server/spaces/access';
import { createInvite, invitePath, liveInvite, revokeInvite } from '#lib/server/spaces/invites';
import { CHANGED_MEANWHILE, OWNER_STAYS } from '#lib/server/spaces/messages';
import { leaveSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// Every load and action checks the route's space id with requireSpaceAccess (never locals.space): a
// non-member, a removed member and a missing space all get the same 404.

function signedIn(event: { locals: App.Locals }) {
	const user = event.locals.user;
	if (!user) redirect(303, '/masuk');
	return user;
}

/** The owner of this shared space, or the helper's 404/403 (a personal space has no invites or members). */
async function ownerOfShared(event: RequestEvent) {
	const user = signedIn(event);
	const access = await requireSpaceAccess(event.locals.db, user.id, event.params.id, {
		role: 'owner'
	});
	if (access.space.kind !== 'shared') error(403, 'Forbidden');
	return { user, access };
}

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = signedIn({ locals });
	const access = await requireSpaceAccess(locals.db, user.id, params.id);
	const ownsShared = access.role === 'owner' && access.space.kind === 'shared';
	const invite = ownsShared ? await liveInvite(locals.db, access.space.id) : null;
	const now = Date.now();
	return {
		space: access.space,
		role: access.role,
		members: await listMembers(locals.db, access.space.id, user.id),
		maxMembers: MAX_SPACE_MEMBERS,
		// Never the token: only that a link is live and until when.
		invite: invite && {
			id: invite.id,
			expiresAt: invite.expiresAt,
			expired: invite.expiresAt <= now
		},
		isCurrent: locals.space?.id === access.space.id
	};
};

export const actions: Actions = {
	/** A new invite link (revoking the live one the form names); the raw link is in this response only. */
	createInvite: async (event) => {
		const form = await readFormBody(event.request);
		const { user, access } = await ownerOfShared(event);
		const created = await createInvite(
			event.locals.db,
			{ spaceId: access.space.id, userId: user.id, replaces: textField(form, 'replaces') },
			Date.now()
		);
		if (!created) return fail(409, { error: CHANGED_MEANWHILE });
		return {
			created: {
				link: new URL(invitePath(created.token), event.url.origin).href,
				expiresAt: created.expiresAt
			}
		};
	},

	revokeInvite: async (event) => {
		const form = await readFormBody(event.request);
		const { user, access } = await ownerOfShared(event);
		const revoked = await revokeInvite(
			event.locals.db,
			{ spaceId: access.space.id, userId: user.id, inviteId: textField(form, 'inviteId') },
			Date.now()
		);
		if (!revoked) return fail(409, { error: CHANGED_MEANWHILE });
		return { revoked: true };
	},

	removeMember: async (event) => {
		const form = await readFormBody(event.request);
		const { user, access } = await ownerOfShared(event);
		const result = await removeMember(
			event.locals.db,
			{ spaceId: access.space.id, actorUserId: user.id, memberId: textField(form, 'memberId') },
			Date.now()
		);
		if (result === 'owner') return fail(400, { error: OWNER_STAYS });
		if (result === 'gone') return fail(409, { error: CHANGED_MEANWHILE });
		return { removed: true };
	},

	/** A member (never the owner, decision D) leaves; back to the personal space if this one was current. */
	leave: async (event) => {
		await readFormBody(event.request);
		const user = signedIn(event);
		const { locals, cookies, params } = event;
		const access = await requireSpaceAccess(locals.db, user.id, params.id, { role: 'member' });
		const left = await leaveSpace(
			locals.db,
			{ spaceId: access.space.id, userId: user.id },
			Date.now()
		);
		// Lost a race (left or removed meanwhile): no success notice for a write that did not happen.
		if (!left) return fail(409, { error: CHANGED_MEANWHILE });
		if (cookies.get(spaceCookieName(locals.secure)) === access.space.id)
			clearSpaceCookie(cookies, locals.secure);
		setLeftNotice(cookies, locals.secure);
		redirect(303, '/ruang');
	}
};
