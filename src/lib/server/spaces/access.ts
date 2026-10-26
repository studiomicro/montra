import { error, type Cookies } from '@sveltejs/kit';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { hostCookieName } from '../auth/session';
import type { Db } from '../db';
import { spaceMembers, spaces } from '../db/schema';

/** Most people in one space, the owner included (one constant, reused by invites.ts). */
export const MAX_SPACE_MEMBERS = 5;

export type SpaceRole = 'owner' | 'member';
export type SpaceKind = 'personal' | 'shared';

export interface SpaceAccess {
	space: { id: string; kind: SpaceKind; name: string };
	role: SpaceRole;
}

/** `locals.space`: the default space of a signed-in request (see `resolveCurrentSpace`). */
export interface CurrentSpace {
	id: string;
	kind: SpaceKind;
	name: string;
	role: SpaceRole;
}

/** Longest space id looked up; ids are UUIDs (36 chars), anything longer cannot match. */
const SPACE_ID_MAX_LENGTH = 64;
/** The fixed bodies of the two refusals. Never more detail than this. */
const NOT_FOUND = 'Not found';
const FORBIDDEN = 'Forbidden';

/**
 * The one gate for space data (FN-03; every space-scoped load, action, download and AI tool calls it).
 *
 * `requireSpaceAccess(db, userId, spaceId, opts?)`
 * - `userId`: always `event.locals.user.id`, never a client-supplied value.
 * - `spaceId`: the id the request names (route param or form field). Never substitute `locals.space` for an
 *   id the request itself supplies.
 * - `opts.role`: the role the caller must hold (`'owner'` for owner-only actions, `'member'` for actions only
 *   a non-owner may take, such as leaving).
 *
 * Returns `{ space: { id, kind, name }, role }` for a live membership of a live space.
 * Throws `error(404, 'Not found')` (one fixed body) when the space does not exist, exists without a
 * membership for this user, or the membership/space is tombstoned: one query decides all three, so status,
 * body and timing reveal nothing. Throws `error(403, 'Forbidden')` only when a membership exists but its role
 * is not `opts.role` (that caller already knows the space exists).
 */
export async function requireSpaceAccess(
	db: Db,
	userId: string,
	spaceId: string,
	opts?: { role?: SpaceRole }
): Promise<SpaceAccess> {
	// An over-long id still costs the same one query (with an id that matches nothing).
	const id = spaceId.length > SPACE_ID_MAX_LENGTH ? '' : spaceId;
	const row = await db
		.select({ id: spaces.id, kind: spaces.kind, name: spaces.name, role: spaceMembers.role })
		.from(spaceMembers)
		.innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
		.where(
			and(
				eq(spaceMembers.spaceId, id),
				eq(spaceMembers.userId, userId),
				isNull(spaceMembers.deletedAt),
				isNull(spaces.deletedAt)
			)
		)
		.get();
	if (!row) error(404, NOT_FOUND);
	if (opts?.role && row.role !== opts.role) error(403, FORBIDDEN);
	return { space: { id: row.id, kind: row.kind, name: row.name }, role: row.role };
}

/**
 * The space for `locals.space`: the one the `space` cookie names when the user is still a live member of it,
 * else the user's personal space. One query; never throws for a bad cookie. Null only for a user without a
 * personal space (an account mid-deletion).
 */
export async function resolveCurrentSpace(
	db: Db,
	userId: string,
	cookieValue: string | undefined
): Promise<CurrentSpace | null> {
	return (await currentSpaceQuery(db, userId, cookieValue))[0] ?? null;
}

/**
 * The one query of `resolveCurrentSpace` (at most one row), as a statement a caller may also put into a
 * `db.batch` (hooks.server.ts reads it beside the plan).
 */
export function currentSpaceQuery(db: Db, userId: string, cookieValue: string | undefined) {
	const wanted = cookieValue && cookieValue.length <= SPACE_ID_MAX_LENGTH ? cookieValue : '';
	return db
		.select({ id: spaces.id, kind: spaces.kind, name: spaces.name, role: spaceMembers.role })
		.from(spaceMembers)
		.innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
		.where(
			and(
				eq(spaceMembers.userId, userId),
				isNull(spaceMembers.deletedAt),
				isNull(spaces.deletedAt),
				or(eq(spaces.id, wanted), eq(spaces.kind, 'personal'))
			)
		)
		.orderBy(sql`case when ${spaces.id} = ${wanted} then 0 else 1 end`)
		.limit(1);
}

/**
 * SQL condition: `userId` is the live owner of the live shared space `spaceId`. Owner-only writes repeat it
 * inside their own statements, so a change between `requireSpaceAccess` and the write cannot slip through.
 */
export function isSharedSpaceOwner(spaceId: string, userId: string) {
	return sql`exists (select 1 from space_members m join spaces s on s.id = m.space_id
		where m.space_id = ${spaceId} and m.user_id = ${userId} and m.role = 'owner'
		and m.deleted_at is null and s.kind = 'shared' and s.deleted_at is null)`;
}

/**
 * Who writes where: a space that `requireSpaceAccess` admitted `userId` to. Space-data repos take it and
 * repeat the membership in their write statements with `isLiveMember`.
 */
export interface SpaceScope {
	spaceId: string;
	userId: string;
}

/**
 * SQL condition: `userId` is a live member (any role) of the live space `spaceId`. Space-data writes repeat it
 * inside their own statements, like `isSharedSpaceOwner`, so a removal between `requireSpaceAccess` and the
 * write cannot slip through.
 */
export function isLiveMember(spaceId: string, userId: string) {
	return sql`exists (select 1 from space_members m join spaces s on s.id = m.space_id
		where m.space_id = ${spaceId} and m.user_id = ${userId}
		and m.deleted_at is null and s.deleted_at is null)`;
}

/**
 * Cookie naming the current space. Only a default: it is re-validated on every request. Named like the session
 * cookie (`__Host-space` on deployed hosts, `hostCookieName`); cleared on sign-out and account deletion.
 */
export const SPACE_COOKIE = 'space';
const SPACE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
/** One-shot "you left the space" notice: set only by a confirmed leave, read and cleared by /ruang. */
export const LEFT_NOTICE_COOKIE = 'space_left';
const LEFT_NOTICE_MAX_AGE_S = 60;

const cookieOptions = (secure: boolean) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	secure
});

export const spaceCookieName = (secure: boolean) => hostCookieName(SPACE_COOKIE, secure);

export function setSpaceCookie(cookies: Cookies, spaceId: string, secure: boolean) {
	cookies.set(spaceCookieName(secure), spaceId, {
		...cookieOptions(secure),
		maxAge: SPACE_COOKIE_MAX_AGE_S
	});
}

/** Back to the personal space (the fallback of `resolveCurrentSpace`). */
export function clearSpaceCookie(cookies: Cookies, secure: boolean) {
	cookies.delete(spaceCookieName(secure), cookieOptions(secure));
}

export function setLeftNotice(cookies: Cookies, secure: boolean) {
	cookies.set(hostCookieName(LEFT_NOTICE_COOKIE, secure), '1', {
		...cookieOptions(secure),
		maxAge: LEFT_NOTICE_MAX_AGE_S
	});
}

/** Whether a confirmed leave just happened; clears the notice so it shows once. */
export function takeLeftNotice(cookies: Cookies, secure: boolean): boolean {
	const name = hostCookieName(LEFT_NOTICE_COOKIE, secure);
	if (cookies.get(name) !== '1') return false;
	cookies.delete(name, cookieOptions(secure));
	return true;
}
