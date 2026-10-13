import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { categories, categoryBudgets } from '../db/schema';
import { CATEGORY_LIST_MAX } from '../categories/repo';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import type { BudgetInput } from './validation';

/** One live category budget (Anggaran page): a standing monthly amount for one expense category. */
export interface CategoryBudget {
	categoryId: string;
	amountMinor: number;
	currency: string;
	updatedAt: number;
}

/**
 * `missing`: no live expense category with that id in this space (another space's id answers the same).
 * `stale` and `gone` as for the total budget (budgets/repo.ts).
 */
export type CategoryBudgetWriteResult = 'ok' | 'stale' | 'gone' | 'missing';

/**
 * The live budgets of `spaceId` (already admitted by the access gate) whose category is still a live expense
 * category, in the categories' own order. Bounded: at most one per category, and a space has at most
 * CATEGORY_LIST_MAX categories.
 */
export async function listCategoryBudgets(db: Db, spaceId: string): Promise<CategoryBudget[]> {
	return db
		.select({
			categoryId: categoryBudgets.categoryId,
			amountMinor: categoryBudgets.amountMinor,
			currency: categoryBudgets.currency,
			updatedAt: categoryBudgets.updatedAt
		})
		.from(categoryBudgets)
		.innerJoin(
			categories,
			and(
				eq(categories.id, categoryBudgets.categoryId),
				eq(categories.spaceId, categoryBudgets.spaceId)
			)
		)
		.where(
			and(
				eq(categoryBudgets.spaceId, spaceId),
				isNull(categoryBudgets.deletedAt),
				isNull(categories.deletedAt),
				eq(categories.kind, 'expense')
			)
		)
		.orderBy(asc(categories.sortOrder), asc(categories.createdAt), asc(categories.id))
		.limit(CATEGORY_LIST_MAX);
}

/** SQL: `categoryId` is a live expense category of `spaceId`. */
const liveExpenseCategory = (spaceId: string, categoryId: string) =>
	sql`exists (select 1 from categories c where c.id = ${categoryId} and c.space_id = ${spaceId}
		and c.deleted_at is null and c.kind = 'expense')`;

/** Why a guarded write changed nothing: not a member (`gone`), no such category (`missing`), else `stale`. */
async function whyNot(
	db: Db,
	scope: SpaceScope,
	categoryId: string
): Promise<'stale' | 'gone' | 'missing'> {
	const row = await db.get<{ member: number; category: number }>(
		sql`select ${isLiveMember(scope.spaceId, scope.userId)} as member,
			${liveExpenseCategory(scope.spaceId, categoryId)} as category`
	);
	if (row?.member !== 1) return 'gone';
	return row.category === 1 ? 'stale' : 'missing';
}

/** `updated_at` of a write that expected `expected`: always later, even within the same millisecond. */
const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);

/**
 * Sets the budget of one expense category, like `setBudget`: `expectedUpdatedAt` null is a create (revives the
 * pair's tombstone, else inserts the pair's first row; concurrent creates leave one live row and the others
 * get `stale`), otherwise one update guarded on `updated_at`. Every statement repeats the membership and the
 * category check, so a removed member or another space's category id changes nothing.
 */
export async function setCategoryBudget(
	db: Db,
	scope: SpaceScope,
	categoryId: string,
	input: BudgetInput,
	expectedUpdatedAt: number | null,
	now: number
): Promise<CategoryBudgetWriteResult> {
	const { spaceId, userId } = scope;
	const allowed = and(isLiveMember(spaceId, userId), liveExpenseCategory(spaceId, categoryId));
	if (expectedUpdatedAt === null) {
		const id = newId();
		const [, revived, inserted] = await db.batch([
			bumpSpaceSeq(db, spaceId),
			db
				.update(categoryBudgets)
				.set({
					amountMinor: input.amountMinor,
					currency: input.currency,
					deletedAt: null,
					updatedAt: sql`max(${now}, ${categoryBudgets.updatedAt} + 1)`,
					seq: currentSpaceSeq(spaceId)
				})
				.where(
					and(
						eq(categoryBudgets.spaceId, spaceId),
						eq(categoryBudgets.categoryId, categoryId),
						isNotNull(categoryBudgets.deletedAt),
						allowed
					)
				)
				.returning({ id: categoryBudgets.id }),
			db
				.insert(categoryBudgets)
				.select(
					sql`select ${id}, ${spaceId}, ${categoryId}, ${input.amountMinor}, ${input.currency}, ${now},
						${now}, null, ${currentSpaceSeq(spaceId)}
					where ${allowed}
						and not exists (select 1 from category_budgets b where b.space_id = ${spaceId}
							and b.category_id = ${categoryId})`
				)
				.onConflictDoNothing()
				.returning({ id: categoryBudgets.id })
		]);
		return revived.length + inserted.length === 1 ? 'ok' : whyNot(db, scope, categoryId);
	}
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(categoryBudgets)
			.set({
				amountMinor: input.amountMinor,
				currency: input.currency,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(categoryBudgets.spaceId, spaceId),
					eq(categoryBudgets.categoryId, categoryId),
					isNull(categoryBudgets.deletedAt),
					eq(categoryBudgets.updatedAt, expectedUpdatedAt),
					allowed
				)
			)
			.returning({ id: categoryBudgets.id })
	]);
	return updated.length === 1 ? 'ok' : whyNot(db, scope, categoryId);
}

/** Removes one category's budget (content-free tombstone) while its `updated_at` is still `expectedUpdatedAt`. */
export async function deleteCategoryBudget(
	db: Db,
	scope: SpaceScope,
	categoryId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<CategoryBudgetWriteResult> {
	const { spaceId, userId } = scope;
	const [, deleted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(categoryBudgets)
			.set({
				amountMinor: 0,
				deletedAt: now,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(categoryBudgets.spaceId, spaceId),
					eq(categoryBudgets.categoryId, categoryId),
					isNull(categoryBudgets.deletedAt),
					eq(categoryBudgets.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId),
					liveExpenseCategory(spaceId, categoryId)
				)
			)
			.returning({ id: categoryBudgets.id })
	]);
	return deleted.length === 1 ? 'ok' : whyNot(db, scope, categoryId);
}
