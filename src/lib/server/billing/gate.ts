import { eq, sql } from 'drizzle-orm';
import { effectivePlan, PLAN_CATALOGUE, type Plan } from '#lib/shared/billing/plans';
import type { Db } from '../db';
import { userPlanState } from '../db/schema';

/**
 * FN-30 plan gating: the one place a feature asks what the signed-in account may do. Every caller passes
 * `locals.user.id`, never an id from the request. A hidden button is not authorization: an action that a plan
 * gates must call these on the server.
 */

export interface PlanState {
	/** The plan in force now (a lapsed paid plan is Gratis). */
	plan: Plan;
	/** The stored plan, even when lapsed (to tell the user it ended). */
	storedPlan: Plan;
	/** End of the paid period (UTC ms), null on Gratis. */
	currentPeriodEnd: number | null;
}

/**
 * The one primary-key read of the account's stored plan, as a statement a caller may also put into a `db.batch`
 * (hooks.server.ts reads it beside the current space); `planFrom` turns its rows into the plan in force.
 */
export function planStateQuery(db: Db, userId: string) {
	return db
		.select({ plan: userPlanState.plan, currentPeriodEnd: userPlanState.currentPeriodEnd })
		.from(userPlanState)
		.where(eq(userPlanState.userId, userId))
		.limit(1);
}

type PlanStateRow = { plan: Plan; currentPeriodEnd: number | null };

function planStateFrom(row: PlanStateRow | undefined, now: number): PlanState {
	return {
		plan: effectivePlan(row ?? null, now),
		storedPlan: row?.plan ?? 'gratis',
		currentPeriodEnd: row?.currentPeriodEnd ?? null
	};
}

/** The plan in force at `now` from the rows of `planStateQuery`. */
export function planFrom(rows: readonly PlanStateRow[], now: number): Plan {
	return planStateFrom(rows[0], now).plan;
}

/** The account's plan state; an account without a row (never expected after sign-up) is on Gratis. */
export async function planStateOf(db: Db, userId: string, now: number): Promise<PlanState> {
	return planStateFrom((await planStateQuery(db, userId))[0], now);
}

/** The plan in force for `userId` at `now`. */
export async function planOf(db: Db, userId: string, now: number): Promise<Plan> {
	return planFrom(await planStateQuery(db, userId), now);
}

/**
 * The account's credit balance: SUM(delta) of its ledger rows, computed in SQL (one indexed aggregate), never
 * a stored counter. Throws when the sum is not an exact safe integer (cannot happen within the CHECKed delta
 * bounds, but a wrong balance is never shown).
 */
export async function creditBalance(db: Db, userId: string): Promise<number> {
	const [row] = await db.all<{ balance: number; safe: number }>(
		sql`select coalesce(sum(delta), 0) as balance,
			abs(coalesce(sum(delta), 0)) <= ${Number.MAX_SAFE_INTEGER} as safe
			from credit_ledger where user_id = ${userId}`
	);
	const balance = row?.balance ?? 0;
	if (!row?.safe || !Number.isSafeInteger(balance)) throw new RangeError('credit balance overflow');
	return balance;
}

/** Shared spaces and more than the personal space (FN-03: a Pro feature). */
export function canUseSharedSpaces(plan: Plan): boolean {
	return PLAN_CATALOGUE[plan].maxSpaces > 1;
}

export function gmailLookbackMaxDays(plan: Plan): number {
	return PLAN_CATALOGUE[plan].gmailLookbackMaxDays;
}

export function agentEnabled(plan: Plan): boolean {
	return PLAN_CATALOGUE[plan].agentEnabled;
}
