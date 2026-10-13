import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { transactions } from '../db/schema';
import type { StoredPhoto } from '../photos/store';
import type { SpaceScope } from '../spaces/access';
import { createTransaction, MANUAL } from './repo';
import type { TransactionInput } from './validation';

/**
 * FN-02: a form row whose id the device minted (the offline queue's `clientId`, also sent by the enhanced
 * compose form), so a resend after an unanswered first attempt never writes a second row.
 *
 * One guarded insert: `createTransaction` with the id and a `NOT EXISTS (id)` guard inside the same statement,
 * so 20 concurrent resends insert exactly one row and none of them fails on the primary key. When nothing was
 * inserted and a row with this id already exists in *this* space (live or deleted), the first write was
 * applied: `ok`, and the first write stays authoritative — a resend with different fields (a bug or a tampered
 * body) never changes the row, and a deleted row is never recreated. An id taken in another space reads as
 * `gone` (as if the wallet or category went), never as "exists": no oracle across spaces.
 */
export async function createTransactionOnce(
	db: Db,
	scope: SpaceScope,
	clientId: string,
	input: TransactionInput,
	now: number,
	/** FN-15: an uploaded receipt photo the new row keeps; a resend never attaches a second one. */
	photo: StoredPhoto | null = null
): Promise<{ ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' }> {
	const fresh = sql`not exists (select 1 from transactions x where x.id = ${clientId})`;
	const created = await createTransaction(db, scope, input, now, MANUAL, fresh, clientId, photo);
	if (created.ok) return created;
	const existing = await db
		.select({ id: transactions.id })
		.from(transactions)
		.where(and(eq(transactions.id, clientId), eq(transactions.spaceId, scope.spaceId)))
		.get();
	return existing ? { ok: true, id: clientId } : created;
}
