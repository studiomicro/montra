import { eq, sql } from 'drizzle-orm';
import { flagsFrom, MODULES, type Module } from '../../shared/feature-flags';
import type { Db } from '../db';
import { featureFlags } from '../db/schema';

/** The user's flags for every module; a module without a stored row is enabled (default-on). */
export async function getFeatureFlags(db: Db, userId: string): Promise<Record<Module, boolean>> {
	const rows = await db
		.select({ module: featureFlags.module, enabled: featureFlags.enabled })
		.from(featureFlags)
		.where(eq(featureFlags.userId, userId))
		// At most one row per module (unique index), so this never cuts a real row.
		.limit(MODULES.length);
	return flagsFrom(rows);
}

/**
 * Stores one flag: a single upsert on the (user_id, module) unique index, so concurrent submissions for the
 * same pair always leave exactly one row holding the last write applied, never a duplicate or a 500.
 */
export async function setFeatureFlag(
	db: Db,
	userId: string,
	module: Module,
	enabled: boolean,
	now: number
): Promise<void> {
	await db
		.insert(featureFlags)
		.values({ id: crypto.randomUUID(), userId, module, enabled, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: [featureFlags.userId, featureFlags.module],
			set: { enabled: sql`excluded.enabled`, updatedAt: sql`excluded.updated_at` }
		});
}
