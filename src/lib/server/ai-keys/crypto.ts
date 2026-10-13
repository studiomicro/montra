import { AI_KEY_MAX_LENGTH, type AiKeyProvider } from '../../shared/ai-keys.ts';
import { isSealKeyWellFormed, openValue, sealValue, type Sealed } from '../server-seal.ts';

/**
 * At-rest encryption of personal AI keys (FN-41). A later AI feature may run unattended (an hourly Gmail check),
 * so the key is sealed with a server-held secret, AI_KEYS_ENCRYPTION_KEY, exactly like FN-29's connected-app
 * tokens (server-seal.ts: AES-256-GCM, a fresh 96-bit nonce per seal, `_PREVIOUS` rotation) but with its own
 * secret (owner decision 2: one leak never opens both) and its own labels. The associated data binds the key id,
 * row id, user and provider, so a ciphertext copied into another row or to another user fails to open. Unset or
 * malformed key: "Belum dikonfigurasi" and nothing is stored. docs/RUNBOOK.md › AI keys.
 *
 * Errors never carry the key: an unopenable key is `null`, and nothing here logs.
 */

export interface AiKeysEnv {
	AI_KEYS_ENCRYPTION_KEY?: string;
	AI_KEYS_ENCRYPTION_KEY_PREVIOUS?: string;
}

/** The row a key belongs to; bound into the ciphertext as associated data. */
export interface AiKeyBinding {
	rowId: string;
	userId: string;
	provider: AiKeyProvider;
}

const LABELS = { aad: 'financer/ai-keys/key/v1', keyId: 'financer/ai-keys/key-id/v1' };

const keys = (env: AiKeysEnv | undefined) => ({
	current: env?.AI_KEYS_ENCRYPTION_KEY,
	previous: env?.AI_KEYS_ENCRYPTION_KEY_PREVIOUS
});
const bound = (b: AiKeyBinding) => [b.rowId, b.userId, b.provider];

/** Keys can be stored only with a well-formed current secret. */
export function isAiKeysConfigured(env: AiKeysEnv | undefined): boolean {
	return isSealKeyWellFormed(env?.AI_KEYS_ENCRYPTION_KEY);
}

/** `rawKey` sealed for `binding`; null without a configured secret. RangeError for an empty or over-long key. */
export function sealAiKey(
	env: AiKeysEnv | undefined,
	rawKey: string,
	binding: AiKeyBinding
): Promise<Sealed | null> {
	return sealValue(keys(env), LABELS, rawKey, bound(binding), AI_KEY_MAX_LENGTH);
}

/** The key of `sealed` for `binding`, or null (fails closed); never a wrong plaintext. */
export function openAiKey(
	env: AiKeysEnv | undefined,
	sealed: Sealed,
	binding: AiKeyBinding
): Promise<string | null> {
	return openValue(keys(env), LABELS, sealed, bound(binding));
}
