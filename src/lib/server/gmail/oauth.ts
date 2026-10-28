import { and, eq, gt, sql } from 'drizzle-orm';
import { base64urlEncode } from '#lib/shared/base64url';
import {
	GMAIL_FIRST_CHECK_S,
	OAUTH_STATE_TTL_MS,
	OAUTH_STATES_PER_USER
} from '#lib/shared/gmail/ledger';
import type { Db } from '../db';
import { gmailConnections, gmailRevocations, oauthStates } from '../db/schema';
import { isSealKeyWellFormed } from '../server-seal';
import { newId, randomToken, sha256Hex } from '../util';
import type { GmailOAuthConfig } from './config';
import {
	openRefreshToken,
	openVerifier,
	sealRefreshToken,
	sealVerifier,
	type GmailKeyEnv
} from './crypto';
import { GMAIL_SCOPE, GOOGLE_AUTH_URL, type GoogleClient } from './google';
import { liveMemberOf, queueGmailRevocations, sealedTokenOf } from './repo';

/**
 * The FN-19 Gmail connect flow (PRD § 3): OAuth 2.0 authorization code with PKCE (S256) and a single-use state
 * bound to the user AND the session that started it. Only the state's SHA-256 is stored; the verifier is sealed;
 * the access token lives in memory for one request; the refresh token is sealed before it is written. Nothing
 * from the user ever goes into the authorization URL, and the redirect URI is the configured one only.
 */

/** BASE64URL(SHA-256(verifier)), the S256 code challenge. */
export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64urlEncode(digest);
}

/** The authorization URL: exactly the parameters Google's web-server flow needs, nothing from the request. */
export function authorizationUrl(cfg: GmailOAuthConfig, state: string, challenge: string): string {
	const params = new URLSearchParams({
		client_id: cfg.clientId,
		redirect_uri: cfg.redirectUri,
		response_type: 'code',
		scope: GMAIL_SCOPE,
		access_type: 'offline',
		prompt: 'consent',
		state,
		code_challenge: challenge,
		code_challenge_method: 'S256'
	});
	return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type StartResult = { kind: 'ok'; url: string } | { kind: 'space' | 'key' };

/**
 * "Hubungkan": a fresh state (32 random bytes) and verifier (48 random bytes, 64 characters of the PKCE
 * alphabet), the state row written while `spaceId` is a live membership of the user, at most
 * OAUTH_STATES_PER_USER live rows kept (older and expired ones are dropped in the same batch).
 */
export async function startGmailConnect(
	db: Db,
	env: GmailKeyEnv,
	cfg: GmailOAuthConfig,
	input: { userId: string; sessionToken: string; spaceId: string },
	now: number
): Promise<StartResult> {
	const state = randomToken(32);
	const verifier = randomToken(48);
	const stateHash = await sha256Hex(state);
	const sealed = await sealVerifier(env, verifier, stateHash);
	if (!sealed) return { kind: 'key' };
	const sessionHash = await sha256Hex(input.sessionToken);
	const keep = OAUTH_STATES_PER_USER - 1;
	const [, inserted] = await db.batch([
		db.delete(oauthStates).where(
			and(
				eq(oauthStates.userId, input.userId),
				sql`${oauthStates.stateHash} not in (select x.state_hash from oauth_states x
					where x.user_id = ${input.userId} and x.expires_at > ${now}
					order by x.created_at desc limit ${keep})`
			)
		),
		// Columns in table order: state_hash, user_id, session_hash, space_id, purpose, ciphertext, nonce, key_id,
		// created_at, expires_at.
		db
			.insert(oauthStates)
			.select(
				sql`select ${stateHash}, ${input.userId}, ${sessionHash}, ${input.spaceId}, 'gmail',
					${sealed.ciphertext}, ${sealed.nonce}, ${sealed.keyId}, ${now}, ${now + OAUTH_STATE_TTL_MS}
				where ${liveMemberOf(sql`${input.spaceId}`, sql`${input.userId}`)}`
			)
			.returning({ stateHash: oauthStates.stateHash })
	]);
	if (inserted.length !== 1) return { kind: 'space' };
	return { kind: 'ok', url: authorizationUrl(cfg, state, await pkceChallenge(verifier)) };
}

/**
 * The callback's state, consumed: deleted in the statement that reads it, only while it is the session user's,
 * of this very session, and not expired. Anything else (unknown, replayed, expired, another user's or another
 * session's) is null, the same answer for all. Returns the target space and the opened verifier.
 */
export async function consumeState(
	db: Db,
	env: GmailKeyEnv,
	input: { state: string; userId: string; sessionToken: string },
	now: number
): Promise<{ spaceId: string; verifier: string } | null> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) return null;
	const stateHash = await sha256Hex(input.state);
	const [row] = await db
		.delete(oauthStates)
		.where(
			and(
				eq(oauthStates.stateHash, stateHash),
				eq(oauthStates.userId, input.userId),
				eq(oauthStates.sessionHash, await sha256Hex(input.sessionToken)),
				gt(oauthStates.expiresAt, now)
			)
		)
		.returning({
			spaceId: oauthStates.spaceId,
			ciphertext: oauthStates.ciphertext,
			nonce: oauthStates.nonce,
			keyId: oauthStates.keyId
		});
	if (!row) return null;
	const verifier = await openVerifier(env, row, stateHash);
	return verifier ? { spaceId: row.spaceId, verifier } : null;
}

export type CompleteResult = 'connected' | 'scope' | 'failed';

/**
 * Exchanges the code (verifier and client secret both sent), requires a refresh token and `gmail.readonly` in the
 * granted scope (granular consent can leave it unticked: then whatever was issued is revoked and nothing stored),
 * reads the mailbox address, seals the refresh token and writes the connection in one guarded statement (the
 * target space still a live membership). A reconnect replaces the token on the same row and keeps its history.
 */
export async function completeGmailConnect(
	db: Db,
	env: GmailKeyEnv,
	cfg: GmailOAuthConfig,
	google: GoogleClient,
	input: { userId: string; spaceId: string; code: string; verifier: string },
	now: number
): Promise<CompleteResult> {
	const grant = await google.exchangeCode({
		clientId: cfg.clientId,
		clientSecret: cfg.clientSecret,
		code: input.code,
		verifier: input.verifier,
		redirectUri: cfg.redirectUri
	});
	if (!grant.ok) return 'failed';
	const scopes = grant.scope.split(/\s+/);
	if (!grant.refreshToken || !scopes.includes(GMAIL_SCOPE)) {
		await google.revoke(grant.refreshToken ?? grant.accessToken);
		return 'scope';
	}
	const profile = await google.profile(grant.accessToken);
	const address = profile.ok ? profile.address : null;
	const existing = await db.get<{ id: string }>(
		sql`select id from gmail_connections where user_id = ${input.userId}`
	);
	const id = existing?.id ?? newId();
	const sealed = await sealRefreshToken(env, grant.refreshToken, {
		connectionId: id,
		userId: input.userId
	});
	if (!sealed) return 'failed';
	const firstCheck = Math.floor(now / 1000) - GMAIL_FIRST_CHECK_S;
	// Red team L4: a second authorization (another tab) for ANOTHER Google account replaces the stored token; the
	// replaced grant is queued for the jobs Worker to revoke, in the same batch. The same account is one grant at
	// Google (revoking the old token would end the new one), and an unknown address cannot be told apart: neither is
	// queued. The Worker re-checks against the row that is current when it runs.
	const replaced = queueGmailRevocations(
		db,
		sql`${gmailConnections.userId} = ${input.userId} and ${gmailConnections.googleAddress} is not null
			and ${address} is not null and lower(${gmailConnections.googleAddress}) <> lower(${address})`,
		now
	);
	// Columns in table order: id, user_id, space_id, status, reconnect_reason, paused_reason, google_address,
	// encrypted_token, token_nonce, token_key_id, scope, auto_check, checked_through, check_after,
	// quota_window_start, quota_units, last_checked_at, created_at, updated_at, ai_window_start, ai_reads,
	// auto_save, auto_save_wallet_id, auto_save_day, auto_saves (FN-19b: off on a new connection; a reconnect keeps
	// the user's choice).
	const upsert = db
		.insert(gmailConnections)
		.select(
			sql`select ${id}, ${input.userId}, ${input.spaceId}, 'connected', null, null, ${address},
				${sealed.ciphertext}, ${sealed.nonce}, ${sealed.keyId}, ${grant.scope.slice(0, 2000)}, 1,
				${firstCheck}, 0, 0, 0, null, ${now}, ${now}, 0, 0, 0, null, null, 0
			where ${liveMemberOf(sql`${input.spaceId}`, sql`${input.userId}`)}`
		)
		.onConflictDoUpdate({
			target: gmailConnections.userId,
			set: {
				spaceId: sql`excluded.space_id`,
				status: 'connected',
				reconnectReason: null,
				pausedReason: null,
				// As read now: an unknown address never shows the previous mailbox's (red team L4).
				googleAddress: sql`excluded.google_address`,
				encryptedToken: sql`excluded.encrypted_token`,
				tokenNonce: sql`excluded.token_nonce`,
				tokenKeyId: sql`excluded.token_key_id`,
				scope: sql`excluded.scope`,
				autoCheck: 1,
				checkAfter: 0,
				updatedAt: now
			},
			// The token was sealed for this row id: a row created meanwhile under another id is left alone.
			setWhere: sql`${gmailConnections.id} = excluded.id`
		})
		.returning({ id: gmailConnections.id });
	const [, written] = await db.batch([replaced, upsert]);
	// Not written (the space was left meanwhile, or a concurrent connect won): nothing is stored. No revoke here:
	// revoking removes every grant of this app for the user, including a connection that already works.
	return written.length === 1 ? 'connected' : 'failed';
}

/**
 * Revokes the user's Gmail refresh token at Google (disconnect and account deletion, PRD § 8), best effort: true
 * only when Google confirmed (200, or 400 `invalid_token` = already revoked). Never throws; a token that no longer
 * opens cannot be revoked (false: the page tells the user to revoke at Google).
 */
export async function revokeGmailToken(
	db: Db,
	env: GmailKeyEnv,
	google: GoogleClient,
	userId: string
): Promise<boolean> {
	try {
		const stored = await sealedTokenOf(db, userId);
		if (!stored) return false;
		const token = await openRefreshToken(env, stored.sealed, { connectionId: stored.id, userId });
		return token !== null && (await google.revoke(token));
	} catch {
		return false;
	}
}

/** Rows of `gmail_revocations` one jobs tick works on (each is one call to Google). */
const GMAIL_REVOKE_BATCH = 20;
/** Tries per queued grant (hourly ticks, about three days) before it is dropped. */
const GMAIL_REVOKE_ATTEMPTS = 48;
/** A queued grant older than this is dropped whatever happened (key missing, Google down): no sealed token lingers. */
const GMAIL_REVOKE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GmailRevocationRun {
	revoked: number;
	dropped: number;
	retried: number;
}

/**
 * The jobs Worker's revocation queue (red team L3/L4), one bounded batch per tick, fewest tries first (a Google
 * outage never holds newer rows back). Each queued grant is revoked at Google with its own sealed token, then
 * deleted. It is dropped without a call while the user's current connection, read right before the call, may hold
 * the same Google grant (same mailbox address, either address unknown, or the very token): Google ends every token
 * of a grant on revoke, so the call would end the working connection too. A token that no longer opens (key rotated
 * away, L7) is dropped. A failed call is retried on the next tick, at most GMAIL_REVOKE_ATTEMPTS times; rows older
 * than GMAIL_REVOKE_MAX_AGE_MS are dropped first, key or no key. Never throws for one row.
 */
export async function processGmailRevocations(
	db: Db,
	env: GmailKeyEnv,
	google: GoogleClient,
	now: number
): Promise<GmailRevocationRun> {
	const run: GmailRevocationRun = { revoked: 0, dropped: 0, retried: 0 };
	const aged = await db
		.delete(gmailRevocations)
		.where(
			sql`(${gmailRevocations.connectionId}, ${gmailRevocations.tokenNonce}) in (select connection_id,
				token_nonce from gmail_revocations where created_at < ${now - GMAIL_REVOKE_MAX_AGE_MS}
				order by created_at limit ${GMAIL_REVOKE_BATCH})`
		)
		.returning({ id: gmailRevocations.connectionId });
	run.dropped += aged.length;
	// Without the key nothing opens: the queue waits (up to the age cap) instead of dropping every grant.
	if (!isSealKeyWellFormed(env.CONNECTED_APPS_ENCRYPTION_KEY)) return run;
	const rows = await db
		.select({
			connectionId: gmailRevocations.connectionId,
			tokenNonce: gmailRevocations.tokenNonce,
			userId: gmailRevocations.userId,
			address: gmailRevocations.googleAddress,
			ciphertext: gmailRevocations.encryptedToken,
			keyId: gmailRevocations.tokenKeyId,
			attempts: gmailRevocations.attempts
		})
		.from(gmailRevocations)
		.where(sql`${gmailRevocations.createdAt} <= ${now}`)
		.orderBy(gmailRevocations.attempts, gmailRevocations.createdAt)
		.limit(GMAIL_REVOKE_BATCH);
	for (const row of rows) {
		const key = and(
			eq(gmailRevocations.connectionId, row.connectionId),
			eq(gmailRevocations.tokenNonce, row.tokenNonce)
		);
		const current = await db.get<{ address: string | null; nonce: string }>(
			sql`select google_address as address, token_nonce as nonce from gmail_connections
				where user_id = ${row.userId}`
		);
		const sameGrant =
			current != null &&
			(current.nonce === row.tokenNonce ||
				row.address === null ||
				current.address === null ||
				row.address.toLowerCase() === current.address.toLowerCase());
		let revoked = false;
		let done = true;
		if (!sameGrant) {
			try {
				const token = await openRefreshToken(
					env,
					{ ciphertext: row.ciphertext, nonce: row.tokenNonce, keyId: row.keyId },
					{ connectionId: row.connectionId, userId: row.userId }
				);
				if (token !== null) done = revoked = await google.revoke(token);
			} catch {
				done = false;
			}
		}
		if (done || row.attempts + 1 >= GMAIL_REVOKE_ATTEMPTS) {
			await db.delete(gmailRevocations).where(key);
			if (revoked) run.revoked++;
			else run.dropped++;
		} else {
			await db
				.update(gmailRevocations)
				.set({ attempts: sql`${gmailRevocations.attempts} + 1` })
				.where(key);
			run.retried++;
		}
	}
	return run;
}
