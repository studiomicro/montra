import { sql } from 'drizzle-orm';
import type { Db } from '../db';

// The only place a goal's saved amount is computed: the SQL SUM() of its live contributions. No stored
// "saved" column exists, so concurrent contributions can never race or drift (PRD FN-10 Owner decision B).

/** SQL value: the saved amount (minor units) of `goalId` in `spaceId`, 0 without contributions. */
export function savedSumSql(spaceId: string, goalId: string) {
	return sql<number>`(select coalesce(sum(c.amount_minor), 0) from goal_contributions c
		where c.space_id = ${spaceId} and c.goal_id = ${goalId} and c.deleted_at is null)`;
}

/** Saved amount of one goal of this space (0 for an unknown or other-space id: nothing matches). */
export async function goalSavedMinor(db: Db, spaceId: string, goalId: string): Promise<number> {
	const [row] = await db.all<{ saved: number }>(
		sql`select ${savedSumSql(spaceId, goalId)} as saved`
	);
	return row?.saved ?? 0;
}

/**
 * Saved amount of every goal of the space that has live contributions, in one grouped query (goals without
 * any are absent: read them as 0). The space's goal count is capped (MAX_GOALS_PER_SPACE), so is the result.
 */
export async function goalsSavedSums(db: Db, spaceId: string): Promise<Record<string, number>> {
	const rows = await db.all<{ goalId: string; saved: number }>(
		sql`select goal_id as goalId, sum(amount_minor) as saved from goal_contributions
			where space_id = ${spaceId} and deleted_at is null group by goal_id`
	);
	const sums: Record<string, number> = Object.create(null);
	for (const row of rows) sums[row.goalId] = row.saved;
	return sums;
}

/**
 * Whole percent of `targetMinor` saved, rounded down (never overstates; 99.9 % shows 99 %) and not capped at
 * 100 (an over-saved goal reads e.g. 108 %). Exact for any safe-integer inputs (BigInt: `saved × 100` may pass
 * 2^53). Never negative.
 */
export function goalProgressPercent(savedMinor: number, targetMinor: number): number {
	if (!Number.isSafeInteger(savedMinor) || !Number.isSafeInteger(targetMinor) || targetMinor <= 0)
		throw new RangeError('goal amounts must be safe integers with a positive target');
	if (savedMinor <= 0) return 0;
	return Number((BigInt(savedMinor) * 100n) / BigInt(targetMinor));
}

/**
 * What the live goals hold together (Dompet's "disisihkan untuk tujuan"), per currency like every sum: goals are
 * IDR only today, so this is one entry or none. Archived goals are left out; a sum past 2^53 is null.
 */
export function goalsSetAside(
	goals: readonly { savedMinor: number; currency: string; archived: boolean }[]
): { currency: string; savedMinor: number | null }[] {
	const sums = new Map<string, bigint>();
	for (const g of goals)
		if (!g.archived && g.savedMinor > 0)
			sums.set(g.currency, (sums.get(g.currency) ?? 0n) + BigInt(g.savedMinor));
	return [...sums].map(([currency, sum]) => ({
		currency,
		savedMinor: sum > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(sum)
	}));
}
