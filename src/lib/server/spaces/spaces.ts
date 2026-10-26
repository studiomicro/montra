import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { cleanText } from '#lib/shared/text';
import type { Db } from '../db';
import {
	agentRuns,
	auditEvents,
	belongings,
	budgetStreakDays,
	budgets,
	categoryBudgets,
	categoryCleanupBatches,
	categoryCleanupItems,
	categories,
	collectibles,
	connectedApps,
	drafts,
	gmailConnections,
	gmailMail,
	goalContributions,
	goals,
	importBatches,
	inboundAddresses,
	inboundMail,
	merchantCache,
	merchantRules,
	netWorthItems,
	netWorthSnapshots,
	oauthStates,
	patunganParticipants,
	patunganShareLinks,
	patunganSplits,
	recurringTransactions,
	spaceInvites,
	spaceMembers,
	spaceNotifications,
	spaceSeq,
	spaces,
	subscriptionDismissals,
	subscriptions,
	tanyaMessages,
	transactions,
	transferLinks,
	cardStatements,
	wallets
} from '../db/schema';
import { releaseAgentKeys } from '../agent/keys';
import { autoDisconnectItems } from '../connected-apps/repo';
import { queueGmailRevocations } from '../gmail/repo';
import { releasePhotoKeys } from '../photos/store';
import { newId } from '../util';
import { isSharedSpaceOwner, MAX_SPACE_MEMBERS, type SpaceKind, type SpaceRole } from './access';
import { recordAuditEvent } from './audit';

/** Stored length cap of a shared space's name (cleaned like FN-01's sign-up name). */
export const SPACE_NAME_MAX_LENGTH = 60;
/** Most memberships `/ruang` lists for one user (no plan cap yet, owner decision C; the page stays bounded). */
const SPACE_LIST_LIMIT = 100;

/**
 * Creates a shared space owned by `userId`: the space, the owner membership and the `space_created` audit
 * row in one `db.batch`. Null when the cleaned name is empty.
 */
export async function createSharedSpace(
	db: Db,
	userId: string,
	rawName: string,
	now: number
): Promise<string | null> {
	const name = cleanText(rawName, SPACE_NAME_MAX_LENGTH);
	if (!name) return null;
	const spaceId = newId();
	await db.batch([
		db.insert(spaces).values({ id: spaceId, kind: 'shared', name, createdAt: now, updatedAt: now }),
		db.insert(spaceMembers).values({
			id: newId(),
			spaceId,
			userId,
			role: 'owner',
			createdAt: now,
			updatedAt: now
		}),
		recordAuditEvent(db, { spaceId, actorUserId: userId, action: 'space_created' }, now)
	]);
	return spaceId;
}

export interface SpaceSummary {
	id: string;
	kind: SpaceKind;
	name: string;
	role: SpaceRole;
	memberCount: number;
}

/** The live spaces `userId` belongs to: personal first, then shared by creation. Bounded. */
export async function listSpaces(db: Db, userId: string): Promise<SpaceSummary[]> {
	return db.all<SpaceSummary>(sql`select s.id, s.kind, s.name, m.role,
			(select count(*) from space_members o where o.space_id = s.id and o.deleted_at is null) as memberCount
		from space_members m join spaces s on s.id = m.space_id
		where m.user_id = ${userId} and m.deleted_at is null and s.deleted_at is null
		order by case s.kind when 'personal' then 0 else 1 end, s.created_at, s.id
		limit ${SPACE_LIST_LIMIT}`);
}

export interface MemberSummary {
	/** The membership id (keys the list; the remove form names it). */
	id: string;
	name: string;
	role: SpaceRole;
	isYou: boolean;
}

/** The live members of `spaceId`, owner first. Call only after `requireSpaceAccess`. */
export async function listMembers(
	db: Db,
	spaceId: string,
	viewerId: string
): Promise<MemberSummary[]> {
	const rows = await db.all<{ id: string; name: string; role: SpaceRole; userId: string }>(
		sql`select m.id, u.name, m.role, m.user_id as userId
			from space_members m join users u on u.id = m.user_id
			where m.space_id = ${spaceId} and m.deleted_at is null
			order by case m.role when 'owner' then 0 else 1 end, m.created_at, m.id
			limit ${MAX_SPACE_MEMBERS}`
	);
	return rows.map(({ userId, ...m }) => ({ ...m, isYou: userId === viewerId }));
}

export type RemoveResult = 'removed' | 'owner' | 'gone';

/**
 * The owner removes the live non-owner membership `memberId`: tombstone, `member_removed` audit row naming
 * the removed user, and the space's live invite revoked (with its `invite_revoked` row), one batch, every
 * statement guarded on the same condition. `owner` when `memberId` is the owner's
 * own row (no owner self-removal, decision D); `gone` when it is no longer a live member here.
 */
export async function removeMember(
	db: Db,
	input: { spaceId: string; actorUserId: string; memberId: string },
	now: number
): Promise<RemoveResult> {
	const { spaceId, actorUserId, memberId } = input;
	const target = await db.get<{ userId: string; role: SpaceRole } | undefined>(
		sql`select user_id as userId, role from space_members
			where id = ${memberId} and space_id = ${spaceId} and deleted_at is null`
	);
	if (!target) return 'gone';
	if (target.role === 'owner') return 'owner';
	const guard = sql`exists (select 1 from space_members where id = ${memberId}
		and space_id = ${spaceId} and role = 'member' and deleted_at is null)
		and ${isSharedSpaceOwner(spaceId, actorUserId)}`;
	const liveInvite = sql`exists (select 1 from space_invites where space_id = ${spaceId}
		and deleted_at is null)`;
	const [, , , , , , removed] = await db.batch([
		// The removed member's connected apps end with the membership (FN-29 red team L2).
		...autoDisconnectItems(
			db,
			target.userId,
			sql`connected_apps.space_id = ${spaceId}`,
			guard,
			now
		),
		recordAuditEvent(
			db,
			{ spaceId, actorUserId, action: 'member_removed', targetUserId: target.userId },
			now,
			guard
		),
		// The link the removed member came in by is reset with the removal (red team M1); the owner makes a
		// new one when they want to invite someone else.
		recordAuditEvent(
			db,
			{ spaceId, actorUserId, action: 'invite_revoked' },
			now,
			sql`${guard} and ${liveInvite}`
		),
		db
			.update(spaceInvites)
			.set({ deletedAt: now, updatedAt: now })
			.where(and(eq(spaceInvites.spaceId, spaceId), isNull(spaceInvites.deletedAt), guard)),
		db
			.update(spaceMembers)
			.set({ deletedAt: now, updatedAt: now })
			.where(and(eq(spaceMembers.id, memberId), guard))
			.returning({ id: spaceMembers.id })
	]);
	return removed.length === 1 ? 'removed' : 'gone';
}

/** A non-owner member leaves (tombstone + `member_left` audit row, one batch). False when already gone. */
export async function leaveSpace(
	db: Db,
	input: { spaceId: string; userId: string },
	now: number
): Promise<boolean> {
	const { spaceId, userId } = input;
	const guard = sql`exists (select 1 from space_members where space_id = ${spaceId}
		and user_id = ${userId} and role = 'member' and deleted_at is null)`;
	const [, , , , left] = await db.batch([
		// The leaver's connected apps end with the membership (FN-29 red team L2).
		...autoDisconnectItems(db, userId, sql`connected_apps.space_id = ${spaceId}`, guard, now),
		recordAuditEvent(db, { spaceId, actorUserId: userId, action: 'member_left' }, now, guard),
		db
			.update(spaceMembers)
			.set({ deletedAt: now, updatedAt: now })
			.where(
				and(
					eq(spaceMembers.spaceId, spaceId),
					eq(spaceMembers.userId, userId),
					eq(spaceMembers.role, 'member'),
					isNull(spaceMembers.deletedAt)
				)
			)
			.returning({ id: spaceMembers.id })
	]);
	return left.length === 1;
}

/**
 * What happens to the shared spaces of an account being deleted (FN-01 red-team L5, default accepted by the
 * owner 2026-10-08). Returns two `db.batch` items for `deleteAccount`, to run before it deletes the user's
 * memberships, each guarded by `proof` (the deletion's password proof):
 * 1. An `ownership_transferred` audit row per space handed over (actor: the deleting user, nulled when the
 *    user row goes; target: the new owner), evaluated before the promotion so it sees the same state.
 * 2. Every live shared space this user owns, with no other live owner, passes to its longest-standing live
 *    member (earliest `created_at`, then id).
 * Spaces where this user is the last live member are deleted outright with `purgeSpaces` (red team L1).
 */
export function sharedSpaceHandOver(db: Db, userId: string, proof: SQL, now: number) {
	const successor = sql`(select m2.id from space_members m2
		where m2.space_id = o.space_id and m2.user_id <> ${userId} and m2.deleted_at is null
		order by m2.created_at, m2.id limit 1)`;
	const heir = (column: 'id' | 'user_id', spaceRef: SQL) =>
		sql.raw(`(select m2.${column} from space_members m2 where m2.space_id = `).append(spaceRef)
			.append(sql` and m2.user_id <> ${userId} and m2.deleted_at is null
				order by m2.created_at, m2.id limit 1)`);
	const handedOver = sql`${spaces.kind} = 'shared' and ${spaces.deletedAt} is null
		and exists (select 1 from space_members o where o.space_id = ${spaces.id} and o.user_id = ${userId}
			and o.role = 'owner' and o.deleted_at is null)
		and not exists (select 1 from space_members x where x.space_id = ${spaces.id}
			and x.user_id <> ${userId} and x.role = 'owner' and x.deleted_at is null)
		and ${heir('id', sql`${spaces.id}`)} is not null`;
	return [
		db.insert(auditEvents).select((qb) =>
			qb
				.select({
					id: sql`lower(hex(randomblob(16)))`.as('id'),
					spaceId: spaces.id,
					actorUserId: sql`${userId}`.as('actor_user_id'),
					action: sql`'ownership_transferred'`.as('action'),
					targetUserId: sql`${heir('user_id', sql`${spaces.id}`)}`.as('target_user_id'),
					createdAt: sql`${now}`.as('created_at')
				})
				.from(spaces)
				.where(and(proof, handedOver))
		),
		db
			.update(spaceMembers)
			.set({ role: 'owner', updatedAt: now })
			.where(
				and(
					proof,
					sql`${spaceMembers.id} in (select ${successor}
						from space_members o join spaces s on s.id = o.space_id
						where o.user_id = ${userId} and o.role = 'owner' and o.deleted_at is null
							and s.kind = 'shared' and s.deleted_at is null
							and not exists (select 1 from space_members x where x.space_id = o.space_id
								and x.user_id <> ${userId} and x.role = 'owner' and x.deleted_at is null))`
				)
			)
	] as const;
}

/**
 * Every table that holds rows of a space, children before `spaces`. FN-04 onward MUST add each new
 * space-scoped table here (wallets, transactions, budgets, goals, …): deleting a space deletes exactly what
 * is listed, so a missing table would leave financial rows behind after account deletion.
 */
export const SPACE_SCOPED_TABLES = [
	// E-mail forwarding (FN-19): the ledger points at the address, the address at the space and its owner.
	inboundMail,
	inboundAddresses,
	// Gmail (FN-19): the ledger points at the connection (its scans cascade with it), the connection and the
	// unfinished authorizations at the target space and their owner.
	gmailMail,
	gmailConnections,
	oauthStates,
	// Tanya conversations (FN-22) point at the space and a user; nothing points at them.
	tanyaMessages,
	// Agen report runs (FN-23) point at the space and a user; their R2 keys go to the outbox first (purgeSpaces).
	agentRuns,
	// Merchant rules and the AI cache (FN-20) point at the space, categories and (set null) a user; nothing points
	// at them. Before `categories`.
	merchantRules,
	merchantCache,
	// Connected apps (FN-29): point at the space and (set null) a user; nothing points at them.
	connectedApps,
	// Subscriptions (FN-26) point at wallets and at the transaction that recorded their latest payment.
	subscriptions,
	// Subscription check dismissals (FN-26b) point at the space and (set null) a user; nothing points at them.
	subscriptionDismissals,
	// Notifications (FN-24) point at the space and a user; nothing points at them.
	spaceNotifications,
	// Net worth (FN-25): items and daily snapshots, independent of every other table.
	netWorthItems,
	netWorthSnapshots,
	// Budget-streak verdicts (FN-34b): derived from the budget and transactions, independent of both.
	budgetStreakDays,
	// Belongings (FN-27) and collectibles (FN-28): their photo keys go to the file-deletion outbox first
	// (purgeSpaces).
	belongings,
	collectibles,
	// Goal contributions point at goals (independent of wallets and transactions).
	goalContributions,
	goals,
	// "Rapikan kategori" (FN-48): items point at their batch; both at the space (ids only, no other foreign key).
	categoryCleanupItems,
	categoryCleanupBatches,
	// "Cocokkan transfer" (FN-48 Part C): links point at the space only (transaction ids, no foreign key).
	transferLinks,
	// Card statements (FN-55b) point at wallets and import batches (deleted below).
	cardStatements,
	// Drafts point at transactions, wallets and categories; transactions at wallets, categories and imports.
	drafts,
	transactions,
	// Patungan (FN-49): transactions point at splits (deleted above); share links and participants at splits.
	patunganShareLinks,
	patunganParticipants,
	patunganSplits,
	importBatches,
	// Recurring series (FN-36) point at wallets and categories; transactions point at them (deleted above).
	recurringTransactions,
	budgets,
	// Category budgets (Anggaran) point at categories.
	categoryBudgets,
	categories,
	wallets,
	spaceSeq,
	auditEvents,
	spaceInvites,
	spaceMembers
] as const;

/**
 * `db.batch` items that delete the spaces `spaceIds` selects and every row they hold (all of SPACE_SCOPED_TABLES,
 * then the space rows), each statement only while `stillPurgeable(<space id column>)` holds, so a space that
 * gained a live member meanwhile is left whole. `spaceIds` is a subquery of space ids evaluated inside the batch
 * by every statement, so it must not depend on rows the purge itself deletes (`deleteAccount` marks the spaces
 * first, FN-03 N1). The R2 photos and Agen report files (FN-23) of those rows are first moved to the file-deletion outbox (due `now`); the
 * caller deletes them after the batch with `sweepSoon` (photos/store.ts); the jobs Worker sweeps whatever that
 * misses.
 */
export function purgeSpaces(
	db: Db,
	spaceIds: SQL,
	stillPurgeable: (spaceIdColumn: SQL) => SQL,
	now: number = Date.now()
) {
	const among = (column: SQL) => sql`${column} in (${spaceIds}) and ${stillPurgeable(column)}`;
	return [
		releasePhotoKeys(db, belongings, among(sql`${belongings.spaceId}`), now),
		releasePhotoKeys(db, collectibles, among(sql`${collectibles.spaceId}`), now),
		releasePhotoKeys(db, transactions, among(sql`${transactions.spaceId}`), now),
		// FN-19 Gmail red team L3: a connection pointing at a purged space (another member's, paused since they
		// left) is deleted below with its sealed token; its grant at Google is queued for the jobs Worker to revoke.
		queueGmailRevocations(db, among(sql`${gmailConnections.spaceId}`), now),
		...releaseAgentKeys(db, among(sql`${agentRuns.spaceId}`), now),
		...SPACE_SCOPED_TABLES.map((table) => db.delete(table).where(among(sql`${table.spaceId}`))),
		db.delete(spaces).where(among(sql`${spaces.id}`))
	];
}
