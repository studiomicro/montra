import {
	currentKeyId,
	openValue,
	sealedWithCurrentKey,
	sealValue,
	type Sealed
} from '../server-seal.ts';

/**
 * FN-19 Gmail sealing (PRD § 10): the refresh token and the PKCE verifier, sealed with the connected-apps key
 * (CONNECTED_APPS_ENCRYPTION_KEY, `_PREVIOUS` during a rotation; owner decision 3) under Gmail's OWN labels, so a
 * connected-app ciphertext never opens as a Gmail one or the reverse. The token is bound to its connection and
 * user, the verifier to its state hash: a ciphertext copied into another row fails to open. Unopenable → null
 * (the caller marks the connection `needs_reconnect`), never a crash and never a wrong value. Nothing here logs.
 */

export interface GmailKeyEnv {
	CONNECTED_APPS_ENCRYPTION_KEY?: string;
	CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS?: string;
}

/** Largest refresh token sealed (UTF-8 bytes); Google's are a few hundred. */
export const REFRESH_TOKEN_MAX_BYTES = 4000;
const VERIFIER_MAX_BYTES = 128;

const TOKEN_LABELS = { aad: 'financer/gmail/token/v1', keyId: 'financer/gmail/key-id/v1' };
const VERIFIER_LABELS = { aad: 'financer/gmail/verifier/v1', keyId: 'financer/gmail/key-id/v1' };

const keys = (env: GmailKeyEnv | undefined) => ({
	current: env?.CONNECTED_APPS_ENCRYPTION_KEY,
	previous: env?.CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS
});

export interface TokenBinding {
	connectionId: string;
	userId: string;
}

export function sealRefreshToken(
	env: GmailKeyEnv | undefined,
	token: string,
	b: TokenBinding
): Promise<Sealed | null> {
	return sealValue(
		keys(env),
		TOKEN_LABELS,
		token,
		[b.connectionId, b.userId],
		REFRESH_TOKEN_MAX_BYTES
	);
}

export async function openRefreshToken(
	env: GmailKeyEnv | undefined,
	sealed: Sealed,
	b: TokenBinding
): Promise<string | null> {
	try {
		return await openValue(keys(env), TOKEN_LABELS, sealed, [b.connectionId, b.userId]);
	} catch {
		return null;
	}
}

/** False when the token opens only with `_PREVIOUS` (red team L7: re-seal it on its next successful use). */
export function refreshTokenIsCurrent(
	env: GmailKeyEnv | undefined,
	sealed: Sealed
): Promise<boolean> {
	return sealedWithCurrentKey(keys(env), TOKEN_LABELS, sealed);
}

/** The key id new refresh-token seals carry, or null when the key is unset or malformed. */
export function currentTokenKeyId(env: GmailKeyEnv | undefined): Promise<string | null> {
	return currentKeyId(keys(env), TOKEN_LABELS);
}

export function sealVerifier(
	env: GmailKeyEnv | undefined,
	verifier: string,
	stateHash: string
): Promise<Sealed | null> {
	return sealValue(keys(env), VERIFIER_LABELS, verifier, [stateHash], VERIFIER_MAX_BYTES);
}

export async function openVerifier(
	env: GmailKeyEnv | undefined,
	sealed: Sealed,
	stateHash: string
): Promise<string | null> {
	try {
		return await openValue(keys(env), VERIFIER_LABELS, sealed, [stateHash]);
	} catch {
		return null;
	}
}
