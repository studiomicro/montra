import { apiRoute } from '#lib/server/api/http';
import { ENDPOINTS } from '#lib/server/api/endpoints';
import { budgetOut } from '#lib/server/api/serialize';
import { getActiveBudget } from '#lib/server/budgets/repo';

// FN-38 public API. Bearer-token authenticated only (apiRoute); `space_id` admitted by requireSpaceAccess.
export const GET = apiRoute(ENDPOINTS.getBudget, async ({ db, access }) => ({
	data: budgetOut(await getActiveBudget(db, access!.space.id))
}));
