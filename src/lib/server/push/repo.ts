import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { pushSubscriptions } from '../db/schema';
import { newId, sha256Hex } from '../util';
import type { SubscriptionInput } from './validation';

/** Most live subscriptions one user keeps (phones, tablets, browsers); bounds every send loop. */
export const SUBSCRIPTIONS_MAX = 20;

export interface ActiveSubscription {
	id: string;
	userId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent: string | null;
}

/**
 * Stores this browser's subscription for `userId`, bound to the session that posted it (signing that session
 * out tombstones it, session.ts). One statement, so concurrent posts never duplicate or exceed the cap:
 *
 * - a new endpoint is inserted only while the user has fewer than SUBSCRIPTIONS_MAX other live rows (rows
 *   of an ended session do not count);
 * - the same endpoint again (unique) updates its row in place and revives a tombstone;
 * - an endpoint held by another user is taken over only when that row is a tombstone or its session is no
 *   longer live (the browser changed hands); a live foreign row is left alone.
 *
 * Returns false when nothing was written (cap reached, or the endpoint belongs to someone else's live session).
 */
export async function upsertSubscription(
	db: Db,
	who: { userId: string; sessionToken: string },
	input: SubscriptionInput,
	now: number
): Promise<boolean> {
	const tokenHash = await sha256Hex(who.sessionToken);
	const { userId } = who;
	const rows = await db.all<{ id: string }>(sql`
		insert into push_subscriptions
			(id, user_id, session_id, endpoint, p256dh, auth, user_agent, created_at, updated_at, deleted_at)
		select ${newId()}, ${userId},
			(select s.id from sessions s where s.token_hash = ${tokenHash} and s.user_id = ${userId}),
			${input.endpoint}, ${input.p256dh}, ${input.auth}, ${input.userAgent}, ${now}, ${now}, null
		where (select count(*) from push_subscriptions p
			where p.user_id = ${userId} and p.deleted_at is null and p.endpoint <> ${input.endpoint}
				and exists (select 1 from sessions s where s.id = p.session_id
					and s.revoked_at is null and s.expires_at > ${now})) < ${SUBSCRIPTIONS_MAX}
		on conflict (endpoint) do update set
			user_id = excluded.user_id,
			session_id = excluded.session_id,
			p256dh = excluded.p256dh,
			auth = excluded.auth,
			user_agent = excluded.user_agent,
			updated_at = excluded.updated_at,
			deleted_at = null
		where push_subscriptions.user_id = excluded.user_id
			or push_subscriptions.deleted_at is not null
			or not exists (select 1 from sessions s where s.id = push_subscriptions.session_id
				and s.revoked_at is null and s.expires_at > ${now})
		returning id`);
	return rows.length === 1;
}

/** Tombstone columns: the endpoint stays (the upsert key), the keys and device hint go. Also FN-50's passkey removal. */
export const subscriptionTombstone = (now: number) => ({
	deletedAt: now,
	updatedAt: now,
	p256dh: '',
	auth: '',
	userAgent: null
});

/**
 * Tombstones `userId`'s subscription for `endpoint`. Scoped to the user: another user's endpoint matches
 * nothing. Returns whether a live row was removed.
 */
export async function removeSubscription(
	db: Db,
	userId: string,
	endpoint: string,
	now: number
): Promise<boolean> {
	const rows = await db
		.update(pushSubscriptions)
		.set(subscriptionTombstone(now))
		.where(
			and(
				eq(pushSubscriptions.userId, userId),
				eq(pushSubscriptions.endpoint, endpoint),
				isNull(pushSubscriptions.deletedAt)
			)
		)
		.returning({ id: pushSubscriptions.id });
	return rows.length > 0;
}

/** The statement that tombstones every live subscription made under the session of `tokenHash` (sign-out). */
export function removeSessionSubscriptions(db: Db, tokenHash: string, now: number) {
	return db
		.update(pushSubscriptions)
		.set(subscriptionTombstone(now))
		.where(
			and(
				isNull(pushSubscriptions.deletedAt),
				sql`${pushSubscriptions.sessionId} = (select id from sessions where token_hash = ${tokenHash})`
			)
		);
}

/**
 * The statement that tombstones `userId`'s live subscriptions made under any session other than the one of
 * `keepTokenHash`, only while `guard` holds (a password change signing the other devices out, FN-21).
 */
export function removeOtherSessionSubscriptions(
	db: Db,
	userId: string,
	keepTokenHash: string,
	guard: SQL,
	now: number
) {
	return db
		.update(pushSubscriptions)
		.set(subscriptionTombstone(now))
		.where(
			and(
				eq(pushSubscriptions.userId, userId),
				isNull(pushSubscriptions.deletedAt),
				sql`${pushSubscriptions.sessionId} is not null`,
				sql`${pushSubscriptions.sessionId} is not (select id from sessions where token_hash = ${keepTokenHash})`,
				guard
			)
		);
}

/** True when the subscription's session is still live (not revoked, not expired) at `now`. */
const sessionLive = (now: number) =>
	sql`exists (select 1 from sessions s where s.id = ${pushSubscriptions.sessionId}
		and s.revoked_at is null and s.expires_at > ${now})`;

/**
 * `userId`'s live subscriptions, oldest first, at most SUBSCRIPTIONS_MAX: only rows whose session is still
 * live. A session that ended without sign-out (expired, or revoked elsewhere) no longer receives anything;
 * its rows are tombstoned here in the same batch (opportunistic prune), so they also stop counting toward
 * the cap.
 */
export async function listActiveSubscriptions(
	db: Db,
	userId: string,
	now: number
): Promise<ActiveSubscription[]> {
	const live = and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.deletedAt));
	const [, rows] = await db.batch([
		db
			.update(pushSubscriptions)
			.set(subscriptionTombstone(now))
			.where(and(live, sql`not ${sessionLive(now)}`)),
		db
			.select({
				id: pushSubscriptions.id,
				userId: pushSubscriptions.userId,
				endpoint: pushSubscriptions.endpoint,
				p256dh: pushSubscriptions.p256dh,
				auth: pushSubscriptions.auth,
				userAgent: pushSubscriptions.userAgent
			})
			.from(pushSubscriptions)
			.where(and(live, sessionLive(now)))
			.orderBy(pushSubscriptions.createdAt, pushSubscriptions.id)
			.limit(SUBSCRIPTIONS_MAX)
	]);
	return rows;
}
