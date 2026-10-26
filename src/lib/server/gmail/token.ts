import { sql } from 'drizzle-orm';
import { RetryLaterError } from '#lib/shared/jobs';
import type { Db } from '../db';
import { gmailClient, type GmailClientEnv } from './config';
import {
	currentTokenKeyId,
	openRefreshToken,
	refreshTokenIsCurrent,
	sealRefreshToken,
	type GmailKeyEnv
} from './crypto';
import type { GoogleClient } from './google';
import { markNeedsReconnect, resealToken, type JobConnection } from './repo';

/**
 * Access tokens of the jobs Worker (FN-19 Gmail PRD § 7.2): obtained from the sealed refresh token, kept only in
 * this isolate's memory for at most 50 minutes, keyed by the connection and the seal's nonce (a reconnect seals a
 * new token, so an old access token is never reused for it), never persisted, logged or queued. `invalid_grant`
 * (revoked at Google, or the 7-day Testing expiry) and an unopenable token both end in `needs_reconnect`: checks
 * stop, nothing retries in a loop.
 */

/** In-memory access tokens of one isolate. */
export type AccessTokenCache = Map<string, { token: string; expiresAt: number }>;

const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;
/** Seconds before a refresh that failed for a transient reason is tried again. */
const REFRESH_RETRY_S = 60;

export interface TokenDeps {
	db: Db;
	env: GmailClientEnv;
	google: GoogleClient;
	tokens: AccessTokenCache;
	now(): number;
}

const cacheKey = (conn: JobConnection) => `${conn.id}:${conn.sealed.nonce}`;

/** Drops the cached access token of `conn` (after a 401). */
export function forgetAccessToken(deps: TokenDeps, conn: JobConnection): void {
	deps.tokens.delete(cacheKey(conn));
}

/**
 * An access token for `conn`, or null when the connection now needs reconnecting (already recorded). Throws
 * RetryLaterError when Google or the network failed for a transient reason, or the client is not configured.
 */
export async function accessTokenFor(deps: TokenDeps, conn: JobConnection): Promise<string | null> {
	const now = deps.now();
	const key = cacheKey(conn);
	const cached = deps.tokens.get(key);
	if (cached && cached.expiresAt > now) return cached.token;
	const client = gmailClient(deps.env);
	if (!client) throw new RetryLaterError('gmail: client not configured', REFRESH_RETRY_S * 5);
	const refreshToken = await openRefreshToken(deps.env, conn.sealed, {
		connectionId: conn.id,
		userId: conn.userId
	});
	if (refreshToken === null) {
		await markNeedsReconnect(deps.db, conn.id, 'key', now);
		return null;
	}
	const grant = await deps.google.refresh({ ...client, refreshToken });
	if (!grant.ok) {
		if (grant.error === 'invalid_grant') {
			await markNeedsReconnect(deps.db, conn.id, 'revoked', now);
			return null;
		}
		throw new RetryLaterError('gmail: token refresh failed', REFRESH_RETRY_S);
	}
	await resealIfPrevious(deps, conn, refreshToken);
	const ttl = Math.min(ACCESS_TOKEN_TTL_MS, Math.max(0, grant.expiresIn * 1000 - 60_000));
	// Only connections still in use are kept: an isolate never grows this past what it is working on.
	for (const [k, v] of deps.tokens) if (v.expiresAt <= now) deps.tokens.delete(k);
	deps.tokens.set(key, { token: grant.accessToken, expiresAt: now + ttl });
	return grant.accessToken;
}

/**
 * Red team L7: a token that opened only with `CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS` is sealed again with the
 * current key after Google accepted it, so removing `_PREVIOUS` later leaves it openable (and revocable). Best
 * effort: a failure here never stops the read; the next refresh tries again.
 */
async function resealIfPrevious(deps: TokenDeps, conn: JobConnection, refreshToken: string) {
	try {
		if (await refreshTokenIsCurrent(deps.env, conn.sealed)) return;
		const binding = { connectionId: conn.id, userId: conn.userId };
		const sealed = await sealRefreshToken(deps.env, refreshToken, binding);
		if (sealed) await resealToken(deps.db, conn.id, conn.sealed.nonce, sealed);
	} catch (e) {
		console.warn('gmail: token re-seal failed', e instanceof Error ? e.name : 'unknown');
	}
}

/** Connections one sweep re-seals at most. */
const GMAIL_RESEAL_BATCH = 100;

/**
 * Red team N4 (cycle 2): the jobs Worker's hourly pass that re-seals, without calling Google, every connection whose
 * refresh token is still sealed under another key: paused, `needs_reconnect` and checks-off connections included,
 * which never refresh. Each one is opened with the current or `_PREVIOUS` key and sealed again with the current
 * one, guarded on the nonce it was read with. Bounded per tick; a token that opens with neither key is left alone
 * (it already reads as `needs_reconnect/key`). Returns how many were re-sealed. Nothing here logs a token.
 */
export async function resealGmailTokens(db: Db, env: GmailKeyEnv | undefined): Promise<number> {
	const current = await currentTokenKeyId(env);
	if (!current) return 0;
	const rows = await db.all<{
		id: string;
		userId: string;
		ciphertext: string;
		nonce: string;
		keyId: string;
	}>(sql`select id, user_id as userId, encrypted_token as ciphertext, token_nonce as nonce,
			token_key_id as keyId
		from gmail_connections where token_key_id <> ${current}
		order by id limit ${GMAIL_RESEAL_BATCH}`);
	let done = 0;
	for (const r of rows) {
		const binding = { connectionId: r.id, userId: r.userId };
		const sealed = { ciphertext: r.ciphertext, nonce: r.nonce, keyId: r.keyId };
		const token = await openRefreshToken(env, sealed, binding);
		if (token === null) continue;
		const fresh = await sealRefreshToken(env, token, binding);
		if (fresh && (await resealToken(db, r.id, r.nonce, fresh))) done++;
	}
	return done;
}
