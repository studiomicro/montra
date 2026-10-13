import { and, sql, type SQL } from 'drizzle-orm';
import type { LedgerReason } from '#lib/shared/billing/credits';
import {
	DAY_MS,
	planRank,
	STARTER_CREDITS,
	type BillingPeriod,
	type PaidPlan
} from '#lib/shared/billing/plans';
import type { Db } from '../db';
import { noClaimMarker, type ClaimHashes } from './claims';
import { creditLedger, planChanges, userPlanState } from '../db/schema';
import { newId } from '../util';

/**
 * Guarded `db.batch` items that change an account's plan or grant credits (FN-30). Each item carries a
 * `trigger`: an SQL condition true only when the batch's own triggering row exists (the billing event or
 * voucher redemption inserted earlier in the same batch), so a replayed delivery whose insert added nothing
 * applies nothing. D1 runs a batch as one transaction: the guards and writes see one consistent state.
 */

const rankSql = (col: SQL) => sql`(case ${col} when 'agen' then 2 when 'pro' then 1 else 0 end)`;

/** SQL: true unless a higher paid plan is in force for `userId` at `now` (a plan is never downgraded). */
export function notDowngrade(userId: string, plan: PaidPlan, now: number): SQL {
	return sql`not exists (select 1 from user_plan_state s where s.user_id = ${userId}
		and s.plan <> 'gratis' and s.current_period_end > ${now}
		and ${rankSql(sql`s.plan`)} > ${planRank(plan)})`;
}

export interface PlanGrant {
	userId: string;
	plan: PaidPlan;
	days: number;
	/** Set for a paid period, null for a voucher's time-boxed plan. */
	billingPeriod: BillingPeriod | null;
	source: 'payment' | 'voucher';
	referenceId: string;
	now: number;
}

/**
 * Two items: the `plan_changes` audit row, then the `user_plan_state` upsert, both under the same guard
 * (trigger ∧ not a downgrade) and computing the same new period end from the state before either ran. The
 * same plan still in force is extended from its current end; a lower or lapsed plan restarts from `now`.
 */
export function planGrantSteps(db: Db, grant: PlanGrant, trigger: SQL, id: string) {
	const { userId, plan, days, now } = grant;
	const length = days * DAY_MS;
	const guard = and(trigger, notDowngrade(userId, plan, now)) as SQL;
	const newEnd = sql<number>`coalesce((select s.current_period_end from user_plan_state s
		where s.user_id = ${userId} and s.plan = ${plan} and s.current_period_end > ${now}), ${now}) + ${length}`;
	const fromPlan = sql`coalesce((select case when s.plan <> 'gratis' and s.current_period_end > ${now}
		then s.plan else 'gratis' end from user_plan_state s where s.user_id = ${userId}), 'gratis')`;
	const audit = db.insert(planChanges).select((qb) =>
		qb
			.select({
				id: sql`${id}`.as('id'),
				userId: sql`${userId}`.as('user_id'),
				fromPlan: fromPlan.as('from_plan'),
				toPlan: sql`${plan}`.as('to_plan'),
				periodEnd: newEnd.as('period_end'),
				source: sql`${grant.source}`.as('source'),
				referenceId: sql`${grant.referenceId}`.as('reference_id'),
				createdAt: sql`${now}`.as('created_at')
			})
			.from(sql`(select 1)`)
			.where(guard)
	);
	const upsert = db
		.insert(userPlanState)
		.select((qb) =>
			qb
				.select({
					userId: sql`${userId}`.as('user_id'),
					plan: sql`${plan}`.as('plan'),
					billingPeriod: sql`${grant.billingPeriod}`.as('billing_period'),
					currentPeriodEnd: newEnd.as('current_period_end'),
					createdAt: sql`${now}`.as('created_at'),
					updatedAt: sql`${now}`.as('updated_at')
				})
				.from(sql`(select 1)`)
				.where(guard)
		)
		.onConflictDoUpdate({
			target: userPlanState.userId,
			set: {
				plan: sql`excluded.plan`,
				billingPeriod: sql`excluded.billing_period`,
				currentPeriodEnd: sql`excluded.current_period_end`,
				updatedAt: sql`excluded.updated_at`
			}
		});
	return { audit, upsert, guard };
}
export type PlanSteps = ReturnType<typeof planGrantSteps>;

/**
 * One ledger grant (positive `delta`), written only when `guard` holds and the balance after it stays an
 * exact safe integer (the CHECK bounds one row; this bounds the sum).
 */
export function creditGrantStep(
	db: Db,
	input: {
		id: string;
		userId: string;
		delta: number;
		reason: LedgerReason;
		referenceId: string | null;
		now: number;
	},
	guard: SQL
) {
	return db.insert(creditLedger).select((qb) =>
		qb
			.select({
				id: sql`${input.id}`.as('id'),
				userId: sql`${input.userId}`.as('user_id'),
				delta: sql`${input.delta}`.as('delta'),
				reason: sql`${input.reason}`.as('reason'),
				referenceId: sql`${input.referenceId}`.as('reference_id'),
				createdAt: sql`${input.now}`.as('created_at')
			})
			.from(sql`(select 1)`)
			.where(and(guard, balanceStaysSafe(input.userId, input.delta)))
	);
}

/** SQL: the account's balance plus `delta` is still within ±Number.MAX_SAFE_INTEGER. */
export function balanceStaysSafe(userId: string, delta: number): SQL {
	return sql`abs((select coalesce(sum(l.delta), 0) from credit_ledger l where l.user_id = ${userId}) + ${delta})
		<= ${Number.MAX_SAFE_INTEGER}`;
}

/**
 * A new account's billing rows, for the sign-up batch (accounts.ts): Gratis plan state and the starter grant
 * (STARTER_CREDITS), committed with the account row or not at all. With `claim` (CLAIM_HASH_KEY configured), the
 * grant is one guarded `INSERT … SELECT … WHERE NOT EXISTS` a `starter_grant` marker of this address
 * (billing/claims.ts): an address whose deleted account already had the starter credits starts at 0, with no
 * message (owner decision 7). Without it the grant is unconditional.
 */
export function signUpBillingSteps(
	db: Db,
	userId: string,
	now: number,
	claim: ClaimHashes | null = null
) {
	return [
		db.insert(userPlanState).values({
			userId,
			plan: 'gratis',
			billingPeriod: null,
			currentPeriodEnd: null,
			createdAt: now,
			updatedAt: now
		}),
		creditGrantStep(
			db,
			{
				id: newId(),
				userId,
				delta: STARTER_CREDITS,
				reason: 'starter_grant',
				referenceId: null,
				now
			},
			claim ? noClaimMarker(claim, 'starter_grant') : sql`1 = 1`
		)
	] as const;
}
