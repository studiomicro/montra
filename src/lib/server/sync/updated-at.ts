import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

// Every write moves a row's `updated_at` strictly forward, even within the same millisecond, so a form loaded with
// the old value ("changed meanwhile") can never match the row again.

/** `updated_at` of a write that expected `expected`: always later, even within the same millisecond. */
export const nextUpdatedAt = (expected: number, now: number): number => Math.max(now, expected + 1);

/** SQL value: the `updated_at` column `column` after this write (nextUpdatedAt of its current value). */
export const bumpedUpdatedAt = (column: SQLiteColumn | SQL, now: number): SQL =>
	sql`max(${now}, ${column} + 1)`;
