import { error, redirect } from '@sveltejs/kit';
import { requireSpaceAccess, type SpaceScope } from './access';

/**
 * The scope of a page that works on the session's current space (`locals.space`): re-checked through
 * `requireSpaceAccess` with `locals.user` on every load and action, so there is one access rule. Any id the
 * request carries is then only ever looked up inside this space, so another space's id reads as not found.
 */
export async function currentSpaceScope(locals: App.Locals): Promise<SpaceScope> {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	if (!locals.space) error(404, 'Not found');
	const access = await requireSpaceAccess(locals.db, user.id, locals.space.id);
	return { spaceId: access.space.id, userId: user.id };
}
