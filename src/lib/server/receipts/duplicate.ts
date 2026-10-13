import { sql } from 'drizzle-orm';
import { addDays } from '#lib/shared/dates';
import type { Db } from '../db';

/**
 * "Mungkin sudah dicatat" (FN-15): which of a receipt's amounts (each item, and the total) match a live, real
 * IDR expense of the space on the receipt's date ±1 day with the same amount. Only a note on the review screen:
 * nothing is left out. One query, the amounts bound once as JSON (no 100-parameter limit).
 */
export async function possibleReceiptDuplicates(
	db: Db,
	spaceId: string,
	date: string,
	amounts: readonly { key: string; amountMinor: number }[]
): Promise<Set<string>> {
	if (amounts.length === 0) return new Set();
	const json = JSON.stringify(amounts.map((a) => ({ k: a.key, a: a.amountMinor })));
	const found = await db.all<{ k: string }>(sql`select json_extract(j.value, '$.k') as k
		from json_each(${json}) j
		where exists (select 1 from transactions t where t.space_id = ${spaceId} and t.deleted_at is null
			and t.type = 'expense' and t.currency = 'IDR' and t.is_demo = 0
			and t.amount_minor = json_extract(j.value, '$.a')
			and t.occurred_on between ${addDays(date, -1)} and ${addDays(date, 1)})`);
	return new Set(found.map((r) => r.k));
}
