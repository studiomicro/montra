import { apiRoute } from '#lib/server/api/http';
import { ENDPOINTS } from '#lib/server/api/endpoints';
import { categoryOut } from '#lib/server/api/serialize';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';

// FN-38 public API. Bearer-token authenticated only (apiRoute); `space_id` admitted by requireSpaceAccess.
// A space gets its preset categories on first read, exactly as every category screen does.
export const GET = apiRoute(ENDPOINTS.listCategories, async ({ db, access, now }) => {
	const spaceId = access!.space.id;
	await ensurePresetCategories(db, spaceId, now);
	const categories = await listCategories(db, spaceId, { includeHidden: true });
	return { data: categories.map(categoryOut) };
});
