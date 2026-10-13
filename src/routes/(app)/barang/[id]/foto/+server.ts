import { error } from '@sveltejs/kit';
import { belongingSpaceId, getBelongingPhoto } from '#lib/server/belongings/repo';
import { getEnv } from '#lib/server/env';
import { photoResponse } from '#lib/server/photos/store';
import { requireSpaceAccess } from '#lib/server/spaces/access';
import type { RequestHandler } from './$types';

/**
 * A belonging's photo (FN-27), the only way to read it: the bucket is never public. The belonging's space goes
 * through requireSpaceAccess (an unknown id asks about the space '' and so gets the same 404 with the same
 * body), and the read repeats the live membership in its own statement. A deleted item, an item without a
 * photo and a missing object all answer that same 404.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	const user = locals.user;
	if (!user) error(404, 'Not found');
	const id = params.id.slice(0, 64);
	const access = await requireSpaceAccess(
		locals.db,
		user.id,
		await belongingSpaceId(locals.db, id)
	);
	const photo = await getBelongingPhoto(
		locals.db,
		{ spaceId: access.space.id, userId: user.id },
		id
	);
	if (!photo) error(404, 'Not found');
	return photoResponse(getEnv().FILES, photo.key, photo.type, request);
};
