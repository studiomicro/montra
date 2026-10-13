import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { auditEvents, spaces, type AuditAction } from '../db/schema';
import { newId } from '../util';

export interface AuditEvent {
	spaceId: string;
	actorUserId: string;
	action: AuditAction;
	targetUserId?: string | null;
}

/**
 * One `audit_events` row as a `db.batch` item: put it in the same batch as the change it records so the two
 * never disagree. The row is written only while the space row exists (it may be inserted earlier in the same
 * batch) and, with `guard`, only when that SQL condition holds; pass the same condition as the guarded change
 * and place this item before it. Nothing reads the table yet (FN-03, owner decision E).
 */
export function recordAuditEvent(db: Db, event: AuditEvent, now: number, guard?: SQL) {
	return db.insert(auditEvents).select((qb) =>
		qb
			.select({
				id: sql`${newId()}`.as('id'),
				spaceId: spaces.id,
				actorUserId: sql`${event.actorUserId}`.as('actor_user_id'),
				action: sql`${event.action}`.as('action'),
				targetUserId: sql`${event.targetUserId ?? null}`.as('target_user_id'),
				createdAt: sql`${now}`.as('created_at')
			})
			.from(spaces)
			.where(guard ? and(eq(spaces.id, event.spaceId), guard) : eq(spaces.id, event.spaceId))
	);
}
