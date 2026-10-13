import { apiRoute } from '#lib/server/api/http';
import { ENDPOINTS } from '#lib/server/api/endpoints';
import { walletOut } from '#lib/server/api/serialize';
import { listWallets } from '#lib/server/wallets/repo';

// FN-38 public API. Bearer-token authenticated only (apiRoute); `space_id` admitted by requireSpaceAccess.
export const GET = apiRoute(ENDPOINTS.listWallets, async ({ db, access }) => {
	const wallets = await listWallets(db, access!.space.id, { includeArchived: true });
	return { data: wallets.map(walletOut) };
});
