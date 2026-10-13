import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { budgets } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import type { BudgetInput } from './validation';

/** The space's live budget: one standing monthly amount (FN-07, owner decisions B and G). */
export interface Budget {
	amountMinor: number;
	currency: string;
	updatedAt: number;
}

/**
 * `stale`: the form's `updated_at` no longer matches (another tab or member set, changed or removed the
 * budget meanwhile). `gone`: the writer is not (or no longer) a live member of the space — the same answer
 * as for a non-member everywhere (404).
 */
export type BudgetWriteResult = 'ok' | 'stale' | 'gone';

/** The live budget of `spaceId` (already admitted by the access gate), or null when none is set. */
export async function getActiveBudget(db: Db, spaceId: string): Promise<Budget | null> {
	const row = await db
		.select({
			amountMinor: budgets.amountMinor,
			currency: budgets.currency,
			updatedAt: budgets.updatedAt
		})
		.from(budgets)
		.where(and(eq(budgets.spaceId, spaceId), isNull(budgets.deletedAt)))
		.get();
	return row ?? null;
}

/**
 * Whether `currency` may be the budget's: the currency of a live wallet of the space, IDR when the space has
 * no live wallet, or the live budget's own currency (so its amount stays editable after its wallet is
 * archived). Decided on the server from stored rows, never from the form's hidden field.
 */
export async function isBudgetCurrency(
	db: Db,
	spaceId: string,
	currency: string
): Promise<boolean> {
	const row = await db.get<{ ok: number }>(sql`select (
			exists (select 1 from wallets w where w.space_id = ${spaceId} and w.deleted_at is null
				and w.currency = ${currency})
			or (${currency} = 'IDR' and not exists (select 1 from wallets w where w.space_id = ${spaceId}
				and w.deleted_at is null))
			or exists (select 1 from budgets b where b.space_id = ${spaceId} and b.deleted_at is null
				and b.currency = ${currency})
		) as ok`);
	return row?.ok === 1;
}

/** After a guarded write changed nothing: `gone` when the writer is no longer a live member, else `stale`. */
async function whyNot(db: Db, scope: SpaceScope): Promise<'stale' | 'gone'> {
	const row = await db.get<{ member: number }>(
		sql`select ${isLiveMember(scope.spaceId, scope.userId)} as member`
	);
	return row?.member === 1 ? 'stale' : 'gone';
}

/** `updated_at` of a write that expected `expected`: always later, even within the same millisecond. */
const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);

/**
 * Sets the space's budget. `expectedUpdatedAt` is what the form was loaded with.
 *
 * Null means the form showed no budget, so this is a create. In one batch, the space's tombstone (if any) is
 * revived with the new amount; only a space that never had a budget gets a new row. A space therefore holds
 * at most one budget row however often it is set and removed (the unique index backs it up). Concurrent
 * creates leave exactly one live row and the others get `stale`.
 *
 * Otherwise it is one guarded update keyed on `updated_at`, so a stale form never overwrites a newer value.
 */
export async function setBudget(
	db: Db,
	scope: SpaceScope,
	input: BudgetInput,
	expectedUpdatedAt: number | null,
	now: number
): Promise<BudgetWriteResult> {
	const { spaceId, userId } = scope;
	if (expectedUpdatedAt === null) {
		const id = newId();
		const [, revived, inserted] = await db.batch([
			bumpSpaceSeq(db, spaceId),
			db
				.update(budgets)
				.set({
					amountMinor: input.amountMinor,
					currency: input.currency,
					deletedAt: null,
					updatedAt: sql`max(${now}, ${budgets.updatedAt} + 1)`,
					seq: currentSpaceSeq(spaceId)
				})
				.where(
					and(
						eq(budgets.spaceId, spaceId),
						isNotNull(budgets.deletedAt),
						isLiveMember(spaceId, userId)
					)
				)
				.returning({ id: budgets.id }),
			db
				.insert(budgets)
				.select(
					sql`select ${id}, ${spaceId}, ${input.amountMinor}, ${input.currency}, ${now}, ${now}, null,
						${currentSpaceSeq(spaceId)}
					where ${isLiveMember(spaceId, userId)}
						and not exists (select 1 from budgets b where b.space_id = ${spaceId})`
				)
				.onConflictDoNothing()
				.returning({ id: budgets.id })
		]);
		return revived.length + inserted.length === 1 ? 'ok' : whyNot(db, scope);
	}
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(budgets)
			.set({
				amountMinor: input.amountMinor,
				currency: input.currency,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(budgets.spaceId, spaceId),
					isNull(budgets.deletedAt),
					eq(budgets.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: budgets.id })
	]);
	return updated.length === 1 ? 'ok' : whyNot(db, scope);
}

/**
 * "Hapus anggaran": tombstones the live budget (amount cleared, `seq` advanced) while its `updated_at` is
 * still `expectedUpdatedAt`. Reversible: setting a budget again revives this same row.
 */
export async function deleteBudget(
	db: Db,
	scope: SpaceScope,
	expectedUpdatedAt: number,
	now: number
): Promise<BudgetWriteResult> {
	const { spaceId, userId } = scope;
	const [, deleted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(budgets)
			.set({
				amountMinor: 0,
				deletedAt: now,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(budgets.spaceId, spaceId),
					isNull(budgets.deletedAt),
					eq(budgets.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: budgets.id })
	]);
	return deleted.length === 1 ? 'ok' : whyNot(db, scope);
}
