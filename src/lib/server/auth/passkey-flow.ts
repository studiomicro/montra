import { eq } from 'drizzle-orm';
import { base64urlEncode } from '#lib/shared/base64url';
import {
	cleanTransports,
	PASSKEY_ALGORITHMS,
	PASSKEY_CHALLENGE_TTL_MS,
	PASSKEY_MAX_PER_USER,
	PASSKEY_NAME_MAX_LENGTH,
	type PasskeyChallengeKind
} from '#lib/shared/passkeys';
import { cleanText } from '#lib/shared/text';
import type { Db } from '../db';
import { passkeyChallenges } from '../db/schema';
import { textField } from '../forms';
import { newId, sha256Hex } from '../util';
import {
	countLivePasskeys,
	findLivePasskey,
	insertPasskey,
	liveCredentialIds,
	recordAuthEvent,
	sweepExpiredChallenges
} from './passkeys';
import { secureDeployment } from './session';
import { verifyAssertion, verifyRegistration, WEBAUTHN_FIELD_MAX_CHARS } from './webauthn-verify';

/**
 * FN-50 passkey flows: challenge issue and consume, the options the browser gets, and the two verify paths. The
 * route actions own throttling, the password proof and the session cookie; this module owns WebAuthn policy:
 * rpId per host, attestation `none`, ES256/RS256, resident key and user verification `preferred`, one challenge
 * per response, counter rollback refused. Nothing here logs or returns a challenge, credential id or key.
 */

const CHALLENGE_BYTES = 32;
/** Longest value read for a credential id or name field before any work. */
const ID_FIELD_MAX_CHARS = 1400;
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f:]+\]?)$/i;

/** Cloudflare's preview and default Worker hosts: throwaway addresses a credential must never be bound to. */
const THROWAWAY_HOST = /(^|\.)workers\.dev$/;

/**
 * The relying-party id for a request: its host when that is a secure deployment or `localhost` (Owner decision 7);
 * null for an IP literal, a `*.workers.dev` preview or any other loopback name, so a credential is never bound to
 * a throwaway address.
 */
export function passkeyRpId(url: URL): string | null {
	const host = url.hostname.replace(/\.$/, '').toLowerCase();
	if (host === 'localhost') return host;
	if (IP_LITERAL.test(host) || THROWAWAY_HOST.test(host)) return null;
	if (!secureDeployment(host) || !host.includes('.')) return null;
	return host;
}

/** The expected origin of every response: the request's own origin, exactly. */
export const passkeyOrigin = (url: URL) => url.origin;

/**
 * A fresh challenge row of `kind` (32 random bytes, base64url), valid PASSKEY_CHALLENGE_TTL_MS; rows expired for
 * over an hour are swept in the same batch (like `countAttempt`). Returns the row id and the challenge.
 */
export async function issueChallenge(
	db: Db,
	kind: PasskeyChallengeKind,
	userId: string | null,
	now: number
): Promise<{ id: string; challenge: string; expiresAt: number }> {
	const id = newId();
	const challenge = base64urlEncode(crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES)));
	const expiresAt = now + PASSKEY_CHALLENGE_TTL_MS;
	await db.batch([
		sweepExpiredChallenges(db, now),
		db
			.insert(passkeyChallenges)
			.values({ id, challenge, kind, userId, createdAt: now, expiresAt, usedAt: null })
	]);
	return { id, challenge, expiresAt };
}

/** The challenge row a response names (by the challenge in its clientDataJSON), consumed or not; the verify path decides. */
async function challengeRow(db: Db, challenge: string) {
	if (challenge.length < 32 || challenge.length > 64) return undefined;
	return db
		.select({
			id: passkeyChallenges.id,
			kind: passkeyChallenges.kind,
			userId: passkeyChallenges.userId,
			expiresAt: passkeyChallenges.expiresAt,
			usedAt: passkeyChallenges.usedAt
		})
		.from(passkeyChallenges)
		.where(eq(passkeyChallenges.challenge, challenge))
		.get();
}

/** The `challenge` field of a response's clientDataJSON, read before any verification; null when unreadable. */
export function challengeOf(clientDataJSON: string): string | null {
	if (clientDataJSON.length === 0 || clientDataJSON.length > WEBAUTHN_FIELD_MAX_CHARS) return null;
	try {
		const bytes = Uint8Array.from(atob(clientDataJSON.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
			c.charCodeAt(0)
		);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		const challenge = (parsed as { challenge?: unknown } | null)?.challenge;
		return typeof challenge === 'string' ? challenge.replace(/=+$/, '') : null;
	} catch {
		return null;
	}
}

/**
 * An opaque, stable 32-byte user handle (WebAuthn `user.id`): the SHA-256 of a tag and the random account id,
 * so an authenticator sees the same handle for one account (and replaces a credential it already holds) and
 * never the e-mail or the account id itself.
 */
export async function userHandle(userId: string): Promise<string> {
	const hex = await sha256Hex(`passkey-user:${userId}`);
	return base64urlEncode(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))));
}

export type RegistrationOptionsResult =
	| { ok: true; options: Record<string, unknown>; challengeId: string }
	| { ok: false; reason: 'limit' };

/**
 * `PublicKeyCredentialCreationOptions` (JSON, base64url fields) for the signed-in user, after a cap check and a
 * `register` challenge issued to this user. The browser gets the e-mail as `user.name` (it shows it in its own
 * picker), never as the handle.
 */
export async function registrationOptions(
	db: Db,
	user: { id: string; email: string; name: string },
	rpId: string,
	now: number
): Promise<RegistrationOptionsResult> {
	if ((await countLivePasskeys(db, user.id)) >= PASSKEY_MAX_PER_USER)
		return { ok: false, reason: 'limit' };
	const exclude = await liveCredentialIds(db, user.id);
	const issued = await issueChallenge(db, 'register', user.id, now);
	return {
		ok: true,
		challengeId: issued.id,
		options: {
			rp: { id: rpId, name: 'Montra' },
			user: { id: await userHandle(user.id), name: user.email, displayName: user.name },
			challenge: issued.challenge,
			pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
			timeout: PASSKEY_CHALLENGE_TTL_MS,
			attestation: 'none',
			authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
			excludeCredentials: exclude.map((id) => ({ type: 'public-key', id }))
		}
	};
}

/** `PublicKeyCredentialRequestOptions` for a discoverable sign-in: a `sign_in` challenge, no allowed credentials. */
export async function signInOptions(db: Db, rpId: string, now: number) {
	const issued = await issueChallenge(db, 'sign_in', null, now);
	return {
		rpId,
		challenge: issued.challenge,
		timeout: PASSKEY_CHALLENGE_TTL_MS,
		userVerification: 'preferred',
		allowCredentials: []
	};
}

/** The registration fields of a form, each length-capped before any decoding. */
export function readRegistrationForm(form: FormData) {
	return {
		id: textField(form, 'id').slice(0, ID_FIELD_MAX_CHARS),
		attestationObject: textField(form, 'attestationObject').slice(0, WEBAUTHN_FIELD_MAX_CHARS + 1),
		clientDataJSON: textField(form, 'clientDataJSON').slice(0, WEBAUTHN_FIELD_MAX_CHARS + 1),
		transports: cleanTransports(parseJsonArray(textField(form, 'transports').slice(0, 200))),
		name: cleanText(textField(form, 'name'), PASSKEY_NAME_MAX_LENGTH)
	};
}

function parseJsonArray(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return [];
	}
}

export type RegisterResult = { ok: true; passkeyId: string } | { ok: false; reason: string };

/**
 * Verifies a registration response for the signed-in user and writes the passkey: the challenge named by the
 * response must be a live, unused `register` challenge issued to this user; the response must verify against
 * the request's origin and rpId; the insert is guarded (passkeys.ts). `name` falls back to `defaultName`.
 */
export async function verifyRegistrationFor(
	db: Db,
	user: { id: string },
	fields: ReturnType<typeof readRegistrationForm>,
	expected: { origin: string; rpId: string },
	defaultName: string,
	now: number
): Promise<RegisterResult> {
	const challenge = challengeOf(fields.clientDataJSON);
	if (!challenge) return { ok: false, reason: 'challenge' };
	const row = await challengeRow(db, challenge);
	if (!row || row.kind !== 'register' || row.userId !== user.id)
		return { ok: false, reason: 'challenge' };
	if (row.usedAt !== null || row.expiresAt <= now) return { ok: false, reason: 'challenge_spent' };
	const verified = await verifyRegistration(fields, { challenge, ...expected });
	if (!verified.ok) return verified;
	if (verified.credential.credentialId !== fields.id) return { ok: false, reason: 'id_mismatch' };
	let passkeyId: string | null;
	try {
		passkeyId = await insertPasskey(
			db,
			user.id,
			{
				credential: verified.credential,
				name: fields.name || defaultName,
				rpId: expected.rpId,
				transports: fields.transports,
				challengeId: row.id
			},
			now
		);
	} catch {
		// The partial unique index: this credential id is already live (on this or another account).
		return { ok: false, reason: 'duplicate' };
	}
	return passkeyId ? { ok: true, passkeyId } : { ok: false, reason: 'refused' };
}

/** The assertion fields of a form, each length-capped before any decoding. */
export function readAssertionForm(form: FormData) {
	return {
		id: textField(form, 'id').slice(0, ID_FIELD_MAX_CHARS),
		authenticatorData: textField(form, 'authenticatorData').slice(0, WEBAUTHN_FIELD_MAX_CHARS + 1),
		clientDataJSON: textField(form, 'clientDataJSON').slice(0, WEBAUTHN_FIELD_MAX_CHARS + 1),
		signature: textField(form, 'signature').slice(0, WEBAUTHN_FIELD_MAX_CHARS + 1)
	};
}

export type SignInCheck =
	| { ok: true; userId: string; passkeyId: string; challengeId: string; newCounter: number }
	| { ok: false; reason: string };

/**
 * Checks an assertion: a live, unused `sign_in` challenge; a live passkey of this rpId for the credential id; a
 * valid signature; a counter that moved forward (or 0 → 0). A known credential with a bad signature records
 * `passkey_refused`; a rollback records `passkey_counter_rollback` and leaves the passkey usable (Owner decision
 * 12). An unknown or removed credential id gets the same refusal as a bad signature (no oracle). The session is
 * then written by `createPasskeySession`, which consumes the challenge in its batch.
 */
export async function checkSignIn(
	db: Db,
	fields: ReturnType<typeof readAssertionForm>,
	expected: { origin: string; rpId: string },
	now: number
): Promise<SignInCheck> {
	const challenge = challengeOf(fields.clientDataJSON);
	if (!challenge) return { ok: false, reason: 'challenge' };
	const row = await challengeRow(db, challenge);
	if (!row || row.kind !== 'sign_in') return { ok: false, reason: 'challenge' };
	if (row.usedAt !== null || row.expiresAt <= now) return { ok: false, reason: 'challenge_spent' };
	const passkey = await findLivePasskey(db, fields.id, expected.rpId);
	if (!passkey) return { ok: false, reason: 'unknown' };
	const verified = await verifyAssertion(fields, { challenge, ...expected }, passkey.publicKey);
	if (!verified.ok) {
		await recordAuthEvent(db, passkey.userId, 'passkey_refused', passkey.id, now);
		return verified;
	}
	const movesForward =
		verified.counter > passkey.counter || (verified.counter === 0 && passkey.counter === 0);
	if (!movesForward) {
		await recordAuthEvent(db, passkey.userId, 'passkey_counter_rollback', passkey.id, now);
		return { ok: false, reason: 'counter' };
	}
	return {
		ok: true,
		userId: passkey.userId,
		passkeyId: passkey.id,
		challengeId: row.id,
		newCounter: verified.counter
	};
}
