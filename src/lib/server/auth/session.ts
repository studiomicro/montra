import type { Cookies } from '@sveltejs/kit';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
	authEvents,
	passkeyChallenges,
	passkeySessions,
	passkeys,
	sessions,
	userPasswords,
	users
} from '../db/schema';
import { removeSessionSubscriptions } from '../push/repo';
import { newId, randomToken, sha256Hex } from '../util';

/**
 * Sessions, ported from the earlier project (`src/lib/server/auth/session.ts`) without passkeys, MFA and the idle limit.
 * Owner decision A (2026-10-07): 30-day absolute lifetime, no idle sign-out; `last_seen_at` is kept for
 * later analytics only, never for revocation.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most once per this interval (a guarded UPDATE), not on every request. */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;

/**
 * The cookie's base name. A secure deployment uses `__Host-financer_session`: the browser refuses it unless
 * it is Secure, Path=/ and has no Domain, so no subdomain or plain-http origin can plant one. Local dev over
 * `http://` cannot set a `__Host-` cookie, so there the name is plain.
 */
export const SESSION_COOKIE = 'financer_session';
export const sessionCookieName = (secure: boolean) => hostCookieName(SESSION_COOKIE, secure);

/**
 * The name of any first-party cookie of ours: `__Host-<base>` on a secure deployment (the browser then
 * refuses it unless Secure, Path=/ and without Domain, so no sibling subdomain can plant it), else `<base>`.
 */
export const hostCookieName = (base: string, secure: boolean) => (secure ? `__Host-${base}` : base);

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1|.+\.localhost)$/i;

/**
 * Whether this host is a deployment served over HTTPS. Decided by the host name, never the request's
 * scheme: every Cloudflare-served host is HTTPS (a plain-http request is redirected by the hook before any
 * cookie is read); only loopback names (`localhost`, `*.localhost`, 127.0.0.1, ::1) are local dev.
 * Kit 3's adapter passes no `platform`, so an env flag is not used here.
 */
export function secureDeployment(hostname: string): boolean {
	return !LOCAL_HOST.test(hostname.replace(/\.$/, ''));
}

export type SessionUser = Pick<typeof users.$inferSelect, 'id' | 'email' | 'name' | 'createdAt'>;

/** A new session's row and token: only the cookie carries the token, D1 its hash. */
export async function newSession(userId: string, now: number) {
	const token = randomToken(32);
	const row = {
		id: newId(),
		tokenHash: await sha256Hex(token),
		userId,
		createdAt: now,
		expiresAt: now + SESSION_TTL_MS,
		revokedAt: null,
		lastSeenAt: now
	};
	return { token, row };
}

/**
 * The session of a password sign-in, written only while the account's password is still the one the
 * sign-in checked (INSERT … SELECT … WHERE hash = ?): an account deleted, or a password changed, between the
 * check and this write gets no session. `last_login_at` is updated in the same batch. Null when refused.
 */
export async function createPasswordSession(db: Db, userId: string, hash: string, now: number) {
	const { token, row } = await newSession(userId, now);
	const [written] = await db.batch([
		db
			.insert(sessions)
			.select((qb) =>
				qb
					.select({
						id: sql`${row.id}`.as('id'),
						tokenHash: sql`${row.tokenHash}`.as('token_hash'),
						userId: userPasswords.userId,
						createdAt: sql`${row.createdAt}`.as('created_at'),
						expiresAt: sql`${row.expiresAt}`.as('expires_at'),
						revokedAt: sql`null`.as('revoked_at'),
						lastSeenAt: sql`${row.lastSeenAt}`.as('last_seen_at')
					})
					.from(userPasswords)
					.where(and(eq(userPasswords.userId, userId), eq(userPasswords.hash, hash)))
			)
			.returning({ id: sessions.id }),
		db
			.update(users)
			.set({ lastLoginAt: now })
			.where(
				and(
					eq(users.id, userId),
					sql`exists (select 1 from ${sessions} where ${sessions.id} = ${row.id})`
				)
			)
	]);
	return written.length ? { token, expiresAt: row.expiresAt } : null;
}

/** What a verified passkey assertion hands the session writer (FN-50). */
export interface PasskeySignIn {
	userId: string;
	passkeyId: string;
	/** The `passkey_challenges.id` the assertion answered; consumed in the same batch. */
	challengeId: string;
	/** The signature counter the authenticator reported (already checked for rollback by the caller). */
	newCounter: number;
}

/**
 * The session of a passkey sign-in (FN-50), one `db.batch` (one D1 transaction) of guarded statements:
 *
 * 1. the challenge is consumed (`used_at is null and expires_at > now`), so one assertion is accepted once;
 * 2. the passkey's counter and `last_used_at` are written, only while the row is live, the user `active`, the
 *    challenge was consumed here (`used_by` = this session's id) and the counter moves forward (or stays 0 for an
 *    authenticator that never counts);
 * 3. the session is written only while the challenge was consumed here, the passkey row is live and carries this
 *    request's counter and `last_used_at`, and the user is `active` (INSERT … SELECT);
 * 4. `last_login_at` is updated, the session is linked to its passkey (`passkey_sessions`) and a
 *    `passkey_sign_in` event is recorded, only when the session was written.
 *
 * Of N concurrent posts of the same assertion exactly one gets a session. Null when refused.
 */
export async function createPasskeySession(db: Db, signIn: PasskeySignIn, now: number) {
	const { token, row } = await newSession(signIn.userId, now);
	// "This request consumed the challenge": `used_by` is this session's own id, set by statement 1 only.
	const consumed = sql`exists (select 1 from ${passkeyChallenges} where ${passkeyChallenges.id} = ${signIn.challengeId}
		and ${passkeyChallenges.usedBy} = ${row.id})`;
	const sessionWritten = sql`exists (select 1 from ${sessions} where ${sessions.id} = ${row.id})`;
	const results = await db.batch([
		db
			.update(passkeyChallenges)
			.set({ usedAt: now, usedBy: row.id })
			.where(
				and(
					eq(passkeyChallenges.id, signIn.challengeId),
					eq(passkeyChallenges.kind, 'sign_in'),
					isNull(passkeyChallenges.usedAt),
					sql`${passkeyChallenges.expiresAt} > ${now}`
				)
			),
		db
			.update(passkeys)
			.set({ counter: signIn.newCounter, lastUsedAt: now, updatedAt: now })
			.where(
				and(
					eq(passkeys.id, signIn.passkeyId),
					eq(passkeys.userId, signIn.userId),
					isNull(passkeys.deletedAt),
					sql`(${passkeys.counter} < ${signIn.newCounter} or (${passkeys.counter} = 0 and ${signIn.newCounter} = 0))`,
					sql`exists (select 1 from ${users} where ${users.id} = ${signIn.userId} and ${users.status} = 'active')`,
					consumed
				)
			),
		db
			.insert(sessions)
			.select((qb) =>
				qb
					.select({
						id: sql`${row.id}`.as('id'),
						tokenHash: sql`${row.tokenHash}`.as('token_hash'),
						userId: users.id,
						createdAt: sql`${row.createdAt}`.as('created_at'),
						expiresAt: sql`${row.expiresAt}`.as('expires_at'),
						revokedAt: sql`null`.as('revoked_at'),
						lastSeenAt: sql`${row.lastSeenAt}`.as('last_seen_at')
					})
					.from(users)
					.where(
						and(
							eq(users.id, signIn.userId),
							eq(users.status, 'active'),
							consumed,
							sql`exists (select 1 from ${passkeys} where ${passkeys.id} = ${signIn.passkeyId}
								and ${passkeys.userId} = ${signIn.userId} and ${passkeys.deletedAt} is null
								and ${passkeys.counter} = ${signIn.newCounter} and ${passkeys.lastUsedAt} = ${now})`
						)
					)
			)
			.returning({ id: sessions.id }),
		db
			.update(users)
			.set({ lastLoginAt: now })
			.where(and(eq(users.id, signIn.userId), sessionWritten)),
		db.insert(passkeySessions).select((qb) =>
			qb
				.select({
					sessionId: sql`${row.id}`.as('session_id'),
					userId: sql`${signIn.userId}`.as('user_id'),
					passkeyId: sql`${signIn.passkeyId}`.as('passkey_id'),
					createdAt: sql`${now}`.as('created_at')
				})
				.from(sql`(select 1)`)
				.where(sessionWritten)
		),
		db.insert(authEvents).select((qb) =>
			qb
				.select({
					id: sql`${newId()}`.as('id'),
					userId: sql`${signIn.userId}`.as('user_id'),
					kind: sql`'passkey_sign_in'`.as('kind'),
					passkeyId: sql`${signIn.passkeyId}`.as('passkey_id'),
					createdAt: sql`${now}`.as('created_at')
				})
				.from(sql`(select 1)`)
				.where(sessionWritten)
		)
	]);
	const written = results[2] as { id: string }[];
	return written.length ? { token, expiresAt: row.expiresAt } : null;
}

/**
 * The signed-in user of `token`, or null when the session is unknown, revoked, expired or its user is not
 * active. One indexed lookup on the token hash; `last_seen_at` is touched at most once per SESSION_TOUCH_MS.
 */
export async function resolveSession(
	db: Db,
	token: string,
	now: number
): Promise<SessionUser | null> {
	const found = await db
		.select({
			sessionId: sessions.id,
			expiresAt: sessions.expiresAt,
			revokedAt: sessions.revokedAt,
			lastSeenAt: sessions.lastSeenAt,
			createdAt: sessions.createdAt,
			user: {
				id: users.id,
				email: users.email,
				name: users.name,
				createdAt: users.createdAt,
				status: users.status
			}
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.tokenHash, await sha256Hex(token)))
		.get();
	if (!found || found.revokedAt !== null || found.expiresAt <= now) return null;
	if (found.user.status !== 'active') return null;
	if (now - (found.lastSeenAt ?? found.createdAt) >= SESSION_TOUCH_MS)
		await db
			.update(sessions)
			.set({ lastSeenAt: now })
			.where(
				and(
					eq(sessions.id, found.sessionId),
					isNull(sessions.revokedAt),
					lte(sql`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt})`, now - SESSION_TOUCH_MS)
				)
			);
	const { id, email, name, createdAt } = found.user;
	return { id, email, name, createdAt };
}

/**
 * Revokes the one session `token` names (sign-out on this device); other devices stay signed in. The push
 * subscriptions this session made (FN-13) are tombstoned in the same batch: a signed-out device gets no
 * more notifications for that account.
 */
export async function revokeSession(db: Db, token: string, now: number) {
	const tokenHash = await sha256Hex(token);
	const [revoked] = await db.batch([
		db
			.update(sessions)
			.set({ revokedAt: now })
			.where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
			.returning({ id: sessions.id }),
		removeSessionSubscriptions(db, tokenHash, now)
	]);
	return revoked.length;
}

const cookieOptions = (secure: boolean) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	secure
});

export function setSessionCookie(
	cookies: Cookies,
	token: string,
	expiresAt: number,
	secure: boolean
) {
	cookies.set(sessionCookieName(secure), token, {
		...cookieOptions(secure),
		expires: new Date(expiresAt)
	});
}

/** Clears the cookie; returns the `Set-Cookie` value for responses built outside `resolve()`. */
export function clearSessionCookie(cookies: Cookies, secure: boolean): string {
	const options = { ...cookieOptions(secure), maxAge: 0 };
	const name = sessionCookieName(secure);
	cookies.delete(name, options);
	return cookies.serialize(name, '', options);
}
