import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
	AI_KEY_PROVIDERS,
	type AiKeyAuditAction,
	type AiKeyProvider,
	type AiKeyTestOutcome,
	type AiKeyView
} from '#lib/shared/ai-keys';
import type { Db } from '../db';
import { aiKeyAudit, aiKeys } from '../db/schema';
import type { Sealed } from '../server-seal';
import { newId } from '../util';
import { sealAiKey, type AiKeysEnv } from './crypto';

// FN-41. Every function works on one (user, provider) pair; the user id is always the session's (locals.user.id),
// never a row id from a form, so there is nothing of another user's to address. Each write and its content-free
// audit row are one `db.batch` (one D1 transaction): no change without exactly one audit row. Key material is
// never selected for a page (listKeysForDisplay); only getStoredKey reads it, for the one server function that is
// about to open it (lookup.ts).

/** The stored key of a row, sealed, with the row id it is bound to. */
export interface StoredKey {
	id: string;
	sealed: Sealed;
}

/** This user's keys as a page may show them: provider, last four, dates and the last test. Never key material. */
export async function listKeysForDisplay(db: Db, userId: string): Promise<AiKeyView[]> {
	return db
		.select({
			provider: aiKeys.provider,
			lastFour: aiKeys.lastFour,
			createdAt: aiKeys.createdAt,
			updatedAt: aiKeys.updatedAt,
			lastTestedAt: aiKeys.lastTestedAt,
			lastTestResult: aiKeys.lastTestResult
		})
		.from(aiKeys)
		.where(eq(aiKeys.userId, userId))
		.orderBy(aiKeys.provider)
		.limit(AI_KEY_PROVIDERS.length);
}

/** The sealed key of (user, provider), or null. Only for a caller that is about to open it server-side. */
export async function getStoredKey(
	db: Db,
	userId: string,
	provider: AiKeyProvider
): Promise<StoredKey | null> {
	const [row] = await db
		.select({
			id: aiKeys.id,
			ciphertext: aiKeys.encryptedKey,
			nonce: aiKeys.keyNonce,
			keyId: aiKeys.keyKeyId
		})
		.from(aiKeys)
		.where(and(eq(aiKeys.userId, userId), eq(aiKeys.provider, provider)))
		.limit(1);
	if (!row) return null;
	const { id, ...sealed } = row;
	return { id, sealed };
}

/** Batch item: one `action` audit row for the key row matching `row`, written only while that row exists. */
function auditKeyRow(db: Db, action: AiKeyAuditAction, row: SQL | undefined, now: number) {
	return db.insert(aiKeyAudit).select((qb) =>
		qb
			.select({
				id: sql`${newId()}`.as('id'),
				userId: aiKeys.userId,
				action: sql`${action}`.as('action'),
				createdAt: sql`${now}`.as('created_at')
			})
			.from(aiKeys)
			.where(row)
	);
}

export type SaveResult = 'created' | 'replaced' | 'not_configured';

/**
 * Adds or replaces ("Ganti kunci") the key of (user, provider): one guarded upsert, never a read-then-write, so
 * concurrent saves end in one row holding the last write. A replace takes a new row id (the ciphertext is bound
 * to it), keeps `created_at`, and clears the test state (a new key has not been tested). The audit row says
 * `created` or `replaced`, decided inside the same transaction. `not_configured` writes nothing.
 * `rawKey` must already have passed parseAiKey.
 */
export async function saveKey(
	db: Db,
	userId: string,
	provider: AiKeyProvider,
	rawKey: string,
	env: AiKeysEnv | undefined,
	now: number
): Promise<SaveResult> {
	const id = newId();
	const sealed = await sealAiKey(env, rawKey, { rowId: id, userId, provider });
	if (!sealed) return 'not_configured';
	const exists = sql`exists (select 1 from ai_keys where user_id = ${userId} and provider = ${provider})`;
	const [audit] = await db.batch([
		db
			.insert(aiKeyAudit)
			.values({
				id: newId(),
				userId,
				action: sql`case when ${exists} then 'replaced' else 'created' end`,
				createdAt: now
			})
			.returning({ action: aiKeyAudit.action }),
		db
			.insert(aiKeys)
			.values({
				id,
				userId,
				provider,
				encryptedKey: sealed.ciphertext,
				keyNonce: sealed.nonce,
				keyKeyId: sealed.keyId,
				lastFour: rawKey.slice(-4),
				status: 'active',
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: [aiKeys.userId, aiKeys.provider],
				set: {
					id: sql`excluded.id`,
					encryptedKey: sql`excluded.encrypted_key`,
					keyNonce: sql`excluded.key_nonce`,
					keyKeyId: sql`excluded.key_key_id`,
					lastFour: sql`excluded.last_four`,
					status: 'active',
					lastTestedAt: null,
					lastTestResult: null,
					updatedAt: now
				}
			})
	]);
	return audit[0]?.action === 'replaced' ? 'replaced' : 'created';
}

/**
 * "Hapus kunci": a real DELETE of (user, provider) and one `removed` audit row, written only when a row was
 * there (a repeated or concurrent delete adds none). True when a key was deleted.
 */
export async function deleteKey(
	db: Db,
	userId: string,
	provider: AiKeyProvider,
	now: number
): Promise<boolean> {
	const row = and(eq(aiKeys.userId, userId), eq(aiKeys.provider, provider));
	const [, deleted] = await db.batch([
		auditKeyRow(db, 'removed', row, now),
		db.delete(aiKeys).where(row).returning({ id: aiKeys.id })
	]);
	return deleted.length === 1;
}

/**
 * Stores the outcome of a "Tes koneksi" of the row `rowId` (the key that was actually tested: a key replaced
 * meanwhile is not stamped with the old one's result) with a `test_ok`/`test_failed` audit row. A `network` or
 * `model_unavailable` outcome says nothing about the key, so the stored result is left as it was (PRD criterion
 * 16); only the audit row is written. False when the row is gone (replaced or deleted meanwhile): nothing is written.
 */
export async function recordTestResult(
	db: Db,
	userId: string,
	provider: AiKeyProvider,
	rowId: string,
	result: AiKeyTestOutcome,
	now: number
): Promise<boolean> {
	const row = and(eq(aiKeys.userId, userId), eq(aiKeys.provider, provider), eq(aiKeys.id, rowId));
	const audit = auditKeyRow(db, result === 'ok' ? 'test_ok' : 'test_failed', row, now);
	if (result === 'network' || result === 'model_unavailable') {
		const [found] = await db.batch([
			db.select({ id: aiKeys.id }).from(aiKeys).where(row).limit(1),
			audit
		]);
		return found.length === 1;
	}
	const [, updated] = await db.batch([
		audit,
		db
			.update(aiKeys)
			.set({ lastTestedAt: now, lastTestResult: result })
			.where(row)
			.returning({ id: aiKeys.id })
	]);
	return updated.length === 1;
}

/** Admin status view: how many users have a key stored (a count only, nobody named). */
export async function countUsersWithKey(db: Db, provider: AiKeyProvider): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(aiKeys)
		.where(and(eq(aiKeys.provider, provider), eq(aiKeys.status, 'active')));
	return row?.n ?? 0;
}
