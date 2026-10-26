import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import type { RefundReason, RefundStatus } from '#lib/shared/billing/refunds';
import { billingEvents, billingRefunds } from '../db/schema';

/**
 * Refund obligations (FN-30 hardening): one `billing_refunds` row per verified payment that granted nothing
 * (`paid_not_applied`), written by the webhook in the same batch as that event. MONTRA never moves money: a row
 * records that a refund is owed until a person, or a later provider integration, closes it with
 * `recordRefundOutcome`. Nothing in this module talks to a payment provider.
 */

/** Most rows `pendingRefunds` lists (the count is exact regardless). */
export const REFUND_LIST_LIMIT = 100;
/** Most rows `refundsForUser` lists. */
const USER_REFUND_LIST_LIMIT = 20;
/** A provider's refund id as stored: what the table's CHECK allows. */
const PROVIDER_REFUND_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export interface PendingRefund {
	id: string;
	provider: string;
	reference: string | null;
	amountMinor: number | null;
	currency: string | null;
	reason: RefundReason;
	createdAt: number;
}

/**
 * The operator's list: the exact number of pending obligations and the newest REFUND_LIST_LIMIT of them, with the
 * full provider reference (refunded by reference in the provider's dashboard). Nothing identifies a person: no
 * user id, e-mail or name.
 */
export async function pendingRefunds(db: Db): Promise<{ count: number; rows: PendingRefund[] }> {
	const [counted] = await db
		.select({ n: sql<number>`count(*)` })
		.from(billingRefunds)
		.where(eq(billingRefunds.status, 'pending'));
	const rows = await db
		.select({
			id: billingRefunds.id,
			provider: billingRefunds.provider,
			reference: billingRefunds.reference,
			amountMinor: billingRefunds.amountMinor,
			currency: billingRefunds.currency,
			reason: billingRefunds.reason,
			createdAt: billingRefunds.createdAt
		})
		.from(billingRefunds)
		.where(eq(billingRefunds.status, 'pending'))
		.orderBy(desc(billingRefunds.createdAt), desc(billingRefunds.id))
		.limit(REFUND_LIST_LIMIT);
	return { count: counted?.n ?? 0, rows };
}

export interface UserRefund {
	id: string;
	provider: string;
	amountMinor: number | null;
	currency: string | null;
	plan: string | null;
	status: RefundStatus;
	createdAt: number;
}

/** The signed-in user's own obligations (always `locals.user.id`), newest first, at most USER_REFUND_LIST_LIMIT. */
export async function refundsForUser(db: Db, userId: string): Promise<UserRefund[]> {
	return db
		.select({
			id: billingRefunds.id,
			provider: billingRefunds.provider,
			amountMinor: billingRefunds.amountMinor,
			currency: billingRefunds.currency,
			plan: billingEvents.plan,
			status: billingRefunds.status,
			createdAt: billingRefunds.createdAt
		})
		.from(billingRefunds)
		.leftJoin(billingEvents, eq(billingEvents.id, billingRefunds.billingEventId))
		.where(eq(billingRefunds.userId, userId))
		.orderBy(desc(billingRefunds.createdAt), desc(billingRefunds.id))
		.limit(USER_REFUND_LIST_LIMIT);
}

/**
 * Closes one pending obligation as `refunded` (optionally with the provider's refund id) or `cancelled`: one
 * guarded `UPDATE … WHERE status = 'pending' RETURNING`, so of any number of concurrent calls exactly one wins.
 * No route or UI calls this yet (owner decision 3): it serves the real-provider integration or a later admin
 * action. A provider refund id outside `[A-Za-z0-9_.:-]{1,100}` is a RangeError.
 */
export async function recordRefundOutcome(
	db: Db,
	refundId: string,
	outcome: 'refunded' | 'cancelled',
	providerRefundId: string | null,
	now: number
): Promise<'done' | 'already_resolved' | 'not_found'> {
	if (providerRefundId !== null && !PROVIDER_REFUND_ID.test(providerRefundId))
		throw new RangeError('invalid provider refund id');
	const updated = await db
		.update(billingRefunds)
		.set({ status: outcome, providerRefundId, resolvedAt: now, updatedAt: now })
		.where(and(eq(billingRefunds.id, refundId), eq(billingRefunds.status, 'pending')))
		.returning({ id: billingRefunds.id });
	if (updated.length === 1) return 'done';
	const existing = await db
		.select({ id: billingRefunds.id })
		.from(billingRefunds)
		.where(eq(billingRefunds.id, refundId))
		.get();
	return existing ? 'already_resolved' : 'not_found';
}
