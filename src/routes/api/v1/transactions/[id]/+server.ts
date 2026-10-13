import { apiRoute, NOT_FOUND } from '#lib/server/api/http';
import { ENDPOINTS } from '#lib/server/api/endpoints';
import { detailOut } from '#lib/server/api/serialize';
import { deleteViaApi, updateViaApi } from '#lib/server/api/transactions';
import { getTransaction } from '#lib/server/transactions/repo';

// FN-38 public API. Bearer-token authenticated only (apiRoute); `space_id` admitted by requireSpaceAccess,
// the transaction id then looked up inside that space only (another space's id is the same 404).

export const GET = apiRoute(ENDPOINTS.getTransaction, async ({ db, access, params }) => {
	const row = await getTransaction(db, access!.space.id, (params.id ?? '').slice(0, 65));
	if (!row) throw NOT_FOUND();
	return { data: detailOut(row) };
});

export const PATCH = apiRoute(
	ENDPOINTS.updateTransaction,
	async ({ db, scope, params, body, now }) => updateViaApi(db, scope!, params.id ?? '', body, now)
);

export const DELETE = apiRoute(
	ENDPOINTS.deleteTransaction,
	async ({ db, scope, params, query, now }) =>
		deleteViaApi(db, scope!, params.id ?? '', Number(query.expected_updated_at), now)
);
