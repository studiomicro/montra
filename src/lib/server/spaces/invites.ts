import { and, eq, gt, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { spaceInvites, spaceMembers, spaces } from '../db/schema';
import { newId, randomToken, sha256Hex } from '../util';
import { isSharedSpaceOwner, MAX_SPACE_MEMBERS } from './access';
import { recordAuditEvent } from './audit';

/** An invite link works for 7 days (owner decision, FN-03). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `randomToken(32)`: 32 random bytes as 43 URL-safe base64 characters, like a session token. */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const INVITE_PATH_PREFIX = '/ruang/undangan/';
/** The path of an invite link; the raw token exists only in this link, D1 keeps its SHA-256. */
export const invitePath = (token: string) => `${INVITE_PATH_PREFIX}${token}`;

/**
 * Whether a request URL carries an invite token: the invite page itself, or /masuk and /daftar with the
 * invite as `next`. Their responses get `Referrer-Policy: strict-origin` so a Referer never carries the path.
 */
export function carriesInviteToken(url: URL): boolean {
	return (
		url.pathname.startsWith(INVITE_PATH_PREFIX) ||
		(url.searchParams.get('next') ?? '').startsWith(INVITE_PATH_PREFIX)
	);
}

/**
 * The path of a request for the app's own request log line (hooks.server.ts logs the route id instead when one
 * matched): an invite token in the path becomes `[token]`, also when the path was percent-encoded, and the
 * query string is left out, since `next=` can carry an invite link (FN-03 red team L3). Workers Logs' own
 * invocation logs, which record the full URL, are switched off in wrangler.jsonc.
 */
export function redactedPath(url: URL): string {
	let path = url.pathname;
	try {
		path = decodeURI(path);
	} catch {
		// Malformed escapes: redacted as given.
	}
	return path.replace(/^\/ruang\/undangan\/[^/]*/i, '/ruang/undangan/[token]');
}

/**
 * SQL condition: `userId` was not removed from the space after the invite was created. A removed member cannot
 * come back through a link that already existed when they were removed (red team M1); only a link the owner
 * makes afterwards lets them back. A member who left on their own may rejoin.
 */
const notRemovedSince = (userId: string, spaceId: SQL, inviteCreatedAt: SQL) =>
	sql`not exists (select 1 from audit_events a where a.space_id = ${spaceId}
		and a.action = 'member_removed' and a.target_user_id = ${userId}
		and a.created_at >= ${inviteCreatedAt})`;

const liveInviteOf = (spaceId: string) =>
	sql`select 1 from space_invites where space_id = ${spaceId} and deleted_at is null`;

/**
 * Creates the space's invite link. `replaces` is the id of the live invite the owner was looking at ('' when
 * none): it is revoked in the same batch. When the live invite is no longer that one (another tab created or
 * revoked one meanwhile) nothing is written and null is returned, so at most one link is ever usable. Every
 * statement re-checks that `userId` is the live owner of this shared space.
 */
export async function createInvite(
	db: Db,
	input: { spaceId: string; userId: string; replaces: string },
	now: number
): Promise<{ token: string; expiresAt: number } | null> {
	const { spaceId, userId, replaces } = input;
	const owner = isSharedSpaceOwner(spaceId, userId);
	const token = randomToken(32);
	const id = newId();
	const expiresAt = now + INVITE_TTL_MS;
	const replaced = sql`exists (select 1 from space_invites where id = ${replaces}
		and space_id = ${spaceId} and deleted_at is null) and ${owner}`;
	const tokenHash = await sha256Hex(token);
	const [, , created] = await db.batch([
		recordAuditEvent(db, { spaceId, actorUserId: userId, action: 'invite_revoked' }, now, replaced),
		db
			.update(spaceInvites)
			.set({ deletedAt: now, updatedAt: now })
			.where(
				and(
					eq(spaceInvites.id, replaces),
					eq(spaceInvites.spaceId, spaceId),
					isNull(spaceInvites.deletedAt),
					owner
				)
			),
		db
			.insert(spaceInvites)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						spaceId: spaces.id,
						tokenHash: sql`${tokenHash}`.as('token_hash'),
						createdByUserId: sql`${userId}`.as('created_by_user_id'),
						expiresAt: sql`${expiresAt}`.as('expires_at'),
						createdAt: sql`${now}`.as('created_at'),
						updatedAt: sql`${now}`.as('updated_at'),
						deletedAt: sql`null`.as('deleted_at')
					})
					.from(spaces)
					.where(and(eq(spaces.id, spaceId), owner, sql`not exists (${liveInviteOf(spaceId)})`))
			)
			.returning({ id: spaceInvites.id }),
		recordAuditEvent(
			db,
			{ spaceId, actorUserId: userId, action: 'invite_created' },
			now,
			sql`exists (select 1 from space_invites where id = ${id})`
		)
	]);
	return created.length === 1 ? { token, expiresAt } : null;
}

/** Revokes the live invite `inviteId` of the space. False when it is no longer live (or not the owner). */
export async function revokeInvite(
	db: Db,
	input: { spaceId: string; userId: string; inviteId: string },
	now: number
): Promise<boolean> {
	const { spaceId, userId, inviteId } = input;
	const guard = sql`exists (select 1 from space_invites where id = ${inviteId}
		and space_id = ${spaceId} and deleted_at is null) and ${isSharedSpaceOwner(spaceId, userId)}`;
	const [, revoked] = await db.batch([
		recordAuditEvent(db, { spaceId, actorUserId: userId, action: 'invite_revoked' }, now, guard),
		db
			.update(spaceInvites)
			.set({ deletedAt: now, updatedAt: now })
			.where(and(eq(spaceInvites.id, inviteId), guard))
			.returning({ id: spaceInvites.id })
	]);
	return revoked.length === 1;
}

/** The live invite of a space (never its token), or null. */
export async function liveInvite(db: Db, spaceId: string) {
	const row = await db.get<{ id: string; expiresAt: number } | undefined>(
		sql`select id, expires_at as expiresAt from space_invites
			where space_id = ${spaceId} and deleted_at is null limit 1`
	);
	return row ?? null;
}

export interface ResolvedInvite {
	spaceId: string;
	spaceName: string;
	memberCount: number;
	isMember: boolean;
}

/**
 * The usable invite behind `token` as seen by `userId`, or null. Unknown, malformed, expired and revoked
 * tokens, a space no longer shared or live, and a user removed since the invite was made all give null: callers show one message for all of them.
 */
export async function resolveInvite(
	db: Db,
	token: string,
	userId: string,
	now: number
): Promise<ResolvedInvite | null> {
	if (!INVITE_TOKEN.test(token)) return null;
	const row = await db.get<
		{ spaceId: string; spaceName: string; memberCount: number; isMember: number } | undefined
	>(sql`select s.id as spaceId, s.name as spaceName,
			(select count(*) from space_members m where m.space_id = s.id and m.deleted_at is null) as memberCount,
			exists (select 1 from space_members m where m.space_id = s.id and m.user_id = ${userId}
				and m.deleted_at is null) as isMember
		from space_invites i join spaces s on s.id = i.space_id
		where i.token_hash = ${await sha256Hex(token)} and i.deleted_at is null and i.expires_at > ${now}
			and s.kind = 'shared' and s.deleted_at is null
			and ${notRemovedSince(userId, sql`s.id`, sql`i.created_at`)}`);
	return row ? { ...row, isMember: row.isMember === 1 } : null;
}

export type AcceptResult =
	{ status: 'joined' | 'member'; spaceId: string } | { status: 'full' } | { status: 'invalid' };

/**
 * Joins `userId` to the space of the invite `token`. The membership is written by one guarded statement that
 * re-checks, inside the write, that the invite is still usable, the user is not already a live member and the
 * space has fewer than MAX_SPACE_MEMBERS live members; a former member's tombstoned row is revived instead of
 * duplicated. The `member_joined` audit row is written in the same batch only when that statement changed a
 * row. Already a member → `member` (idempotent, nothing written).
 */
export async function acceptInvite(
	db: Db,
	token: string,
	userId: string,
	now: number
): Promise<AcceptResult> {
	const invite = await resolveInvite(db, token, userId, now);
	if (!invite) return { status: 'invalid' };
	if (invite.isMember) return { status: 'member', spaceId: invite.spaceId };
	if (invite.memberCount >= MAX_SPACE_MEMBERS) return { status: 'full' };
	const { spaceId } = invite;
	const tokenHash = await sha256Hex(token);
	const [joined] = await db.batch([
		db
			.insert(spaceMembers)
			.select((qb) =>
				qb
					.select({
						id: sql`${newId()}`.as('id'),
						spaceId: spaceInvites.spaceId,
						userId: sql`${userId}`.as('user_id'),
						role: sql`'member'`.as('role'),
						createdAt: sql`${now}`.as('created_at'),
						updatedAt: sql`${now}`.as('updated_at'),
						deletedAt: sql`null`.as('deleted_at')
					})
					.from(spaceInvites)
					.innerJoin(spaces, eq(spaces.id, spaceInvites.spaceId))
					.where(
						and(
							eq(spaceInvites.tokenHash, tokenHash),
							eq(spaceInvites.spaceId, spaceId),
							isNull(spaceInvites.deletedAt),
							gt(spaceInvites.expiresAt, now),
							eq(spaces.kind, 'shared'),
							isNull(spaces.deletedAt),
							notRemovedSince(userId, sql`${spaceId}`, sql`${spaceInvites.createdAt}`),
							sql`(select count(*) from space_members m
								where m.space_id = ${spaceId} and m.deleted_at is null) < ${MAX_SPACE_MEMBERS}`,
							sql`not exists (select 1 from space_members m
								where m.space_id = ${spaceId} and m.user_id = ${userId} and m.deleted_at is null)`
						)
					)
			)
			// A former member's tombstoned row is revived (the (space_id, user_id) index is unique).
			.onConflictDoUpdate({
				target: [spaceMembers.spaceId, spaceMembers.userId],
				set: {
					role: 'member',
					deletedAt: null,
					createdAt: sql`excluded.created_at`,
					updatedAt: sql`excluded.updated_at`
				},
				setWhere: isNotNull(spaceMembers.deletedAt)
			})
			.returning({ id: spaceMembers.id }),
		recordAuditEvent(
			db,
			{ spaceId, actorUserId: userId, action: 'member_joined' },
			now,
			sql`changes() = 1`
		)
	]);
	if (joined.length === 1) return { status: 'joined', spaceId };
	// Lost a race: classify by the state after it.
	const after = await resolveInvite(db, token, userId, now);
	if (!after) return { status: 'invalid' };
	if (after.isMember) return { status: 'member', spaceId: after.spaceId };
	return { status: 'full' };
}
