import { asc, eq, sql } from 'drizzle-orm';
import { CONSENT_KINDS, CONSENT_VERSIONS, type ConsentKind } from '#lib/shared/privacy';
import type { Db } from '../db';
import { consentRecords, usageStatsPrefs } from '../db/schema';
import { newId } from '../util';

/**
 * Privacy data of one account (FN-31). Every function takes the signed-in user's own id (`locals.user.id`),
 * never an id from the request: consent and the statistics switch belong to a person, not a space.
 */

/** Most consent rows read for one account: three per sign-up, so far above any real account. */
const CONSENT_LIST_LIMIT = 100;

/** The three consent rows a sign-up writes, one per kind with the current text's version, for its batch. */
export function consentInserts(db: Db, userId: string, now: number) {
	return db.insert(consentRecords).values(
		CONSENT_KINDS.map((kind) => ({
			id: newId(),
			userId,
			kind,
			version: CONSENT_VERSIONS[kind],
			acceptedAt: now,
			createdAt: now
		}))
	);
}

export interface ConsentRecord {
	kind: ConsentKind;
	version: string;
	acceptedAt: number;
}

/** The account's consent rows, oldest first. Bounded. */
export async function listConsentRecords(db: Db, userId: string): Promise<ConsentRecord[]> {
	return db
		.select({
			kind: consentRecords.kind,
			version: consentRecords.version,
			acceptedAt: consentRecords.acceptedAt
		})
		.from(consentRecords)
		.where(eq(consentRecords.userId, userId))
		.orderBy(asc(consentRecords.acceptedAt), asc(consentRecords.kind), asc(consentRecords.id))
		.limit(CONSENT_LIST_LIMIT);
}

/** Whether usage statistics may be counted for this account: no row means yes (FEATURES.md FN-31 opt-out). */
export async function usageStatsEnabled(db: Db, userId: string): Promise<boolean> {
	const row = await db
		.select({ enabled: usageStatsPrefs.enabled })
		.from(usageStatsPrefs)
		.where(eq(usageStatsPrefs.userId, userId))
		.get();
	return row?.enabled ?? true;
}

/** One upsert on the user: concurrent submissions leave exactly one row, the last write applied. */
export async function setUsageStatsEnabled(
	db: Db,
	userId: string,
	enabled: boolean,
	now: number
): Promise<void> {
	await db
		.insert(usageStatsPrefs)
		.values({ userId, enabled, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: usageStatsPrefs.userId,
			set: { enabled: sql`excluded.enabled`, updatedAt: sql`excluded.updated_at` }
		});
}
