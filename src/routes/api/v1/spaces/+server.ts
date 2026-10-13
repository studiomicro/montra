import { apiRoute } from '#lib/server/api/http';
import { ENDPOINTS } from '#lib/server/api/endpoints';
import { spaceOut } from '#lib/server/api/serialize';
import { listSpaces } from '#lib/server/spaces/spaces';

// FN-38 public API. Bearer-token authenticated only (apiRoute): never a session cookie, never locals.user.
export const GET = apiRoute(ENDPOINTS.listSpaces, async ({ db, caller }) => {
	const spaces = await listSpaces(db, caller.userId);
	const visible = caller.restrictedSpaceId
		? spaces.filter((s) => s.id === caller.restrictedSpaceId)
		: spaces;
	return { data: visible.map(spaceOut) };
});
