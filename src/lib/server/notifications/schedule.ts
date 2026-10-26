import { sql } from 'drizzle-orm';
import {
	CLOSE_REMINDER_DEFAULT_HOUR,
	closeReminderDataKey,
	type NotificationKind
} from '#lib/shared/notifications';
import type { Db } from '../db';
import { notificationDeliveries, spaceNotifications, userNotifications } from '../db/schema';

// Keyset pages for the jobs cron (FN-24): each page is one bounded, indexed query; the cron walks pages with
// the last id as the cursor and never loads every space or user at once.

/** Rows per page (also the most messages one `sendBatch` call takes). */
export const SCHEDULE_PAGE_SIZE = 100;

/** Live spaces with a live budget, by id, after `afterId`. */
export async function spacesWithBudget(db: Db, afterId: string, limit: number): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`select b.space_id as id from budgets b
		join spaces s on s.id = b.space_id
		where b.deleted_at is null and s.deleted_at is null and b.space_id > ${afterId}
		order by b.space_id limit ${limit}`);
	return rows.map((r) => r.id);
}

/** Live spaces with at least one live, real subscription (FN-26 bill reminders), by id, after `afterId`. */
export async function spacesWithSubscriptions(
	db: Db,
	afterId: string,
	limit: number
): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`select s.id as id from spaces s
		where s.deleted_at is null and s.id > ${afterId}
			and exists (select 1 from subscriptions x where x.space_id = s.id and x.deleted_at is null
				and x.is_demo = 0)
		order by s.id limit ${limit}`);
	return rows.map((r) => r.id);
}

/** Active accounts that have not turned `kind` off, by id, after `afterId`. */
export async function usersWanting(
	db: Db,
	kind: NotificationKind,
	afterId: string,
	limit: number
): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`select u.id as id from users u
		where u.status = 'active' and u.id > ${afterId}
			and not exists (select 1 from notification_prefs p where p.user_id = u.id and p.kind = ${kind}
				and p.enabled = 0)
		order by u.id limit ${limit}`);
	return rows.map((r) => r.id);
}

/**
 * FN-34b red team L1: only the active accounts whose evening reminder for the WIB `date` is due at WIB `hour` and
 * still missing (reminder on, chosen hour reached, day not closed, not reminded yet), by id, after `afterId`. The
 * handler re-checks all of it inside its guarded insert; this keeps the hourly rotation to the users it can help.
 */
export async function usersDueCloseReminder(
	db: Db,
	date: string,
	hour: number,
	afterId: string,
	limit: number
): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`select u.id as id from users u
		where u.status = 'active' and u.id > ${afterId}
			and not exists (select 1 from notification_prefs p where p.user_id = u.id and p.kind = 'close_reminder'
				and p.enabled = 0)
			and coalesce((select p.hour from notification_prefs p where p.user_id = u.id
				and p.kind = 'close_reminder'), ${CLOSE_REMINDER_DEFAULT_HOUR}) <= ${hour}
			and not exists (select 1 from day_closures d where d.user_id = u.id and d.closed_on = ${date})
			and not exists (select 1 from user_notifications n where n.user_id = u.id and n.kind = 'close_reminder'
				and n.data_key = ${closeReminderDataKey(date)})
		order by u.id limit ${limit}`);
	return rows.map((r) => r.id);
}

/** The jobs cron's stored walk position for `key` (`app_meta`, one row per walk), or null. */
export async function getCronCursor(db: Db, key: string): Promise<string | null> {
	const row = await db.get<{ value: string }>(sql`select value from app_meta where key = ${key}`);
	return row?.value ?? null;
}

/** Stores the walk position (overwritten in place, so the rows never pile up). */
export async function setCronCursor(db: Db, key: string, value: string, now: number) {
	await db.run(sql`insert into app_meta (key, value, updated_at) values (${key}, ${value}, ${now})
		on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`);
}

/** Notifications and push-delivery records older than this are removed (owner decision 7, red team L4). */
const NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Rows each sweep statement handles per tick; the hourly cron works through a backlog in steps. */
export const SWEEP_BATCH = 500;

/**
 * The retention sweep, run on every cron tick in one `db.batch` of bounded statements (at most SWEEP_BATCH rows
 * each, oldest first by index):
 * - user notifications older than NOTIFICATION_RETENTION_MS are deleted; so are budget alerts (their keys name a
 *   past day, week or month, so no trigger can ever ask for them again);
 * - goal milestones of that age become content-free tombstones instead: the row keeps its key, so a goal that
 *   drops and re-crosses later is still never announced twice;
 * - live space notifications of a recipient who is no longer a live member of the live space (left, removed)
 *   become content-free tombstones: the space's figures do not outlive the membership;
 * - push-delivery records older than the retention period are deleted.
 * Space notifications are not part of any sync pull yet (FN-02), so these writes stamp no `seq`.
 */
export async function sweepNotifications(db: Db, now: number): Promise<void> {
	const cutoff = now - NOTIFICATION_RETENTION_MS;
	const tombstone = { deletedAt: now, params: null, readAt: null, updatedAt: now };
	await db.batch([
		db.delete(userNotifications).where(sql`id in (select id from user_notifications
			where created_at < ${cutoff} order by created_at limit ${SWEEP_BATCH})`),
		db.delete(spaceNotifications).where(sql`id in (select id from space_notifications
			where created_at < ${cutoff} and kind <> 'goal_milestone' order by created_at limit ${SWEEP_BATCH})`),
		db.update(spaceNotifications).set(tombstone).where(sql`id in (select id from space_notifications
			where created_at < ${cutoff} and kind = 'goal_milestone' and deleted_at is null
			order by created_at limit ${SWEEP_BATCH})`),
		db.update(spaceNotifications).set(tombstone)
			.where(sql`id in (select n.id from space_notifications n
			where n.deleted_at is null and not exists (select 1 from space_members m
				join spaces s on s.id = m.space_id
				where m.space_id = n.space_id and m.user_id = n.user_id and m.deleted_at is null
					and s.deleted_at is null)
			limit ${SWEEP_BATCH})`),
		db.delete(notificationDeliveries).where(sql`rowid in (select rowid from notification_deliveries
			where updated_at < ${cutoff} order by updated_at limit ${SWEEP_BATCH})`)
	]);
}
