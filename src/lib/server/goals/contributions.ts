import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { goalContributions, goals, users } from '../db/schema';
import { isLiveMember } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import { savedSumSql } from './progress';
import type { GoalScope } from './repo';
import type { ContributionInput } from './validation';
import { bumpedUpdatedAt } from '../sync/updated-at';

/** Contributions shown per page of a goal's history (newest first). */
const CONTRIBUTIONS_PAGE_SIZE = 50;
/** Most live contributions one goal holds (deleted ones do not count); bounds the rows each sum scans. */
export const MAX_CONTRIBUTIONS_PER_GOAL = 10_000;

/** SQL value: how many live contributions `goalId` has (uses the (space_id, goal_id, deleted_at) index). */
const liveCountSql = (spaceId: string, goalId: string) =>
	sql<number>`(select count(*) from goal_contributions c
		where c.space_id = ${spaceId} and c.goal_id = ${goalId} and c.deleted_at is null)`;

export interface ContributionRow {
	id: string;
	amountMinor: number;
	note: string | null;
	/** Name of the member who logged it; null once that account is deleted. */
	author: string | null;
	createdAt: number;
}

/** Position in a goal's newest-first history: list what comes after (older than) this row. */
export interface ContributionCursor {
	createdAt: number;
	id: string;
}

/**
 * `missing`: no live goal with this id in this space (another space's id included) or the writer is no
 * longer a member. `archived`: the goal is archived (read-only until restored). `too_large`: the goal's
 * saved total would leave the exact-integer range. `limit`: the goal already has MAX_CONTRIBUTIONS_PER_GOAL
 * live contributions.
 */
export type AddContributionResult =
	{ ok: true; id: string } | { ok: false; reason: 'missing' | 'archived' | 'too_large' | 'limit' };

/**
 * Logs a positive amount toward a live goal of this space, in one guarded insert: the goal lookup is scoped by
 * `space_id` in the same statement, the writer is still a member, the goal has fewer than
 * MAX_CONTRIBUTIONS_PER_GOAL live contributions, and its new saved total stays a safe integer. D1 runs the
 * batch as one transaction, so concurrent adds cannot pass the cap. Never touches a wallet or transaction;
 * concurrent contributions are separate rows, so none is lost.
 */
export async function addContribution(
	db: Db,
	scope: GoalScope,
	goalId: string,
	input: ContributionInput,
	now: number
): Promise<AddContributionResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(goalContributions)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						spaceId: goals.spaceId,
						goalId: goals.id,
						amountMinor: sql`${input.amountMinor}`.as('amount_minor'),
						note: sql`${input.note}`.as('note'),
						createdByUserId: sql`${userId}`.as('created_by_user_id'),
						createdAt: sql`${now}`.as('created_at'),
						updatedAt: sql`${now}`.as('updated_at'),
						deletedAt: sql`null`.as('deleted_at'),
						seq: sql`${currentSpaceSeq(spaceId)}`.as('seq')
					})
					.from(goals)
					.where(
						and(
							eq(goals.id, goalId),
							eq(goals.spaceId, spaceId),
							isNull(goals.deletedAt),
							isLiveMember(spaceId, userId),
							sql`${liveCountSql(spaceId, goalId)} < ${MAX_CONTRIBUTIONS_PER_GOAL}`,
							sql`${savedSumSql(spaceId, goalId)} + ${input.amountMinor} <= ${Number.MAX_SAFE_INTEGER}`
						)
					)
			)
			.returning({ id: goalContributions.id })
	]);
	if (inserted.length === 1) return { ok: true, id };
	const goal = await db
		.select({ deletedAt: goals.deletedAt })
		.from(goals)
		.where(and(eq(goals.id, goalId), eq(goals.spaceId, spaceId)))
		.get();
	if (!goal) return { ok: false, reason: 'missing' };
	if (goal.deletedAt !== null) return { ok: false, reason: 'archived' };
	const [why] = await db.all<{ full: number; over: number }>(
		sql`select ${liveCountSql(spaceId, goalId)} >= ${MAX_CONTRIBUTIONS_PER_GOAL} as full,
			${savedSumSql(spaceId, goalId)} + ${input.amountMinor} > ${Number.MAX_SAFE_INTEGER} as over`
	);
	if (why?.full) return { ok: false, reason: 'limit' };
	return { ok: false, reason: why?.over ? 'too_large' : 'missing' };
}

/**
 * Deletes (tombstones) a logged contribution of a live goal in one statement: `deleted_at` set and every
 * content column (amount, note, author, time) nulled, so the tombstone is content-free (the table's CHECK
 * requires it) and the goal's saved amount drops by it. Scoped by space AND goal AND id in the statement: an id of
 * another goal or space, an already-deleted one, or an archived goal all answer `missing`.
 */
export async function deleteContribution(
	db: Db,
	scope: GoalScope,
	goalId: string,
	contributionId: string,
	now: number
): Promise<'ok' | 'missing'> {
	const { spaceId, userId } = scope;
	const [, deleted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(goalContributions)
			.set({
				deletedAt: now,
				amountMinor: null,
				note: null,
				createdByUserId: null,
				createdAt: null,
				updatedAt: bumpedUpdatedAt(goalContributions.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(goalContributions.id, contributionId),
					eq(goalContributions.goalId, goalId),
					eq(goalContributions.spaceId, spaceId),
					isNull(goalContributions.deletedAt),
					sql`exists (select 1 from goals g where g.id = ${goalId} and g.space_id = ${spaceId}
						and g.deleted_at is null)`,
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: goalContributions.id })
	]);
	return deleted.length === 1 ? 'ok' : 'missing';
}

/**
 * One page of a goal's live contributions, newest first, after `cursor` when given. Returns at most `limit`
 * rows and whether older ones exist. Scoped by space and goal.
 */
export async function listContributions(
	db: Db,
	spaceId: string,
	goalId: string,
	opts: { cursor?: ContributionCursor | null; limit?: number } = {}
): Promise<{ rows: ContributionRow[]; more: boolean }> {
	const limit = Math.min(Math.max(opts.limit ?? CONTRIBUTIONS_PAGE_SIZE, 1), 100);
	const cursor = opts.cursor;
	const rows = await db
		.select({
			id: goalContributions.id,
			amountMinor: goalContributions.amountMinor,
			note: goalContributions.note,
			author: users.name,
			createdAt: goalContributions.createdAt
		})
		.from(goalContributions)
		.leftJoin(users, eq(users.id, goalContributions.createdByUserId))
		.where(
			and(
				eq(goalContributions.spaceId, spaceId),
				eq(goalContributions.goalId, goalId),
				isNull(goalContributions.deletedAt),
				cursor
					? sql`(${goalContributions.createdAt} < ${cursor.createdAt}
						or (${goalContributions.createdAt} = ${cursor.createdAt} and ${goalContributions.id} < ${cursor.id}))`
					: undefined
			)
		)
		.orderBy(sql`${goalContributions.createdAt} desc`, sql`${goalContributions.id} desc`)
		.limit(limit + 1);
	// Live rows only (the query filters `deleted_at is null`), and the CHECK guarantees a live row has its
	// amount and time.
	const live = rows.slice(0, limit).map((r) => ({
		...r,
		amountMinor: r.amountMinor as number,
		createdAt: r.createdAt as number
	}));
	return { rows: live, more: rows.length > limit };
}
