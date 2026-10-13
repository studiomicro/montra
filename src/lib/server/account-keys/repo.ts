import { and, eq, sql } from 'drizzle-orm';
import type { AccountKeyFields } from '#lib/shared/account-key-fields';
import type { Db } from '../db';
import { accountKeys, userPasswords } from '../db/schema';
import { equalConstantTime } from '../auth/password';
import { newId } from '../util';

/**
 * The account key rows (FN-21). Every function takes the user id from the session (`locals.user.id`), never
 * from the client; nothing here reads another user's row. Writes that follow a password re-entry are guarded
 * on the stored hash the password was just proven against, inside the statement itself.
 */

export type AccountKeyRow = typeof accountKeys.$inferSelect;

/** What a device needs to open its key, sent only after a password proof: the fields plus their version. */
export interface AccountKeyMaterial extends AccountKeyFields {
	/** `updated_at` of the row: a re-wrap is accepted only while the row still has it. */
	version: number;
}

export async function getAccountKey(db: Db, userId: string): Promise<AccountKeyRow | null> {
	return (await db.select().from(accountKeys).where(eq(accountKeys.userId, userId)).get()) ?? null;
}

export function accountKeyMaterial(row: AccountKeyRow): AccountKeyMaterial {
	return {
		publicKey: row.publicKey,
		wrappedPrivateKey: row.wrappedPrivateKey,
		wrapNonce: row.wrapNonce,
		kdfSalt: row.kdfSalt,
		kdfParams: row.kdfParams,
		version: row.updatedAt
	};
}

export interface AccountKeyStatus {
	publicKey: string;
	/** Wrapped before the password last changed: opens only with the earlier password until re-wrapped. */
	stale: boolean;
}

/** The signed-in user's key state for the account page: no wrapped material, only the public key. */
export async function getAccountKeyStatus(
	db: Db,
	userId: string
): Promise<AccountKeyStatus | null> {
	const row = await db
		.select({
			publicKey: accountKeys.publicKey,
			keyUpdatedAt: accountKeys.updatedAt,
			passwordUpdatedAt: userPasswords.updatedAt
		})
		.from(accountKeys)
		.leftJoin(userPasswords, eq(userPasswords.userId, accountKeys.userId))
		.where(eq(accountKeys.userId, userId))
		.get();
	if (!row) return null;
	return {
		publicKey: row.publicKey,
		stale: row.passwordUpdatedAt !== null && row.keyUpdatedAt < row.passwordUpdatedAt
	};
}

/**
 * Whether `keyCheckHash` is the one stored for `userId`'s key, compared in constant time. The writes below also
 * guard on it inside their statement (race safety); this is the timing-safe check the actions run first.
 */
export async function keyCheckMatches(
	db: Db,
	userId: string,
	keyCheckHash: string
): Promise<boolean> {
	const row = await db
		.select({ hash: accountKeys.keyCheckHash })
		.from(accountKeys)
		.where(eq(accountKeys.userId, userId))
		.get();
	return row !== undefined && equalConstantTime(row.hash, keyCheckHash);
}

/** A key write as validated from a form: the transported fields and SHA-256 (hex) of the key confirmation. */
export interface KeyWrite {
	fields: AccountKeyFields;
	keyCheckHash: string;
}

/** The insert of a brand-new account's key, for the sign-up batch (accounts.ts). */
export function insertAccountKey(db: Db, userId: string, key: KeyWrite, now: number) {
	return db.insert(accountKeys).values({
		id: newId(),
		userId,
		...key.fields,
		keyCheckHash: key.keyCheckHash,
		createdAt: now,
		updatedAt: now
	});
}

/**
 * "Kunci dengan akunku": the first key of an account that has none. One statement: written only while the
 * password is still `provenHash` and no key exists yet (the unique `user_id` decides concurrent activations).
 */
export async function activateAccountKey(
	db: Db,
	userId: string,
	provenHash: string,
	key: KeyWrite,
	now: number
): Promise<boolean> {
	const id = newId();
	const { fields } = key;
	const written = await db
		.insert(accountKeys)
		.select((qb) =>
			qb
				.select({
					id: sql`${id}`.as('id'),
					userId: userPasswords.userId,
					publicKey: sql`${fields.publicKey}`.as('public_key'),
					wrappedPrivateKey: sql`${fields.wrappedPrivateKey}`.as('wrapped_private_key'),
					wrapNonce: sql`${fields.wrapNonce}`.as('wrap_nonce'),
					kdfSalt: sql`${fields.kdfSalt}`.as('kdf_salt'),
					kdfParams: sql`${fields.kdfParams}`.as('kdf_params'),
					keyCheckHash: sql`${key.keyCheckHash}`.as('key_check_hash'),
					createdAt: sql`${now}`.as('created_at'),
					updatedAt: sql`${now}`.as('updated_at')
				})
				.from(userPasswords)
				.where(and(eq(userPasswords.userId, userId), eq(userPasswords.hash, provenHash)))
		)
		.onConflictDoNothing()
		.returning({ id: accountKeys.id });
	return written.length === 1;
}

/**
 * Re-locks a stale key (wrapped before the password last changed, on a device that could not re-wrap) under
 * the current password. Accepted only while the key is stale, still at `version`, with the same public key
 * and key confirmation (the device opened the old wrap), and the password is still `provenHash`. A key that is
 * not stale changes only together with the password (change-password.ts). False when anything differs.
 */
export async function rewrapAccountKey(
	db: Db,
	userId: string,
	provenHash: string,
	version: number,
	key: KeyWrite,
	now: number
): Promise<boolean> {
	const written = await rewrapStatement(db, userId, version, key, now, provenHash, {
		staleOnly: true
	}).returning({ id: accountKeys.id });
	return written.length === 1;
}

/**
 * The guarded re-wrap UPDATE: only the wrap fields change, never `public_key` or `key_check_hash`; only while the
 * row is at `version`, has this public key and key confirmation, and the account's password hash is
 * `passwordHash` (with `staleOnly`, also only while the key is older than the password).
 */
export function rewrapStatement(
	db: Db,
	userId: string,
	version: number,
	key: KeyWrite,
	now: number,
	passwordHash: string,
	opts: { staleOnly?: boolean } = {}
) {
	const { fields } = key;
	return db
		.update(accountKeys)
		.set({
			wrappedPrivateKey: fields.wrappedPrivateKey,
			wrapNonce: fields.wrapNonce,
			kdfSalt: fields.kdfSalt,
			kdfParams: fields.kdfParams,
			updatedAt: now
		})
		.where(
			and(
				eq(accountKeys.userId, userId),
				eq(accountKeys.updatedAt, version),
				eq(accountKeys.publicKey, fields.publicKey),
				eq(accountKeys.keyCheckHash, key.keyCheckHash),
				sql`exists (select 1 from ${userPasswords} where ${userPasswords.userId} = ${userId} and ${userPasswords.hash} = ${passwordHash})`,
				opts.staleOnly
					? sql`${accountKeys.updatedAt} < (select ${userPasswords.updatedAt} from ${userPasswords} where ${userPasswords.userId} = ${userId})`
					: undefined
			)
		);
}
