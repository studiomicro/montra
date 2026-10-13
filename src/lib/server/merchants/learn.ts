import { sql } from 'drizzle-orm';
import { cleanDescriptor } from '#lib/shared/merchants/clean';
import type { CategoryKind } from '#lib/shared/transactions';
import type { Db } from '../db';
import { merchantRules } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';

/**
 * Learning (FN-20 § 5, owner decision 4): a member's category change on a draft or a saved transaction teaches
 * the space. Each correction is one guarded upsert in one `db.batch`: the rule for (space, key, kind) is created,
 * or its category and name replaced and `hits` raised, only while the user is a live member and the category is
 * a visible category of this space of that kind. The partial unique index makes concurrent corrections of the
 * same merchant land on one live row. Called only after the change itself was written.
 */

export interface Correction {
	/** The row's title (the descriptor as shown); cleaned here. */
	descriptor: string;
	kind: CategoryKind;
	categoryId: string;
}

/** Most corrections learned from one bulk action (the review list shows at most 100 drafts). */
export const LEARN_BATCH_MAX = 100;

/** The guarded upsert of one correction (a query builder: D1's batch takes no raw SQL with parameters). */
function upsertRule(db: Db, scope: SpaceScope, c: Correction, now: number) {
	const { spaceId, userId } = scope;
	const { name, key } = cleanDescriptor(c.descriptor);
	return db
		.insert(merchantRules)
		.select(
			sql`select ${newId()}, ${spaceId}, ${key}, ${name}, ${c.categoryId}, ${c.kind}, 1, 'correction',
				${userId}, ${now}, ${now}, null, ${currentSpaceSeq(spaceId)}
			where ${isLiveMember(spaceId, userId)}
				and exists (select 1 from categories c where c.id = ${c.categoryId} and c.space_id = ${spaceId}
					and c.kind = ${c.kind} and c.deleted_at is null and c.is_hidden = 0)`
		)
		.onConflictDoUpdate({
			target: [merchantRules.spaceId, merchantRules.matchKey, merchantRules.kind],
			targetWhere: sql`deleted_at is null`,
			set: {
				categoryId: sql`excluded.category_id`,
				merchantName: sql`excluded.merchant_name`,
				hits: sql`${merchantRules.hits} + 1`,
				updatedAt: sql`max(excluded.updated_at, ${merchantRules.updatedAt} + 1)`,
				seq: sql`excluded.seq`
			}
		})
		.returning({ id: merchantRules.id });
}

/**
 * Learns `corrections` for the space (at most LEARN_BATCH_MAX; one per key and kind, the last one winning).
 * Rows whose title yields no key are skipped. Returns how many rules were written.
 */
export async function learnFromCorrections(
	db: Db,
	scope: SpaceScope,
	corrections: readonly Correction[],
	now: number
): Promise<number> {
	const byKey = new Map<string, Correction>();
	for (const c of corrections.slice(0, LEARN_BATCH_MAX)) {
		const { key } = cleanDescriptor(c.descriptor);
		if (key) byKey.set(`${c.kind}:${key}`, c);
	}
	if (byKey.size === 0) return 0;
	const results = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		...[...byKey.values()].map((c) => upsertRule(db, scope, c, now))
	]);
	return results.slice(1).reduce((n, r) => n + (r as { id: string }[]).length, 0);
}

/** One correction (`learnFromCorrections` with one item): true when a rule was written. */
export async function learnFromCorrection(
	db: Db,
	scope: SpaceScope,
	correction: Correction,
	now: number
): Promise<boolean> {
	return (await learnFromCorrections(db, scope, [correction], now)) === 1;
}
