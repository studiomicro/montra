import { sql } from 'drizzle-orm';
import type { LedgerReason } from '#lib/shared/billing/credits';
import { monthOf, monthRange, wibDateString, wibDayRangeUtcMs } from '#lib/shared/dates';
import type { Db } from '../db';

/** Ledger rows per page of /pengaturan/paket (newest first). */
export const LEDGER_PAGE_SIZE = 20;

export interface LedgerRow {
	id: string;
	delta: number;
	reason: LedgerReason;
	createdAt: number;
	/** The balance right after this row (SUM of this and every earlier row), for the history's context. */
	balanceAfter: number;
}

/** Position in the newest-first history: list what is older than this row. */
export interface LedgerCursor {
	createdAt: number;
	id: string;
}

const CURSOR = /^(\d{1,15})_([0-9a-f-]{1,64})$/;

/** `?sebelum=<createdAt>_<id>` → a cursor, or null when absent or malformed (then page 1). */
export function parseLedgerCursor(value: string | null): LedgerCursor | null {
	const m = value ? CURSOR.exec(value) : null;
	return m ? { createdAt: Number(m[1]), id: m[2] as string } : null;
}

export const ledgerCursorParam = (row: LedgerRow) => `${row.createdAt}_${row.id}`;

/**
 * One page of `userId`'s own ledger (always `locals.user.id`), newest first, with the running balance after
 * each row (a window SUM in SQL over this user's rows only), and whether older rows exist.
 */
export async function listLedger(
	db: Db,
	userId: string,
	cursor: LedgerCursor | null,
	limit = LEDGER_PAGE_SIZE
): Promise<{ rows: LedgerRow[]; more: boolean }> {
	const rows = await db.all<LedgerRow>(
		sql`select id, delta, reason, created_at as createdAt, balance_after as balanceAfter from (
			select id, delta, reason, created_at,
				sum(delta) over (order by created_at, id rows between unbounded preceding and current row)
					as balance_after
			from credit_ledger where user_id = ${userId}
		) where ${
			cursor
				? sql`(created_at < ${cursor.createdAt} or (created_at = ${cursor.createdAt} and id < ${cursor.id}))`
				: sql`1`
		}
		order by created_at desc, id desc limit ${limit + 1}`
	);
	// `reason` is one of LEDGER_REASONS: the table's CHECK allows nothing else.
	return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** The UTC instants bounding the WIB calendar month that contains `now`: `startMs` inclusive, `endMs` exclusive. */
export function wibMonthRangeUtcMs(now: number): { startMs: number; endMs: number } {
	const { from, to } = monthRange(monthOf(wibDateString(now)));
	return { startMs: wibDayRangeUtcMs(from).startMs, endMs: wibDayRangeUtcMs(to).endMs };
}

/**
 * Credits `userId` spent in the WIB calendar month that contains `now` (FN-42 "Pemakaian"): the sum of that
 * user's negative ledger rows created in the month, as a positive count; one indexed aggregate in SQL, never a
 * stored counter. Months are WIB, never UTC: 23:30 WIB on the last day still belongs to that month.
 */
export async function creditsSpentThisMonth(db: Db, userId: string, now: number): Promise<number> {
	const { startMs, endMs } = wibMonthRangeUtcMs(now);
	const [row] = await db.all<{ spent: number }>(
		sql`select coalesce(-sum(delta), 0) as spent from credit_ledger
			where user_id = ${userId} and delta < 0 and created_at >= ${startMs} and created_at < ${endMs}`
	);
	const spent = row?.spent ?? 0;
	if (!Number.isSafeInteger(spent)) throw new RangeError('credit sum overflow');
	return spent;
}
