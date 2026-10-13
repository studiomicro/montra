import { error } from '@sveltejs/kit';
import { collectibleSpaceId, getCollectiblePhoto } from '#lib/server/collectibles/repo';
import { getEnv } from '#lib/server/env';
import { photoResponse } from '#lib/server/photos/store';
import { requireSpaceAccess } from '#lib/server/spaces/access';
import type { RequestHandler } from './$types';

/**
 * A collectible's photo (FN-28), the only way to read it: the bucket is never public. Same shape as FN-27's
 * /barang/[id]/foto: the item's space goes through requireSpaceAccess (an unknown id asks about the space ''
 * and so gets the same 404 with the same body), the read repeats the live membership in its own statement, and
 * the response comes from the shared photo module. A deleted item, an item without a photo and a missing
 * object all answer that same 404.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	const user = locals.user;
	if (!user) error(404, 'Not found');
	const id = params.id.slice(0, 64);
	const access = await requireSpaceAccess(
		locals.db,
		user.id,
		await collectibleSpaceId(locals.db, id)
	);
	const photo = await getCollectiblePhoto(
		locals.db,
		{ spaceId: access.space.id, userId: user.id },
		id
	);
	if (!photo) error(404, 'Not found');
	return photoResponse(getEnv().FILES, photo.key, photo.type, request);
};
