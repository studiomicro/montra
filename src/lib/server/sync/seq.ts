import { sql } from 'drizzle-orm';
import type { Db } from '../db';
import { spaceSeq } from '../db/schema';

/**
 * The batch item that advances `spaceId`'s change counter by one (created at 1). Put it first in the same
 * `db.batch` as the write, which stamps its rows with `currentSpaceSeq(spaceId)`: D1 runs a batch as one
 * transaction, so concurrent writers never share a value. A write that ends up changing nothing leaves a gap,
 * which a `seq > cursor` pull does not mind.
 */
export function bumpSpaceSeq(db: Db, spaceId: string) {
	return db
		.insert(spaceSeq)
		.values({ spaceId, seq: 1 })
		.onConflictDoUpdate({ target: spaceSeq.spaceId, set: { seq: sql`${spaceSeq.seq} + 1` } });
}

/** SQL value: the counter `bumpSpaceSeq` just advanced (for `seq` columns and guards in the same batch). */
export function currentSpaceSeq(spaceId: string) {
	return sql<number>`(select seq from space_seq where space_id = ${spaceId})`;
}
