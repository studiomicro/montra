import type { ConnectedAppProvider } from '../../shared/connected-apps/providers.ts';
import { isSealKeyWellFormed, openValue, sealValue, type Sealed } from '../server-seal.ts';

/**
 * At-rest encryption of connected-app tokens (FN-29): a connected app's token must be usable by unattended jobs,
 * so it is sealed with a server-held key, the Worker secret CONNECTED_APPS_ENCRYPTION_KEY (server-seal.ts:
 * AES-256-GCM, a fresh nonce per seal, `_PREVIOUS` rotation). The associated data binds the key id, row id, space
 * and provider, so a ciphertext copied into another row (or another space, or another provider) fails to open.
 * Unset or malformed key: the feature is "Belum dikonfigurasi" and nothing is sealed. docs/RUNBOOK.md ›
 * Connected apps.
 *
 * Errors never carry the token: an unopenable token is `null`, and nothing here logs.
 */

export interface ConnectedAppsKeyEnv {
	CONNECTED_APPS_ENCRYPTION_KEY?: string;
	CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS?: string;
}

/** A sealed token as stored: `encrypted_token`, `token_nonce`, `token_key_id` (all base64url). */
export type SealedToken = Sealed;

/** The row a token belongs to; bound into the ciphertext as associated data. */
export interface TokenBinding {
	rowId: string;
	spaceId: string;
	provider: ConnectedAppProvider;
}

/** Largest token sealed (UTF-8 bytes); OAuth access and refresh tokens are far smaller. */
export const TOKEN_MAX_BYTES = 8000;
const LABELS = {
	aad: 'financer/connected-apps/token/v1',
	keyId: 'financer/connected-apps/key-id/v1'
};

const keys = (env: ConnectedAppsKeyEnv | undefined) => ({
	current: env?.CONNECTED_APPS_ENCRYPTION_KEY,
	previous: env?.CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS
});
const bound = (b: TokenBinding) => [b.rowId, b.spaceId, b.provider];

/** Usable only with a well-formed current key; otherwise every app reads "Belum dikonfigurasi". */
export function isConnectedAppsConfigured(env: ConnectedAppsKeyEnv | undefined): boolean {
	return isSealKeyWellFormed(env?.CONNECTED_APPS_ENCRYPTION_KEY);
}

/**
 * `plaintext` sealed for the row `binding` with the current key; null when the key is unset or malformed.
 * Throws a RangeError (without the token) for an empty or over-long token.
 */
export function encryptToken(
	env: ConnectedAppsKeyEnv | undefined,
	plaintext: string,
	binding: TokenBinding
): Promise<SealedToken | null> {
	return sealValue(keys(env), LABELS, plaintext, bound(binding), TOKEN_MAX_BYTES);
}

/**
 * The token of `sealed`, opened for the row `binding`, or null (fails closed) when no configured key has its key
 * id, the nonce or ciphertext is malformed, or authentication fails. Never returns a wrong plaintext.
 */
export function decryptToken(
	env: ConnectedAppsKeyEnv | undefined,
	sealed: SealedToken,
	binding: TokenBinding
): Promise<string | null> {
	return openValue(keys(env), LABELS, sealed, bound(binding));
}
