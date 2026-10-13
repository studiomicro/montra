import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { rewrapStatement, type KeyWrite } from '../account-keys/repo';
import type { Db } from '../db';
import { accountKeys, apiTokens, sessions, userPasswords } from '../db/schema';
import { removeOtherSessionSubscriptions } from '../push/repo';
import { sha256Hex } from '../util';
import { newCredential } from './password';

/** The account key re-wrapped on the device under the new password, and the key row version it read. */
export interface Rewrap {
	key: KeyWrite;
	version: number;
}

/**
 * Replaces the password of `userId`, guarded on `provenHash` (the stored hash the current password was just
 * proven against), in one `db.batch` (one D1 transaction):
 *
 * 1. the credential UPDATE, only while the hash is still `provenHash` and, with a re-wrap, only while the key
 *    row is still at `rewrap.version` with the same public key and key confirmation;
 * 2. with a re-wrap, the key UPDATE, only while the hash is now the new one (so only when step 1 wrote);
 * 3. every other session of the user is revoked and the push subscriptions they made are tombstoned (a
 *    password change is how people answer a suspected compromise; red team M1), again only while the hash is
 *    the new one. The session of `currentToken` stays signed in;
 * 4. every live public-API token of the user is revoked (FN-38 owner-safety default: a token made by whoever
 *    held the account before the change stops working with it), again only while the hash is the new one.
 *
 * All or nothing: of N concurrent changes exactly one commits, the rest find another hash and write nothing,
 * so the password and the wrapped key never disagree because of a race. Without a re-wrap (JS off, a browser
 * without X25519) the password still changes and an existing key row is left as it is: it then opens only with
 * the earlier password (`getAccountKeyStatus` reports it stale).
 */
export async function changePassword(
	db: Db,
	userId: string,
	provenHash: string,
	currentToken: string,
	newPassword: string,
	rewrap: Rewrap | null,
	now: number
): Promise<boolean> {
	const credential = await newCredential(newPassword);
	const keepTokenHash = await sha256Hex(currentToken);
	const keyStillAt = rewrap
		? sql`exists (select 1 from ${accountKeys} where ${accountKeys.userId} = ${userId}
			and ${accountKeys.updatedAt} = ${rewrap.version} and ${accountKeys.publicKey} = ${rewrap.key.fields.publicKey}
			and ${accountKeys.keyCheckHash} = ${rewrap.key.keyCheckHash})`
		: sql`1 = 1`;
	const committed = sql`exists (select 1 from ${userPasswords} where ${userPasswords.userId} = ${userId}
		and ${userPasswords.hash} = ${credential.hash})`;
	const passwordUpdate = db
		.update(userPasswords)
		.set({ ...credential, failedCount: 0, lockedUntil: null, updatedAt: now })
		.where(and(eq(userPasswords.userId, userId), eq(userPasswords.hash, provenHash), keyStillAt))
		.returning({ userId: userPasswords.userId });
	const otherSubscriptions = removeOtherSessionSubscriptions(
		db,
		userId,
		keepTokenHash,
		committed,
		now
	);
	const otherSessions = db
		.update(sessions)
		.set({ revokedAt: now })
		.where(
			and(
				eq(sessions.userId, userId),
				ne(sessions.tokenHash, keepTokenHash),
				isNull(sessions.revokedAt),
				committed
			)
		);
	const apiTokensRevoked = db
		.update(apiTokens)
		.set({ revokedAt: now, updatedAt: now })
		.where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), committed));
	const [changed] = await db.batch([
		passwordUpdate,
		...(rewrap
			? [rewrapStatement(db, userId, rewrap.version, rewrap.key, now, credential.hash)]
			: []),
		otherSubscriptions,
		otherSessions,
		apiTokensRevoked
	]);
	return changed.length === 1;
}
