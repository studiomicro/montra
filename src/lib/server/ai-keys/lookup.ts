import type { AiKeyProvider } from '#lib/shared/ai-keys';
import type { Db } from '../db';
import { openAiKey, type AiKeysEnv } from './crypto';
import { getStoredKey } from './repo';

/** An opened key and the row it came from (a test result is recorded against that row only). */
export interface OpenedKey {
	rowId: string;
	key: string;
}

export type OpenResult = OpenedKey | 'missing' | 'unreadable';

/**
 * The user's own key of `provider`, opened: `missing` without a row, `unreadable` when it no longer opens (the
 * encryption secret was changed or removed). Server-only; the key goes straight into a provider call and never
 * into page data, a log line or an export.
 */
export async function openUserKey(
	db: Db,
	userId: string,
	provider: AiKeyProvider,
	env: AiKeysEnv | undefined
): Promise<OpenResult> {
	const stored = await getStoredKey(db, userId, provider);
	if (!stored) return 'missing';
	const key = await openAiKey(env, stored.sealed, { rowId: stored.id, userId, provider });
	return key === null ? 'unreadable' : { rowId: stored.id, key };
}

/**
 * The contract later AI features (FN-15/16/17/19/20/22/23) call first: the user's own decrypted Anthropic key, or
 * null when they have none or it cannot be opened. Never throws, never another user's key, and never a fallback
 * to an app-wide key (there is none: BYOK, owner decision 2026-10-09). On null the caller shows "Tambahkan kunci
 * Anthropic di Pengaturan › Integrasi AI" with a link to /pengaturan/integrasi.
 */
export async function resolveAnthropicKey(
	db: Db,
	userId: string,
	env: AiKeysEnv | undefined
): Promise<string | null> {
	try {
		const opened = await openUserKey(db, userId, 'anthropic', env);
		return typeof opened === 'string' ? null : opened.key;
	} catch {
		return null;
	}
}
