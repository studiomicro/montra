import { sql } from 'drizzle-orm';
import { DAY_MS } from '#lib/shared/billing/plans';
import type { Db } from '../db';

/**
 * Retention of re-claim markers (FN-30 hardening, billing/claims.ts): kept 730 days after the deletion that wrote
 * them, then deleted by the jobs Worker's cron, oldest first and at most CLAIM_SWEEP_BATCH per call. Kept apart
 * from claims.ts so the jobs Worker needs neither CLAIM_HASH_KEY nor the key parsing.
 */
export const CLAIM_MARKER_RETENTION_MS = 730 * DAY_MS;
/** Most markers one sweep call deletes. */
export const CLAIM_SWEEP_BATCH = 500;

/** Deletes markers older than CLAIM_MARKER_RETENTION_MS, at most CLAIM_SWEEP_BATCH; answers how many. */
export async function sweepClaimMarkers(db: Db, now: number): Promise<number> {
	const removed = await db.all<{ n: number }>(
		sql`delete from claim_markers where rowid in (select rowid from claim_markers
			where created_at < ${now - CLAIM_MARKER_RETENTION_MS} order by created_at limit ${CLAIM_SWEEP_BATCH})
			returning 1 as n`
	);
	return removed.length;
}
