import { and, desc, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import { PASSKEY_MAX_PER_USER, type PasskeyTransport } from '#lib/shared/passkeys';
import type { Db } from '../db';
import {
	authEvents,
	passkeyChallenges,
	passkeySessions,
	passkeys,
	pushSubscriptions,
	sessions
} from '../db/schema';
import { subscriptionTombstone } from '../push/repo';
import { newId, sha256Hex } from '../util';
import type { VerifiedCredential } from './webauthn-verify';

/**
 * FN-50 passkey rows: list, guarded insert, guarded soft-delete, sweep. Every statement names the user the
 * session resolved (never an id from the form); a passkey of another user and an unknown id get the same answer.
 * The public key leaves this module only for the verify path (`findLivePasskey`), never for a page.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long `auth_events` rows are kept (Owner decision 11). */
export const AUTH_EVENT_RETENTION_MS = 90 * DAY_MS;
/** Most `auth_events` rows one sweep call deletes. */
export const AUTH_EVENT_SWEEP_BATCH = 500;

/** What the management page shows: never the public key or the credential id. */
export interface PasskeySummary {
	id: string;
	name: string;
	rpId: string;
	transports: PasskeyTransport[];
	backedUp: boolean;
	createdAt: number;
	lastUsedAt: number | null;
}

/** The user's live passkeys, newest first, bounded by the per-user cap. */
export async function listPasskeys(db: Db, userId: string): Promise<PasskeySummary[]> {
	const rows = await db
		.select({
			id: passkeys.id,
			name: passkeys.name,
			rpId: passkeys.rpId,
			transports: passkeys.transports,
			backedUp: passkeys.backedUp,
			createdAt: passkeys.createdAt,
			lastUsedAt: passkeys.lastUsedAt
		})
		.from(passkeys)
		.where(and(eq(passkeys.userId, userId), isNull(passkeys.deletedAt)))
		.orderBy(desc(passkeys.createdAt), desc(passkeys.id))
		.limit(PASSKEY_MAX_PER_USER + 1);
	return rows.map((r) => ({
		...r,
		transports: parseTransports(r.transports),
		backedUp: r.backedUp === 1
	}));
}

function parseTransports(text: string): PasskeyTransport[] {
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed)
			? (parsed.filter((t) => typeof t === 'string') as PasskeyTransport[])
			: [];
	} catch {
		return [];
	}
}

/** The credential ids of the user's live passkeys (the `excludeCredentials` of a registration). */
export async function liveCredentialIds(db: Db, userId: string): Promise<string[]> {
	const rows = await db
		.select({ credentialId: passkeys.credentialId })
		.from(passkeys)
		.where(and(eq(passkeys.userId, userId), isNull(passkeys.deletedAt)))
		.limit(PASSKEY_MAX_PER_USER + 1);
	return rows.map((r) => r.credentialId);
}

/** How many live passkeys the user holds. */
export async function countLivePasskeys(db: Db, userId: string): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(passkeys)
		.where(and(eq(passkeys.userId, userId), isNull(passkeys.deletedAt)))
		.get();
	return row?.n ?? 0;
}

/** The live passkey of `credentialId` registered for `rpId`, with what the verify path needs. */
export async function findLivePasskey(db: Db, credentialId: string, rpId: string) {
	return db
		.select({
			id: passkeys.id,
			userId: passkeys.userId,
			publicKey: passkeys.publicKey,
			algorithm: passkeys.algorithm,
			counter: passkeys.counter
		})
		.from(passkeys)
		.where(
			and(
				eq(passkeys.credentialId, credentialId),
				eq(passkeys.rpId, rpId),
				isNull(passkeys.deletedAt)
			)
		)
		.get();
}

export interface NewPasskey {
	credential: VerifiedCredential;
	name: string;
	rpId: string;
	transports: PasskeyTransport[];
	/** The `register` challenge row the response answered. */
	challengeId: string;
}

/**
 * Writes a verified registration in one `db.batch`: the challenge is consumed (`used_at is null and expires_at >
 * now`, kind `register`, issued to this user), the row is inserted only while that consume happened here and the
 * user holds fewer than PASSKEY_MAX_PER_USER live passkeys (so 20 concurrent registrations never pass the cap),
 * and a `passkey_added` event follows only when the row was written. The partial unique index refuses a credential
 * id that is already live; that surfaces as a thrown UNIQUE error the caller answers as a refusal.
 * Returns the new row id, or null when refused.
 */
export async function insertPasskey(
	db: Db,
	userId: string,
	input: NewPasskey,
	now: number
): Promise<string | null> {
	const id = newId();
	// "This request consumed the challenge": `used_by` is the new row's own id, set by the first statement only.
	const consumed = sql`exists (select 1 from ${passkeyChallenges} where ${passkeyChallenges.id} = ${input.challengeId}
		and ${passkeyChallenges.usedBy} = ${id})`;
	const underCap = sql`(select count(*) from ${passkeys} p where p.user_id = ${userId} and p.deleted_at is null) < ${PASSKEY_MAX_PER_USER}`;
	const written = sql`exists (select 1 from ${passkeys} where ${passkeys.id} = ${id})`;
	const results = await db.batch([
		db
			.update(passkeyChallenges)
			.set({ usedAt: now, usedBy: id })
			.where(
				and(
					eq(passkeyChallenges.id, input.challengeId),
					eq(passkeyChallenges.kind, 'register'),
					eq(passkeyChallenges.userId, userId),
					isNull(passkeyChallenges.usedAt),
					sql`${passkeyChallenges.expiresAt} > ${now}`
				)
			),
		db
			.insert(passkeys)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						userId: sql`${userId}`.as('user_id'),
						credentialId: sql`${input.credential.credentialId}`.as('credential_id'),
						publicKey: sql`${input.credential.publicKey}`.as('public_key'),
						algorithm: sql`${input.credential.algorithm}`.as('algorithm'),
						counter: sql`${input.credential.counter}`.as('counter'),
						transports: sql`${JSON.stringify(input.transports)}`.as('transports'),
						aaguid: sql`${input.credential.aaguid}`.as('aaguid'),
						name: sql`${input.name}`.as('name'),
						rpId: sql`${input.rpId}`.as('rp_id'),
						backedUp: sql`${input.credential.backedUp ? 1 : 0}`.as('backed_up'),
						createdAt: sql`${now}`.as('created_at'),
						lastUsedAt: sql`null`.as('last_used_at'),
						updatedAt: sql`${now}`.as('updated_at'),
						deletedAt: sql`null`.as('deleted_at')
					})
					.from(sql`(select 1)`)
					.where(and(consumed, underCap))
			)
			.returning({ id: passkeys.id }),
		db.insert(authEvents).select((qb) =>
			qb
				.select({
					id: sql`${newId()}`.as('id'),
					userId: sql`${userId}`.as('user_id'),
					kind: sql`'passkey_added'`.as('kind'),
					passkeyId: sql`${id}`.as('passkey_id'),
					createdAt: sql`${now}`.as('created_at')
				})
				.from(sql`(select 1)`)
				.where(written)
		)
	]);
	return (results[1] as { id: string }[]).length ? id : null;
}

/**
 * Soft-deletes the user's passkey `passkeyId` and, in the same batch, revokes every session that passkey created
 * other than the one of `keepToken` (Owner decision 10; the push subscriptions of those sessions are tombstoned
 * too), then records `passkey_removed`. An id of another user or an unknown id changes nothing (same answer).
 */
export async function removePasskey(
	db: Db,
	userId: string,
	passkeyId: string,
	keepToken: string,
	now: number
): Promise<boolean> {
	const keepTokenHash = await sha256Hex(keepToken);
	const removed = sql`exists (select 1 from ${passkeys} where ${passkeys.id} = ${passkeyId}
		and ${passkeys.userId} = ${userId} and ${passkeys.deletedAt} = ${now})`;
	const revokedSessions = and(
		eq(sessions.userId, userId),
		sql`${sessions.id} in (select ${passkeySessions.sessionId} from ${passkeySessions}
			where ${passkeySessions.passkeyId} = ${passkeyId} and ${passkeySessions.userId} = ${userId})`,
		ne(sessions.tokenHash, keepTokenHash),
		isNull(sessions.revokedAt),
		removed
	);
	const [tombstoned] = await db.batch([
		db
			.update(passkeys)
			.set({ deletedAt: now, updatedAt: now })
			.where(
				and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId), isNull(passkeys.deletedAt))
			)
			.returning({ id: passkeys.id }),
		db
			.update(pushSubscriptions)
			.set(subscriptionTombstone(now))
			.where(
				and(
					eq(pushSubscriptions.userId, userId),
					isNull(pushSubscriptions.deletedAt),
					sql`${pushSubscriptions.sessionId} in (select ${sessions.id} from ${sessions} where ${revokedSessions})`
				)
			),
		db.update(sessions).set({ revokedAt: now }).where(revokedSessions),
		db.insert(authEvents).select((qb) =>
			qb
				.select({
					id: sql`${newId()}`.as('id'),
					userId: sql`${userId}`.as('user_id'),
					kind: sql`'passkey_removed'`.as('kind'),
					passkeyId: sql`${passkeyId}`.as('passkey_id'),
					createdAt: sql`${now}`.as('created_at')
				})
				.from(sql`(select 1)`)
				.where(removed)
		)
	]);
	return tombstoned.length === 1;
}

/** Records a refused assertion or a counter rollback for a known credential (content-free). */
export async function recordAuthEvent(
	db: Db,
	userId: string,
	kind: 'passkey_refused' | 'passkey_counter_rollback',
	passkeyId: string,
	now: number
): Promise<void> {
	await db.insert(authEvents).values({ id: newId(), userId, kind, passkeyId, createdAt: now });
}

/** Deletes `auth_events` older than AUTH_EVENT_RETENTION_MS, at most AUTH_EVENT_SWEEP_BATCH; answers how many. */
export async function sweepAuthEvents(db: Db, now: number): Promise<number> {
	const removed = await db.all<{ n: number }>(
		sql`delete from auth_events where rowid in (select rowid from auth_events
			where created_at < ${now - AUTH_EVENT_RETENTION_MS} order by created_at limit ${AUTH_EVENT_SWEEP_BATCH})
			returning 1 as n`
	);
	return removed.length;
}

/** The sweep of expired challenges that rides along with an insert: rows expired for over an hour go. */
export function sweepExpiredChallenges(db: Db, now: number) {
	return db.delete(passkeyChallenges).where(lt(passkeyChallenges.expiresAt, now - 60 * 60 * 1000));
}
