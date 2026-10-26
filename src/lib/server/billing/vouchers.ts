import { and, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import { planRank, type PaidPlan } from '#lib/shared/billing/plans';
import { generateVoucherCode, normalizeVoucherCode } from '#lib/shared/billing/voucher-code';
import { clientKey, countAttempt } from '../auth/throttle';
import type { Db } from '../db';
import { vouchers, voucherRedemptions, type VoucherKind } from '../db/schema';
import { isUniqueViolation, newId, sha256Hex } from '../util';
import { noClaimMarker, type ClaimHashes } from './claims';
import { planOf } from './gate';
import {
	balanceStaysSafe,
	creditGrantStep,
	notDowngrade,
	planGrantSteps,
	type PlanSteps
} from './plan-state';

/** SHA-256 of a code's canonical form (normalizeVoucherCode): the only form ever stored. */
const voucherCodeHash = (canonical: string) => sha256Hex(canonical);

/** Voucher attempts per budget window (THROTTLE_WINDOW_MS), per account and per client address each. */
const VOUCHER_ATTEMPTS_MAX = 20;

/**
 * True when this attempt is over either voucher budget: the signed-in account's, or the client address's
 * (CF-Connecting-IP, IPv6 by /64; stored only as a SHA-256 by countAttempt), so many cheap accounts on one
 * client share one budget. Fails CLOSED: if D1 cannot count, the attempt is refused (unlike sign-in, where
 * the credential check would fail anyway, a voucher guess has no second line of defence).
 */
export async function voucherAttemptLimited(
	db: Db,
	request: Request,
	userId: string,
	now: number
): Promise<boolean> {
	try {
		const overUser = await countAttempt(db, `voucher:user:${userId}`, now, VOUCHER_ATTEMPTS_MAX);
		const overClient = await countAttempt(
			db,
			`voucher:client:${clientKey(request)}`,
			now,
			VOUCHER_ATTEMPTS_MAX
		);
		return overUser || overClient;
	} catch (e) {
		console.error('voucher throttle unavailable', e instanceof Error ? e.name : 'unknown');
		return true;
	}
}

export type RedeemResult =
	| {
			ok: true;
			kind: VoucherKind;
			credits: number | null;
			plan: PaidPlan | null;
			days: number | null;
	  }
	| {
			ok: false;
			reason: 'not_found' | 'expired' | 'used_up' | 'already_redeemed' | 'plan_higher';
	  };

/**
 * Redeems `code` for `userId` (always `locals.user.id`). One `db.batch` (one D1 transaction):
 * 1. the `voucher_redemptions` insert, selected from the voucher row only while it is live, unexpired and
 *    `redemption_count < max_redemptions` (and, for a plan voucher, the user has no higher plan in force; and,
 *    with `claim`, no deleted account of this address redeemed it: a `voucher` marker, billing/claims.ts).
 *    The (voucher_id, user_id) unique index refuses a second redemption by the same account outright (the
 *    whole batch rolls back), never an application check;
 * 2. `redemption_count + 1`, guarded on step 1's row existing (the CHECK also caps it at max_redemptions);
 * 3. the effect: a credit grant or the plan period (+ its `plan_changes` audit), guarded the same way.
 * D1 serialises batches, so N concurrent redemptions of a 1-use voucher yield exactly one success.
 */
export async function redeemVoucher(
	db: Db,
	userId: string,
	code: string,
	now: number,
	claim: ClaimHashes | null = null
): Promise<RedeemResult> {
	const normalized = normalizeVoucherCode(code);
	if (!normalized) return { ok: false, reason: 'not_found' };
	const voucher = await db
		.select()
		.from(vouchers)
		.where(
			and(eq(vouchers.codeHash, await voucherCodeHash(normalized)), isNull(vouchers.deletedAt))
		)
		.get();
	if (!voucher) return { ok: false, reason: 'not_found' };
	if (voucher.expiresAt !== null && voucher.expiresAt <= now)
		return { ok: false, reason: 'expired' };
	// A deleted account of this address already redeemed it: named here, decided by the guard in step 1.
	if (claim && (await markedForVoucher(db, claim, voucher.id)))
		return { ok: false, reason: 'already_redeemed' };
	if (voucher.kind === 'plan_days' && voucher.plan && voucher.plan !== 'gratis') {
		if (planRank(await planOf(db, userId, now)) > planRank(voucher.plan))
			return { ok: false, reason: 'plan_higher' };
	}

	const redemptionId = newId();
	const trigger = sql`exists (select 1 from voucher_redemptions r where r.id = ${redemptionId})`;
	const live = and(
		eq(vouchers.id, voucher.id),
		isNull(vouchers.deletedAt),
		or(isNull(vouchers.expiresAt), gt(vouchers.expiresAt, now)),
		sql`${vouchers.redemptionCount} < ${vouchers.maxRedemptions}`
	) as SQL;

	let extra: SQL | undefined;
	let effect: [ReturnType<typeof creditGrantStep>] | [PlanSteps['audit'], PlanSteps['upsert']];
	if (voucher.kind === 'credits' && voucher.creditsAmount !== null) {
		extra = balanceStaysSafe(userId, voucher.creditsAmount);
		effect = [
			creditGrantStep(
				db,
				{
					id: newId(),
					userId,
					delta: voucher.creditsAmount,
					reason: 'voucher_redeemed',
					referenceId: voucher.id,
					now
				},
				trigger
			)
		];
	} else if (
		voucher.kind === 'plan_days' &&
		(voucher.plan === 'pro' || voucher.plan === 'agen') &&
		voucher.planDays !== null
	) {
		// The downgrade guard joins step 1, so the redemption itself is refused, not just its effect.
		extra = notDowngrade(userId, voucher.plan, now);
		const steps = planGrantSteps(
			db,
			{
				userId,
				plan: voucher.plan,
				days: voucher.planDays,
				billingPeriod: null,
				source: 'voucher',
				referenceId: redemptionId,
				now
			},
			trigger,
			newId()
		);
		effect = [steps.audit, steps.upsert];
	} else {
		return { ok: false, reason: 'not_found' };
	}

	const insert = db
		.insert(voucherRedemptions)
		.select((qb) =>
			qb
				.select({
					id: sql`${redemptionId}`.as('id'),
					voucherId: vouchers.id,
					userId: sql`${userId}`.as('user_id'),
					redeemedAt: sql`${now}`.as('redeemed_at')
				})
				.from(vouchers)
				.where(
					and(live, extra, claim ? noClaimMarker(claim, 'voucher', sql`${vouchers.id}`) : undefined)
				)
		)
		.returning({ id: voucherRedemptions.id });
	const count = db
		.update(vouchers)
		.set({ redemptionCount: sql`${vouchers.redemptionCount} + 1`, updatedAt: now })
		.where(and(eq(vouchers.id, voucher.id), trigger));

	let inserted: { id: string }[];
	try {
		[inserted] = await db.batch([insert, count, ...effect]);
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, reason: 'already_redeemed' };
		throw e;
	}
	if (inserted.length === 1)
		return {
			ok: true,
			kind: voucher.kind,
			credits: voucher.kind === 'credits' ? voucher.creditsAmount : null,
			plan: voucher.kind === 'plan_days' && voucher.plan !== 'gratis' ? voucher.plan : null,
			days: voucher.kind === 'plan_days' ? voucher.planDays : null
		};

	// Nothing was written: say why from a fresh read (the guards above decided; this only names the reason).
	const after = await db
		.select({
			expiresAt: vouchers.expiresAt,
			deletedAt: vouchers.deletedAt,
			full: sql<number>`${vouchers.redemptionCount} >= ${vouchers.maxRedemptions}`
		})
		.from(vouchers)
		.where(eq(vouchers.id, voucher.id))
		.get();
	if (!after || after.deletedAt !== null) return { ok: false, reason: 'not_found' };
	if (claim && (await markedForVoucher(db, claim, voucher.id)))
		return { ok: false, reason: 'already_redeemed' };
	if (after.expiresAt !== null && after.expiresAt <= now) return { ok: false, reason: 'expired' };
	if (after.full) return { ok: false, reason: 'used_up' };
	return { ok: false, reason: voucher.kind === 'plan_days' ? 'plan_higher' : 'used_up' };
}

/** True when a re-claim marker of this address exists for `voucherId` (only names a refusal; never decides one). */
async function markedForVoucher(db: Db, claim: ClaimHashes, voucherId: string): Promise<boolean> {
	const [row] = await db.all<{ marked: number }>(
		sql`select not (${noClaimMarker(claim, 'voucher', sql`${voucherId}`)}) as marked`
	);
	return row?.marked === 1;
}

export interface NewVoucher {
	/** A chosen code (≥ 10 Crockford symbols after normalising); omitted → a generated 80-bit code. */
	code?: string;
	kind: VoucherKind;
	creditsAmount?: number;
	plan?: PaidPlan;
	planDays?: number;
	maxRedemptions: number;
	expiresAt?: number | null;
}

/**
 * Stores a voucher (only the hash of its code) and returns its id and the code to hand out (shown once; never
 * stored). No UI calls this (an admin screen is out of scope): it serves tests and future tooling. A chosen
 * code shorter than 10 symbols or outside Crockford base32 is refused; the table's CHECK refuses an
 * inconsistent kind/amount combination.
 */
export async function createVoucher(
	db: Db,
	input: NewVoucher,
	now: number
): Promise<{ id: string; code: string }> {
	const shown = input.code ?? generateVoucherCode();
	const code = normalizeVoucherCode(shown);
	if (!code) throw new RangeError('invalid voucher code');
	const id = newId();
	await db.insert(vouchers).values({
		id,
		codeHash: await voucherCodeHash(code),
		kind: input.kind,
		creditsAmount: input.creditsAmount ?? null,
		plan: input.plan ?? null,
		planDays: input.planDays ?? null,
		maxRedemptions: input.maxRedemptions,
		redemptionCount: 0,
		expiresAt: input.expiresAt ?? null,
		createdAt: now,
		updatedAt: now
	});
	return { id, code: shown };
}
