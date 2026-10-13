import type { Db } from '#lib/server/db';
import { D1_STATEMENTS_PER_INVOCATION } from '#lib/server/db/statement-count';
import { readPriceBook, refreshPrices, type FetchLike } from '#lib/server/net-worth/prices';
import { pricingDemand } from '#lib/server/net-worth/repo';
import { writeSnapshots } from '#lib/server/net-worth/summary';

/**
 * The net-worth part of the hourly cron tick (FN-25), run last in the scheduled invocation: refresh the cached
 * prices the live items need, then write today's (WIB) snapshot for as many due spaces as what is left of D1's
 * per-invocation cap allows (`statementsUsed`: every statement the invocation prepared so far, this work
 * included). Never throws: failures are logged as counts and reasons only (no response bodies, no item
 * content), and the next tick tries again.
 */
export async function runNetWorthTick(
	db: Db,
	kv: KVNamespace,
	fetchFn: FetchLike,
	now: number,
	statementsUsed: () => number
): Promise<void> {
	try {
		const prices = await refreshPrices(kv, await pricingDemand(db), fetchFn, now);
		const snapshots = await writeSnapshots(
			db,
			await readPriceBook(kv, now),
			now,
			() => D1_STATEMENTS_PER_INVOCATION - statementsUsed()
		);
		console.log('jobs: net worth', { prices, snapshots });
	} catch (e) {
		console.error('jobs: net worth tick failed', { error: String(e).slice(0, 200) });
	}
}
