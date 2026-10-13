import { apiRoute } from '#lib/server/api/http';
import { ENDPOINTS } from '#lib/server/api/endpoints';
import { rowOut, totalsOut } from '#lib/server/api/serialize';
import { createViaApi, listFilter } from '#lib/server/api/transactions';
import { listTransactionsByDay, periodTotals } from '#lib/server/transactions/aggregate';
import { wibTodayString } from '#lib/shared/dates';

// FN-38 public API. Bearer-token authenticated only (apiRoute); `space_id` admitted by requireSpaceAccess.

/** Riwayat's list and header total for the same filter: the rows a page shows and the whole filter's totals. */
export const GET = apiRoute(ENDPOINTS.listTransactions, async ({ db, access, query, now }) => {
	const spaceId = access!.space.id;
	const { filter, cursor, limit } = listFilter(query, wibTodayString(now));
	const [page, totals] = await Promise.all([
		listTransactionsByDay(db, spaceId, filter, { cursor, limit }),
		periodTotals(db, spaceId, filter)
	]);
	return {
		data: page.days.flatMap((d) => d.rows.map(rowOut)),
		next_cursor: page.nextCursor,
		totals: totalsOut(totals)
	};
});

export const POST = apiRoute(ENDPOINTS.createTransaction, async ({ db, scope, body, now }) =>
	createViaApi(db, scope!, body, now)
);
