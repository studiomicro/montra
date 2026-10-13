import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import {
	API_TOKEN_MAX_PER_USER,
	API_TOKEN_PATTERN,
	API_TOKEN_PREFIX,
	type ApiTokenLifetime,
	type ApiTokenScope
} from '#lib/shared/api-tokens';
import type { Db } from '../db';
import { apiTokens, users } from '../db/schema';
import { isLiveMember } from '../spaces/access';
import { newId, randomToken, sha256Hex } from '../util';
import { SESSION_TOUCH_MS } from './session';

/**
 * FN-38 public API tokens: the Bearer-auth counterpart of sessions (session.ts), in their own table and with
 * no shared code path, so a token is never a session and a session never a token. Only the SHA-256 of a raw
 * token is stored; the raw value exists in the one response that created it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most once per this interval (a guarded UPDATE), like a session's `last_seen_at`. */
export const API_TOKEN_TOUCH_MS = SESSION_TOUCH_MS;
/** Longest Authorization value read; anything longer is answered like an unknown token. */
const TOKEN_MAX_LENGTH = 128;

/** SQL: the token row is live at `now` (neither revoked nor expired). */
const liveAt = (now: number) => and(isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, now));

export interface NewApiToken {
	name: string;
	scope: ApiTokenScope;
	/** One space the token is limited to (the user must be a live member of it); null for every space. */
	restrictedSpaceId: string | null;
	lifetimeDays: ApiTokenLifetime;
}

export type CreateApiTokenResult =
	| { ok: true; token: string; id: string; expiresAt: number }
	| { ok: false; reason: 'limit' | 'space' | 'credential' };

/**
 * Creates a token for `userId`, in one guarded INSERT … SELECT: written only while the user is active, the
 * password is still the one just proven (`provenHash`, as `createPasswordSession` does), the user has
 * fewer than API_TOKEN_MAX_PER_USER live tokens, and (for a restricted token) is a live member of that space,
 * so 20 concurrent creates never pass the cap. `limit` / `space` say which guard refused it.
 */
export async function createApiToken(
	db: Db,
	userId: string,
	input: NewApiToken,
	/** The stored password hash the user just re-entered (red team L2): a changed password writes nothing. */
	provenHash: string,
	now: number
): Promise<CreateApiTokenResult> {
	const token = API_TOKEN_PREFIX + randomToken(32);
	const id = newId();
	const expiresAt = now + input.lifetimeDays * DAY_MS;
	const space = input.restrictedSpaceId;
	const underCap = sql`(select count(*) from api_tokens t where t.user_id = ${userId}
		and t.revoked_at is null and t.expires_at > ${now}) < ${API_TOKEN_MAX_PER_USER}`;
	const inserted = await db
		.insert(apiTokens)
		.select(
			sql`select ${id}, ${userId}, ${input.name}, ${await sha256Hex(token)}, ${token.slice(-4)},
				${input.scope}, ${space}, ${expiresAt}, null, null, ${now}, ${now}
			from users u join user_passwords p on p.user_id = u.id and p.hash = ${provenHash}
			where u.id = ${userId} and u.status = 'active' and ${underCap}
				and ${space === null ? sql`1` : isLiveMember(space, userId)}`
		)
		.returning({ id: apiTokens.id });
	if (inserted.length === 1) return { ok: true, token, id, expiresAt };
	const [live] = await db.all<{ n: number }>(
		sql`select count(*) as n from api_tokens where user_id = ${userId}
			and revoked_at is null and expires_at > ${now}`
	);
	if ((live?.n ?? 0) >= API_TOKEN_MAX_PER_USER) return { ok: false, reason: 'limit' };
	const proof = await db.get<{ n: number }>(
		sql`select count(*) as n from user_passwords where user_id = ${userId} and hash = ${provenHash}`
	);
	return { ok: false, reason: proof?.n ? 'space' : 'credential' };
}

export interface ApiTokenSummary {
	id: string;
	name: string;
	lastFour: string;
	scope: ApiTokenScope;
	/** The restricted space as the user still sees it; `{ name: null }` when they are no longer a member. */
	space: { id: string; name: string | null; kind: 'personal' | 'shared' | null } | null;
	createdAt: number;
	expiresAt: number;
	lastUsedAt: number | null;
}

/** The user's live tokens, newest first; bounded by API_TOKEN_MAX_PER_USER. Never the hash. */
export async function listApiTokens(
	db: Db,
	userId: string,
	now: number
): Promise<ApiTokenSummary[]> {
	const rows = await db.all<{
		id: string;
		name: string;
		lastFour: string;
		scope: ApiTokenScope;
		spaceId: string | null;
		spaceName: string | null;
		spaceKind: 'personal' | 'shared' | null;
		createdAt: number;
		expiresAt: number;
		lastUsedAt: number | null;
	}>(sql`select t.id, t.name, t.last_four as lastFour, t.scope, t.restricted_space_id as spaceId,
			s.name as spaceName, s.kind as spaceKind, t.created_at as createdAt,
			t.expires_at as expiresAt, t.last_used_at as lastUsedAt
		from api_tokens t
		left join spaces s on s.id = t.restricted_space_id and s.deleted_at is null
			and exists (select 1 from space_members m where m.space_id = s.id
				and m.user_id = ${userId} and m.deleted_at is null)
		where t.user_id = ${userId} and t.revoked_at is null and t.expires_at > ${now}
		order by t.created_at desc, t.id desc
		limit ${API_TOKEN_MAX_PER_USER}`);
	return rows.map(({ spaceId, spaceName, spaceKind, ...t }) => ({
		...t,
		space: spaceId ? { id: spaceId, name: spaceName, kind: spaceKind } : null
	}));
}

/** Revokes one live token of `userId`; false when there is no such live token (unknown, another user's, gone). */
export async function revokeApiToken(
	db: Db,
	userId: string,
	tokenId: string,
	now: number
): Promise<boolean> {
	const revoked = await db
		.update(apiTokens)
		.set({ revokedAt: now, updatedAt: now })
		.where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), liveAt(now)))
		.returning({ id: apiTokens.id });
	return revoked.length === 1;
}

/** Who a Bearer token speaks for: the token row's user, scope and space restriction. */
export interface ApiCaller {
	tokenId: string;
	userId: string;
	scope: ApiTokenScope;
	restrictedSpaceId: string | null;
}

/** Equal-length strings compared without an early exit (the hashes are hex of the same length). */
export function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * The caller of a raw Bearer token, or null — one answer for an unknown, malformed, revoked or expired token
 * and for a user who is not active. Every input costs the same work: one SHA-256 (of the token, or of an empty
 * string when it cannot be one) and one indexed lookup on the hash; the stored hash is then compared again in
 * constant time. `last_used_at` is touched at most once per API_TOKEN_TOUCH_MS (a guarded UPDATE), never on
 * every request.
 */
export async function resolveApiToken(
	db: Db,
	rawToken: string,
	now: number
): Promise<ApiCaller | null> {
	const candidate =
		rawToken.length <= TOKEN_MAX_LENGTH && API_TOKEN_PATTERN.test(rawToken) ? rawToken : '';
	const hash = await sha256Hex(candidate);
	const found = await db
		.select({
			id: apiTokens.id,
			tokenHash: apiTokens.tokenHash,
			userId: apiTokens.userId,
			scope: apiTokens.scope,
			restrictedSpaceId: apiTokens.restrictedSpaceId,
			expiresAt: apiTokens.expiresAt,
			revokedAt: apiTokens.revokedAt,
			lastUsedAt: apiTokens.lastUsedAt,
			createdAt: apiTokens.createdAt,
			status: users.status
		})
		.from(apiTokens)
		.innerJoin(users, eq(users.id, apiTokens.userId))
		.where(eq(apiTokens.tokenHash, hash))
		.get();
	if (!found || candidate === '' || !constantTimeEqual(found.tokenHash, hash)) return null;
	if (found.revokedAt !== null || found.expiresAt <= now || found.status !== 'active') return null;
	if (now - (found.lastUsedAt ?? 0) >= API_TOKEN_TOUCH_MS)
		await db
			.update(apiTokens)
			.set({ lastUsedAt: now })
			.where(
				and(
					eq(apiTokens.id, found.id),
					liveAt(now),
					or(isNull(apiTokens.lastUsedAt), lte(apiTokens.lastUsedAt, now - API_TOKEN_TOUCH_MS))
				)
			);
	return {
		tokenId: found.id,
		userId: found.userId,
		scope: found.scope,
		restrictedSpaceId: found.restrictedSpaceId
	};
}
