import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
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

/**
 * The batch item that advances by one the change counter of every space holding a row of `table` that matches
 * `where` (each space once, created at 1): for a write that changes rows in several spaces at once. Each row then
 * takes its own space's new value with `currentSpaceSeq(<the row's space_id column>)`.
 */
export function bumpSpaceSeqsWhere(db: Db, table: SQLiteTable, where: SQL) {
	return db
		.insert(spaceSeq)
		.select(sql`select distinct space_id, 1 from ${table} where ${where}`)
		.onConflictDoUpdate({ target: spaceSeq.spaceId, set: { seq: sql`${spaceSeq.seq} + 1` } });
}

/**
 * SQL value: the counter `bumpSpaceSeq` just advanced (for `seq` columns and guards in the same batch). `spaceId`
 * is a value, or SQL naming the row's own `space_id` column after `bumpSpaceSeqsWhere`.
 */
export function currentSpaceSeq(spaceId: string | SQL) {
	return sql<number>`(select seq from space_seq where space_id = ${spaceId})`;
}
