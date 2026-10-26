import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { goals, spaces } from '../db/schema';
import { isLiveMember } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import { goalProgressPercent, goalSavedMinor, goalsSavedSums } from './progress';
import { GOAL_CURRENCY, type GoalInput } from './validation';
import { nextUpdatedAt } from '../sync/updated-at';

/** Most goals one space holds, archived ones included (they stay listable); also the list's row cap. */
export const MAX_GOALS_PER_SPACE = 50;

/**
 * Who writes where. Every function here runs only after `requireSpaceAccess` admitted `userId` to `spaceId`;
 * each write repeats that membership check in its own statement, so a removal in between changes nothing.
 */
export interface GoalScope {
	spaceId: string;
	userId: string;
}

export interface GoalSummary {
	id: string;
	name: string;
	targetAmountMinor: number;
	currency: string;
	createdAt: number;
	updatedAt: number;
	archived: boolean;
	/** Σ live contributions (goals/progress.ts), never a stored figure. */
	savedMinor: number;
	/** floor(saved × 100 / target); may pass 100. */
	percent: number;
}

/** `missing`: no such goal in this space (same answer for another space's id). `stale`: changed meanwhile. */
export type GoalWriteResult = 'ok' | 'stale' | 'missing';

const columns = {
	id: goals.id,
	name: goals.name,
	targetAmountMinor: goals.targetAmountMinor,
	currency: goals.currency,
	createdAt: goals.createdAt,
	updatedAt: goals.updatedAt,
	deletedAt: goals.deletedAt
};

type GoalRow = {
	id: string;
	name: string;
	targetAmountMinor: number;
	currency: string;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
};

function summary(row: GoalRow, savedMinor: number): GoalSummary {
	const { deletedAt, ...rest } = row;
	return {
		...rest,
		archived: deletedAt !== null,
		savedMinor,
		percent: goalProgressPercent(savedMinor, row.targetAmountMinor)
	};
}

/**
 * The space's goals with their progress: live ones oldest first, then, with `includeArchived`, archived ones
 * in the same order. Bounded by MAX_GOALS_PER_SPACE, which is also the per-space creation cap. Two queries
 * (the goals, then every saved sum in one grouped query), never one per goal.
 */
export async function listGoals(
	db: Db,
	spaceId: string,
	opts: { includeArchived?: boolean } = {}
): Promise<GoalSummary[]> {
	const rows = await db
		.select(columns)
		.from(goals)
		.where(
			opts.includeArchived
				? eq(goals.spaceId, spaceId)
				: and(eq(goals.spaceId, spaceId), isNull(goals.deletedAt))
		)
		.orderBy(sql`${goals.deletedAt} is not null`, asc(goals.createdAt), asc(goals.id))
		.limit(MAX_GOALS_PER_SPACE);
	if (rows.length === 0) return [];
	const sums = await goalsSavedSums(db, spaceId);
	return rows.map((row) => summary(row, sums[row.id] ?? 0));
}

/** One goal of this space with its progress (live only unless `includeArchived`); null for an unknown or other-space id. */
export async function getGoal(
	db: Db,
	spaceId: string,
	goalId: string,
	opts: { includeArchived?: boolean } = {}
): Promise<GoalSummary | null> {
	const row = await db
		.select(columns)
		.from(goals)
		.where(
			and(
				eq(goals.id, goalId),
				eq(goals.spaceId, spaceId),
				opts.includeArchived ? undefined : isNull(goals.deletedAt)
			)
		)
		.get();
	return row ? summary(row, await goalSavedMinor(db, spaceId, goalId)) : null;
}

/** Why a create wrote nothing: the space's cap, or the membership went meanwhile (answered as not found). */
export type CreateGoalResult = { ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' };

/** Creates a goal (IDR). Refused past MAX_GOALS_PER_SPACE in one guarded insert, so concurrent creates cannot pass the cap. */
export async function createGoal(
	db: Db,
	scope: GoalScope,
	input: GoalInput,
	now: number
): Promise<CreateGoalResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(goals)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						spaceId: spaces.id,
						name: sql`${input.name}`.as('name'),
						targetAmountMinor: sql`${input.targetAmountMinor}`.as('target_amount_minor'),
						currency: sql`${GOAL_CURRENCY}`.as('currency'),
						createdAt: sql`${now}`.as('created_at'),
						updatedAt: sql`${now}`.as('updated_at'),
						deletedAt: sql`null`.as('deleted_at'),
						seq: sql`${currentSpaceSeq(spaceId)}`.as('seq')
					})
					.from(spaces)
					.where(
						and(
							eq(spaces.id, spaceId),
							isLiveMember(spaceId, userId),
							sql`(select count(*) from goals g where g.space_id = ${spaceId}) < ${MAX_GOALS_PER_SPACE}`
						)
					)
			)
			.returning({ id: goals.id })
	]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from goals where space_id = ${spaceId}`
	);
	return { ok: false, reason: (count?.n ?? 0) >= MAX_GOALS_PER_SPACE ? 'limit' : 'gone' };
}

/** After a guarded write changed nothing: `stale` when the goal is still in this space, else `missing`. */
async function whyNot(db: Db, spaceId: string, goalId: string): Promise<GoalWriteResult> {
	const row = await db
		.select({ id: goals.id })
		.from(goals)
		.where(and(eq(goals.id, goalId), eq(goals.spaceId, spaceId)))
		.get();
	return row ? 'stale' : 'missing';
}

/**
 * The guarded tail of every goal write: this goal of this space, `updated_at` still `expectedUpdatedAt` (the
 * value the form was loaded with, so a second tab's stale submission is refused), the writer still a member.
 */
const writable = (scope: GoalScope, goalId: string, expectedUpdatedAt: number) =>
	and(
		eq(goals.id, goalId),
		eq(goals.spaceId, scope.spaceId),
		eq(goals.updatedAt, expectedUpdatedAt),
		isLiveMember(scope.spaceId, scope.userId)
	);

/** Saves the edit form (name, target) of a live goal; `stale` when it changed since the form loaded. */
export async function updateGoal(
	db: Db,
	scope: GoalScope,
	goalId: string,
	input: GoalInput,
	expectedUpdatedAt: number,
	now: number
): Promise<GoalWriteResult> {
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(goals)
			.set({
				name: input.name,
				targetAmountMinor: input.targetAmountMinor,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(and(writable(scope, goalId, expectedUpdatedAt), isNull(goals.deletedAt)))
			.returning({ id: goals.id })
	]);
	return updated.length === 1 ? 'ok' : whyNot(db, scope.spaceId, goalId);
}

/** Archives (tombstones) a live goal. Its contributions are left untouched, so a restore brings back the same progress. */
export async function archiveGoal(
	db: Db,
	scope: GoalScope,
	goalId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<GoalWriteResult> {
	const [, archived] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(goals)
			.set({
				deletedAt: now,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(and(writable(scope, goalId, expectedUpdatedAt), isNull(goals.deletedAt)))
			.returning({ id: goals.id })
	]);
	return archived.length === 1 ? 'ok' : whyNot(db, scope.spaceId, goalId);
}

/** Brings an archived goal back with its contribution log as it was. */
export async function restoreGoal(
	db: Db,
	scope: GoalScope,
	goalId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<GoalWriteResult> {
	const [, restored] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(goals)
			.set({
				deletedAt: null,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(and(writable(scope, goalId, expectedUpdatedAt), isNotNull(goals.deletedAt)))
			.returning({ id: goals.id })
	]);
	return restored.length === 1 ? 'ok' : whyNot(db, scope.spaceId, goalId);
}
