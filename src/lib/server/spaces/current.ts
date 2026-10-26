import { error, redirect } from '@sveltejs/kit';
import { requireSpaceAccess, type SpaceAccess, type SpaceScope } from './access';

/**
 * The scope of a page that works on the session's current space (`locals.space`): re-checked through
 * `requireSpaceAccess` with `locals.user` on every load and action, so there is one access rule. Any id the
 * request carries is then only ever looked up inside this space, so another space's id reads as not found.
 * Signed out: 303 to /masuk; no current space: the shared 404. `space` and `role` are the re-checked membership's.
 */
export async function currentSpaceAccess(
	locals: App.Locals
): Promise<SpaceAccess & { scope: SpaceScope }> {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	if (!locals.space) error(404, 'Not found');
	const access = await requireSpaceAccess(locals.db, user.id, locals.space.id);
	return { ...access, scope: { spaceId: access.space.id, userId: user.id } };
}

/** `currentSpaceAccess` when the page needs only the scope. */
export async function currentSpaceScope(locals: App.Locals): Promise<SpaceScope> {
	return (await currentSpaceAccess(locals)).scope;
}
