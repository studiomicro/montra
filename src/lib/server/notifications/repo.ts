import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
	CLOSE_REMINDER_DEFAULT_HOUR,
	isSpaceKind,
	NOTIFICATION_KINDS,
	prefsFrom,
	type NotificationKind,
	type NotificationParams
} from '#lib/shared/notifications';
import type { Db } from '../db';
import {
	notificationDeliveries,
	notificationPrefs,
	spaceNotifications,
	userNotifications
} from '../db/schema';
import { isLiveMember } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';

/** Notifications shown on the list (newest first); older ones stay stored but are not listed. */
const NOTIFICATION_LIST_LIMIT = 50;
/** The unread badge counts up to this many ("99+" beyond). */
const UNREAD_COUNT_CAP = 100;
/** A delivery claim older than this was left by a crashed attempt and may be taken over. */
export const DELIVERY_CLAIM_STALE_MS = 5 * 60 * 1000;

export interface NewNotification {
	userId: string;
	kind: NotificationKind;
	/** Set for space kinds (budget, goal); null for user kinds (nudge, weekly). */
	spaceId: string | null;
	dataKey: string;
	params: NotificationParams;
	/** Extra SQL condition the insert must also meet (e.g. "no transaction today"), checked in the statement. */
	guard?: SQL;
}

/** The notification of this (user, kind, key): `created` false when it already existed. */
export interface CreateResult {
	id: string;
	created: boolean;
}

async function existingId(db: Db, n: NewNotification): Promise<string | null> {
	const table = n.spaceId === null ? userNotifications : spaceNotifications;
	const row = await db
		.select({ id: table.id })
		.from(table)
		.where(
			and(eq(table.userId, n.userId), sql`${table.kind} = ${n.kind}`, eq(table.dataKey, n.dataKey))
		)
		.get();
	return row?.id ?? null;
}

/**
 * The one guarded insert every trigger calls. A notification for (user, kind, data key) is created at most
 * once, ever: a replayed queue message, a repeated cron tick or 20 concurrent calls leave exactly one row (the
 * unique index, no `deleted_at` condition, so a dismissed one never comes back). In the same statement: the
 * recipient is an active account, has not turned the kind off (preferences are checked before creation, never
 * after) and, for a space kind, is still a live member of the live space.
 *
 * Returns the row (`created` says whether this call made it), or null when the guard refused it.
 */
export async function createIfAbsent(
	db: Db,
	n: NewNotification,
	now: number
): Promise<CreateResult | null> {
	if (isSpaceKind(n.kind) !== (n.spaceId !== null))
		throw new Error('notification kind/space mismatch');
	const found = await existingId(db, n);
	if (found) return { id: found, created: false };

	const id = newId();
	const params = JSON.stringify(n.params);
	const allowed = sql`exists (select 1 from users u where u.id = ${n.userId} and u.status = 'active')
		and not exists (select 1 from notification_prefs p where p.user_id = ${n.userId}
			and p.kind = ${n.kind} and p.enabled = 0)
		and ${n.guard ?? sql`1`}`;
	let inserted: { id: string }[];
	if (n.spaceId === null) {
		inserted = await db
			.insert(userNotifications)
			.select(
				sql`select ${id}, ${n.userId}, ${n.kind}, ${n.dataKey}, ${params}, null, ${now}, ${now}, null
					where ${allowed}`
			)
			.onConflictDoNothing()
			.returning({ id: userNotifications.id });
	} else {
		const spaceId = n.spaceId;
		[, inserted] = await db.batch([
			bumpSpaceSeq(db, spaceId),
			db
				.insert(spaceNotifications)
				.select(
					sql`select ${id}, ${spaceId}, ${n.userId}, ${n.kind}, ${n.dataKey}, ${params}, null, ${now},
						${now}, null, ${currentSpaceSeq(spaceId)}
					where ${allowed} and ${isLiveMember(spaceId, n.userId)}`
				)
				.onConflictDoNothing()
				.returning({ id: spaceNotifications.id })
		]);
	}
	if (inserted.length === 1) return { id, created: true };
	// Lost a race to a concurrent insert of the same key, or refused by the guard.
	const winner = await existingId(db, n);
	return winner ? { id: winner, created: false } : null;
}

export interface NotificationRow {
	id: string;
	kind: NotificationKind;
	params: string;
	readAt: number | null;
	createdAt: number;
	/** The space of a space kind; null for a user kind. */
	space: { id: string; kind: 'personal' | 'shared'; name: string } | null;
}

interface ListRow {
	id: string;
	kind: NotificationKind;
	params: string;
	readAt: number | null;
	createdAt: number;
	spaceId: string | null;
	spaceKind: 'personal' | 'shared' | null;
	spaceName: string | null;
}

/** SQL condition on `space_notifications n`: `userId` is still a live member of the row's live space. */
const stillMember = (userId: string) => sql`exists (select 1 from space_members m
	join spaces s on s.id = m.space_id
	where m.space_id = n.space_id and m.user_id = ${userId} and m.deleted_at is null and s.deleted_at is null)`;

/**
 * `userId`'s live notifications, newest first, at most `limit`. Space rows only while the user is still a live
 * member of that live space (re-checked on every read, never a cached list): a removed member sees nothing
 * more from it. Each branch is bounded before the merge.
 */
export async function listNotifications(
	db: Db,
	userId: string,
	opts: { limit?: number } = {}
): Promise<NotificationRow[]> {
	const limit = Math.min(
		Math.max(opts.limit ?? NOTIFICATION_LIST_LIMIT, 1),
		NOTIFICATION_LIST_LIMIT
	);
	const rows = await db.all<ListRow>(sql`select * from (
			select * from (
				select n.id as id, n.kind as kind, n.params as params, n.read_at as readAt,
					n.created_at as createdAt, s.id as spaceId, s.kind as spaceKind, s.name as spaceName
				from space_notifications n join spaces s on s.id = n.space_id
				where n.user_id = ${userId} and n.deleted_at is null and ${stillMember(userId)}
				order by n.created_at desc, n.id desc limit ${limit})
			union all
			select * from (
				select n.id, n.kind, n.params, n.read_at, n.created_at, null, null, null
				from user_notifications n
				where n.user_id = ${userId} and n.deleted_at is null
				order by n.created_at desc, n.id desc limit ${limit})
		) order by createdAt desc, id desc limit ${limit}`);
	return rows.map((r) => ({
		id: r.id,
		kind: r.kind,
		params: r.params,
		readAt: r.readAt,
		createdAt: r.createdAt,
		space:
			r.spaceId && r.spaceKind && r.spaceName !== null
				? { id: r.spaceId, kind: r.spaceKind, name: r.spaceName }
				: null
	}));
}

/** How many of `userId`'s listed notifications are unread, counted up to UNREAD_COUNT_CAP. */
export async function countUnread(db: Db, userId: string): Promise<number> {
	const row = await db.get<{ n: number }>(sql`select
		(select count(*) from (select 1 from space_notifications n
			where n.user_id = ${userId} and n.deleted_at is null and n.read_at is null and ${stillMember(userId)}
			limit ${UNREAD_COUNT_CAP}))
		+ (select count(*) from (select 1 from user_notifications n
			where n.user_id = ${userId} and n.deleted_at is null and n.read_at is null
			limit ${UNREAD_COUNT_CAP})) as n`);
	return Math.min(row?.n ?? 0, UNREAD_COUNT_CAP);
}

/** Which table holds `userId`'s live notification `id` (with its space, kind and figures); null otherwise. */
export type OwnedNotification =
	| { table: 'space'; spaceId: string; kind: NotificationKind; params: string }
	| { table: 'user'; kind: NotificationKind; params: string }
	| null;

export async function findOwned(db: Db, userId: string, id: string): Promise<OwnedNotification> {
	const row = await db.get<{ spaceId: string | null; kind: NotificationKind; params: string }>(sql`
		select n.space_id as spaceId, n.kind as kind, n.params as params from space_notifications n
			where n.id = ${id} and n.user_id = ${userId} and n.deleted_at is null
		union all
		select null, n.kind, n.params from user_notifications n
			where n.id = ${id} and n.user_id = ${userId} and n.deleted_at is null
		limit 1`);
	if (!row) return null;
	const { kind, params } = row;
	return row.spaceId === null
		? { table: 'user', kind, params }
		: { table: 'space', spaceId: row.spaceId, kind, params };
}

type Change = 'read' | 'dismiss';

/** Read (`read_at` set once) or dismissed (content-free tombstone: params and read state cleared). */
const changeSet = (change: Change, now: number) =>
	change === 'read'
		? { readAt: sql`coalesce(read_at, ${now})`, updatedAt: now }
		: { deletedAt: now, params: null, readAt: null, updatedAt: now };

/**
 * Marks `userId`'s live notification `id` read or dismisses it. Scoped to the user (and, for a space row, to a
 * live membership) in the statement itself; anything else matches nothing. Returns whether a row changed.
 */
export async function changeNotification(
	db: Db,
	userId: string,
	owned: Exclude<OwnedNotification, null>,
	id: string,
	change: Change,
	now: number
): Promise<boolean> {
	if (owned.table === 'user') {
		const rows = await db
			.update(userNotifications)
			.set(changeSet(change, now))
			.where(
				and(
					eq(userNotifications.id, id),
					eq(userNotifications.userId, userId),
					isNull(userNotifications.deletedAt)
				)
			)
			.returning({ id: userNotifications.id });
		return rows.length === 1;
	}
	const { spaceId } = owned;
	const [, rows] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(spaceNotifications)
			.set({ ...changeSet(change, now), seq: currentSpaceSeq(spaceId) })
			.where(
				and(
					eq(spaceNotifications.id, id),
					eq(spaceNotifications.userId, userId),
					eq(spaceNotifications.spaceId, spaceId),
					isNull(spaceNotifications.deletedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: spaceNotifications.id })
	]);
	return rows.length === 1;
}

// ---- Preferences ----

export async function getNotificationPrefs(
	db: Db,
	userId: string
): Promise<Record<NotificationKind, boolean>> {
	const rows = await db
		.select({ kind: notificationPrefs.kind, enabled: notificationPrefs.enabled })
		.from(notificationPrefs)
		.where(eq(notificationPrefs.userId, userId))
		// At most one row per kind (unique index), so this never cuts a real row.
		.limit(NOTIFICATION_KINDS.length);
	return prefsFrom(rows);
}

/** One upsert on (user_id, kind): concurrent submissions leave exactly one row, the last write applied. */
export async function setNotificationPref(
	db: Db,
	userId: string,
	kind: NotificationKind,
	enabled: boolean,
	now: number
): Promise<void> {
	await db
		.insert(notificationPrefs)
		.values({ id: newId(), userId, kind, enabled, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: [notificationPrefs.userId, notificationPrefs.kind],
			set: { enabled: sql`excluded.enabled`, updatedAt: sql`excluded.updated_at` }
		});
}

/** FN-34b: the WIB hour of `userId`'s evening "belum ditutup" reminder (CLOSE_REMINDER_DEFAULT_HOUR unset). */
export async function getCloseReminderHour(db: Db, userId: string): Promise<number> {
	const row = await db
		.select({ hour: notificationPrefs.hour })
		.from(notificationPrefs)
		.where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.kind, 'close_reminder')))
		.get();
	return row?.hour ?? CLOSE_REMINDER_DEFAULT_HOUR;
}

/**
 * FN-34b: the WIB hour of the evening reminder (already checked against CLOSE_REMINDER_HOURS by the caller; the
 * table's CHECK refuses anything else too). One upsert on (user_id, kind) that changes only the hour: a user
 * without a row keeps the default (on), and the on/off switch (setNotificationPref) keeps the hour.
 */
export async function setCloseReminderHour(
	db: Db,
	userId: string,
	hour: number,
	now: number
): Promise<void> {
	await db
		.insert(notificationPrefs)
		.values({
			id: newId(),
			userId,
			kind: 'close_reminder',
			enabled: true,
			hour,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: [notificationPrefs.userId, notificationPrefs.kind],
			set: { hour: sql`excluded.hour`, updatedAt: sql`excluded.updated_at` }
		});
}

// ---- Push delivery ----

export interface PushTarget {
	userId: string;
	kind: NotificationKind;
	params: string;
	space: { kind: 'personal' | 'shared'; name: string } | null;
}

/**
 * What `send_push` needs for live notification `id`: its recipient and stored figures. Null when it was
 * dismissed, or (space rows) the recipient is no longer a live member of the live space.
 */
export async function pushTarget(db: Db, id: string): Promise<PushTarget | null> {
	const row = await db.get<{
		userId: string;
		kind: NotificationKind;
		params: string;
		spaceKind: 'personal' | 'shared' | null;
		spaceName: string | null;
	}>(sql`
		select n.user_id as userId, n.kind as kind, n.params as params, s.kind as spaceKind, s.name as spaceName
			from space_notifications n join spaces s on s.id = n.space_id
			where n.id = ${id} and n.deleted_at is null and exists (select 1 from space_members m
				where m.space_id = n.space_id and m.user_id = n.user_id and m.deleted_at is null)
				and s.deleted_at is null
		union all
		select n.user_id, n.kind, n.params, null, null from user_notifications n
			where n.id = ${id} and n.deleted_at is null
		limit 1`);
	if (!row) return null;
	return {
		userId: row.userId,
		kind: row.kind,
		params: row.params,
		space:
			row.spaceKind && row.spaceName !== null ? { kind: row.spaceKind, name: row.spaceName } : null
	};
}

/**
 * Claims the push of `notificationId` to `subscriptionId`:
 * - `claimed`: this caller may send it (one statement, so concurrent replays never both send);
 * - `done`: it was already delivered;
 * - `busy`: another attempt holds a fresh claim (it may still fail or have died): the caller retries later.
 * A claim older than DELIVERY_CLAIM_STALE_MS was left by an attempt that died and is taken over.
 */
export async function claimDelivery(
	db: Db,
	d: { notificationId: string; subscriptionId: string; userId: string },
	now: number
): Promise<'claimed' | 'done' | 'busy'> {
	const rows = await db
		.insert(notificationDeliveries)
		.values({ ...d, state: 'sending', updatedAt: now })
		.onConflictDoUpdate({
			target: [notificationDeliveries.notificationId, notificationDeliveries.subscriptionId],
			set: { updatedAt: now },
			setWhere: sql`${notificationDeliveries.state} = 'sending'
				and ${notificationDeliveries.updatedAt} < ${now - DELIVERY_CLAIM_STALE_MS}`
		})
		.returning({ id: notificationDeliveries.notificationId });
	if (rows.length === 1) return 'claimed';
	const row = await db
		.select({ state: notificationDeliveries.state })
		.from(notificationDeliveries)
		.where(
			and(
				eq(notificationDeliveries.notificationId, d.notificationId),
				eq(notificationDeliveries.subscriptionId, d.subscriptionId)
			)
		)
		.get();
	return row?.state === 'done' ? 'done' : 'busy';
}

/** The push service answered (2xx, or 404/410 for a dropped subscription): never send this pair again. */
export async function finishDelivery(
	db: Db,
	d: { notificationId: string; subscriptionId: string },
	now: number
): Promise<void> {
	await db
		.update(notificationDeliveries)
		.set({ state: 'done', updatedAt: now })
		.where(
			and(
				eq(notificationDeliveries.notificationId, d.notificationId),
				eq(notificationDeliveries.subscriptionId, d.subscriptionId)
			)
		);
}

/** The attempt failed: drop the claim so the queue's retry may try this pair again. */
export async function releaseDelivery(
	db: Db,
	d: { notificationId: string; subscriptionId: string }
): Promise<void> {
	await db
		.delete(notificationDeliveries)
		.where(
			and(
				eq(notificationDeliveries.notificationId, d.notificationId),
				eq(notificationDeliveries.subscriptionId, d.subscriptionId),
				eq(notificationDeliveries.state, 'sending')
			)
		);
}
