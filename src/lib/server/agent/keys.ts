import { and, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { agentRuns, fileDeletions } from '../db/schema';

/**
 * Batch items (FN-23), placed before the write that stops holding the keys ("Hapus", expiry, space purge, account
 * delete): the CSV and HTML keys of every `agent_runs` row `where` selects go to the file-deletion outbox, due
 * `now` (photos/store.ts drains it). Kept apart from repo.ts so the space and account purges import nothing else.
 */
export function releaseAgentKeys(db: Db, where: SQL | undefined, now: number) {
	const release = (column: typeof agentRuns.csvKey | typeof agentRuns.htmlKey) =>
		db
			.insert(fileDeletions)
			.select((qb) =>
				qb
					.select({
						key: sql`${column}`.as('key'),
						dueAt: sql`${now}`.as('due_at'),
						attempts: sql`0`.as('attempts')
					})
					.from(agentRuns)
					.where(and(where, isNotNull(column)))
			)
			.onConflictDoNothing()
			.returning({ key: fileDeletions.key });
	return [release(agentRuns.csvKey), release(agentRuns.htmlKey)] as const;
}
