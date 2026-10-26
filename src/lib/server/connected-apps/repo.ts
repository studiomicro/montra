import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
	CONNECTED_APP_PROVIDERS,
	type ConnectedAppProvider,
	type ConnectionView
} from '#lib/shared/connected-apps/providers';
import type { Db } from '../db';
import { auditEvents, connectedApps } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { recordAuditEvent } from '../spaces/audit';
import { bumpSpaceSeq, bumpSpaceSeqsWhere, currentSpaceSeq } from '../sync/seq';
import { isUniqueViolation, newId } from '../util';
import { encryptToken, type ConnectedAppsKeyEnv } from './crypto';

// Every function here runs only after `requireSpaceAccess` admitted `scope.userId` to `scope.spaceId`; each write
// repeats that membership (`isLiveMember`) inside its own statements and writes its audit event in the same
// `db.batch` under the same condition, so a connection never changes without exactly one audit row. Ids from a
// form are only looked up inside the space: another space's id reads as missing. Token columns are never
// selected here for a page.

/** SQL condition: `userId` made the connection row `c` or is the live owner of its space (red team L3). */
const mayDisconnect = (userId: string) =>
	sql`(c.created_by_user_id = ${userId} or exists (select 1 from space_members o
		where o.space_id = c.space_id and o.user_id = ${userId} and o.role = 'owner' and o.deleted_at is null))`;

/** The space's live connections (at most one per provider), without any token material. */
export async function listConnections(db: Db, scope: SpaceScope): Promise<ConnectionView[]> {
	const rows = await db.all<{
		id: string;
		provider: ConnectionView['provider'];
		externalLabel: string | null;
		isDemo: number;
		updatedAt: number;
		canDisconnect: number;
	}>(sql`select c.id, c.provider, c.external_label as externalLabel, c.is_demo as isDemo,
			c.updated_at as updatedAt, ${mayDisconnect(scope.userId)} as canDisconnect
		from connected_apps c
		where c.space_id = ${scope.spaceId} and c.deleted_at is null
		order by c.provider
		limit ${CONNECTED_APP_PROVIDERS.length}`);
	return rows.map((r) => ({ ...r, isDemo: r.isDemo === 1, canDisconnect: r.canDisconnect === 1 }));
}

/**
 * Every content column of a connection, cleared: the content-free tombstone the table's CHECK demands. `spaceId`
 * names the space whose change counter stamps the row (a value, or the row's own `space_id` column).
 */
const tombstone = (now: number, spaceId: string | SQL) => ({
	status: 'disconnected' as const,
	externalLabel: null,
	encryptedToken: null,
	tokenNonce: null,
	tokenKeyId: null,
	scope: null,
	deletedAt: now,
	updatedAt: now,
	seq: currentSpaceSeq(spaceId)
});

export type DisconnectResult = 'ok' | 'missing' | 'forbidden';

/**
 * "Putuskan": the connection `id` of the space becomes a content-free tombstone (token, nonce, key id, label and
 * scope deleted) together with one `app_disconnected` audit event, in one batch. Only its creator or the space's
 * Pemilik may (red team L3): another live member gets `forbidden` (they can see the connection, so that reveals
 * nothing). `missing` for an unknown, already disconnected or other-space id, or once the user is no longer a
 * live member (one answer).
 */
export async function disconnectApp(
	db: Db,
	scope: SpaceScope,
	id: string,
	now: number
): Promise<DisconnectResult> {
	const { spaceId, userId } = scope;
	const row = sql`c.id = ${id} and c.space_id = ${spaceId} and c.deleted_at is null`;
	const allowed = sql`exists (select 1 from connected_apps c where ${row} and ${mayDisconnect(userId)})
		and ${isLiveMember(spaceId, userId)}`;
	const [, , disconnected] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		recordAuditEvent(
			db,
			{ spaceId, actorUserId: userId, action: 'app_disconnected' },
			now,
			allowed
		),
		db
			.update(connectedApps)
			.set(tombstone(now, sql`connected_apps.space_id`))
			.where(and(eq(connectedApps.id, id), allowed))
			.returning({ id: connectedApps.id })
	]);
	if (disconnected.length === 1) return 'ok';
	const [visible] = await db.all<{ one: number }>(
		sql`select 1 as one from connected_apps c where ${row} and ${isLiveMember(spaceId, userId)}`
	);
	return visible ? 'forbidden' : 'missing';
}

/**
 * `db.batch` items ending every live connection `userId` made in the spaces `inSpace` selects (a condition on
 * `connected_apps.space_id`), while `guard` holds (red team L2): a connection is its creator's own credential, so
 * it must not outlive their membership. Each becomes a content-free tombstone (token material deleted) with a
 * content-free `app_auto_disconnected` audit row (no actor, target = the creator), and each touched space's
 * change counter advances. Put the items before the membership change they accompany and pass its guard.
 */
export function autoDisconnectItems(db: Db, userId: string, inSpace: SQL, guard: SQL, now: number) {
	const ending = sql`${connectedApps.createdByUserId} = ${userId} and ${connectedApps.deletedAt} is null
		and ${inSpace} and ${guard}`;
	return [
		bumpSpaceSeqsWhere(db, connectedApps, ending),
		db.insert(auditEvents).select((qb) =>
			qb
				.select({
					id: sql`lower(hex(randomblob(16)))`.as('id'),
					spaceId: connectedApps.spaceId,
					actorUserId: sql`null`.as('actor_user_id'),
					action: sql`'app_auto_disconnected'`.as('action'),
					targetUserId: sql`${userId}`.as('target_user_id'),
					createdAt: sql`${now}`.as('created_at')
				})
				.from(connectedApps)
				.where(ending)
		),
		db
			.update(connectedApps)
			.set(tombstone(now, sql`connected_apps.space_id`))
			.where(ending)
	] as const;
}

export type SeedResult = 'ok' | 'exists' | 'not_configured';

/**
 * Dev-only (`devRoutesEnabled`): a fictional `connected` row for `provider` (`is_demo`, badged "Data demo") with a
 * synthetic token sealed by crypto.ts, plus one `app_connected` audit event, in one batch — the only way a
 * connection exists this pass (no provider app is registered). `exists`: the space already has a live
 * connection of that app; `not_configured`: no well-formed encryption key, so nothing is written.
 */
export async function seedDemoConnectedApp(
	db: Db,
	scope: SpaceScope,
	env: ConnectedAppsKeyEnv | undefined,
	provider: ConnectedAppProvider,
	now: number
): Promise<SeedResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const sealed = await encryptToken(env, `demo-token-${newId()}`, { rowId: id, spaceId, provider });
	if (!sealed) return 'not_configured';
	const free = sql`not exists (select 1 from connected_apps c where c.space_id = ${spaceId}
		and c.provider = ${provider} and c.deleted_at is null) and ${isLiveMember(spaceId, userId)}`;
	try {
		const [, , inserted] = await db.batch([
			bumpSpaceSeq(db, spaceId),
			recordAuditEvent(db, { spaceId, actorUserId: userId, action: 'app_connected' }, now, free),
			db
				.insert(connectedApps)
				.select(
					sql`select ${id}, ${spaceId}, ${provider}, 'connected', ${'contoh.id'}, ${sealed.ciphertext},
						${sealed.nonce}, ${sealed.keyId}, null, 1, ${userId}, ${now}, ${now}, null,
						${currentSpaceSeq(spaceId)}
					where ${free}`
				)
				.returning({ id: connectedApps.id })
		]);
		return inserted.length === 1 ? 'ok' : 'exists';
	} catch (e) {
		// The partial unique index is the backstop for a race the guard cannot see; the batch rolled back whole.
		if (isUniqueViolation(e)) return 'exists';
		throw e;
	}
}

/**
 * Dev-only: every live demo connection of the space becomes a tombstone, each with its own `app_disconnected`
 * audit event, in one batch. Returns how many.
 */
export async function clearDemoConnectedApps(
	db: Db,
	scope: SpaceScope,
	now: number
): Promise<number> {
	const { spaceId, userId } = scope;
	const demo = and(
		eq(connectedApps.spaceId, spaceId),
		eq(connectedApps.isDemo, true),
		isNull(connectedApps.deletedAt),
		isLiveMember(spaceId, userId)
	);
	const [, , cleared] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db.insert(auditEvents).select((qb) =>
			qb
				.select({
					id: sql`lower(hex(randomblob(16)))`.as('id'),
					spaceId: connectedApps.spaceId,
					actorUserId: sql`${userId}`.as('actor_user_id'),
					action: sql`'app_disconnected'`.as('action'),
					targetUserId: sql`null`.as('target_user_id'),
					createdAt: sql`${now}`.as('created_at')
				})
				.from(connectedApps)
				.where(demo)
		),
		db
			.update(connectedApps)
			.set(tombstone(now, spaceId))
			.where(demo)
			.returning({ id: connectedApps.id })
	]);
	return cleared.length;
}
