import { and, eq, gt, sql } from 'drizzle-orm';
import { PLAN_CATALOGUE, planRank, type PaidPlan } from '#lib/shared/billing/plans';
import type { Db } from '../db';
import { billingEvents } from '../db/schema';
import { newId } from '../util';
import { planOf } from './gate';
import type { PaymentProvider } from './provider';

/** A checkout can be completed for this long after it was started. */
export const CHECKOUT_TTL_MS = 60 * 60 * 1000;

export type StartCheckoutResult =
	{ ok: true; checkoutUrl: string } | { ok: false; reason: 'lower' };

/**
 * Starts a checkout for `plan` at its catalogue (placeholder) price and records it as a `checkout_created`
 * billing event owned by `userId` (always `locals.user.id`). A plan below the one in force is refused: a
 * payment never downgrades.
 */
export async function startCheckout(
	db: Db,
	provider: PaymentProvider,
	userId: string,
	plan: PaidPlan,
	now: number
): Promise<StartCheckoutResult> {
	if (planRank(await planOf(db, userId, now)) > planRank(plan))
		return { ok: false, reason: 'lower' };
	const entry = PLAN_CATALOGUE[plan];
	const checkout = await provider.createCheckout({
		userId,
		plan,
		amountMinor: entry.priceMinor,
		currency: entry.currency
	});
	await db.insert(billingEvents).values({
		id: newId(),
		userId,
		provider: provider.id,
		providerEventId: `checkout:${checkout.providerReference}`,
		kind: 'checkout_created',
		reference: checkout.providerReference,
		plan,
		amountMinor: entry.priceMinor,
		currency: entry.currency,
		signatureValid: true,
		createdAt: now
	});
	return { ok: true, checkoutUrl: checkout.checkoutUrl };
}

export interface CheckoutView {
	reference: string;
	plan: PaidPlan;
	amountMinor: number;
	currency: string;
	createdAt: number;
	paid: boolean;
}

/**
 * The user's own live checkout `reference` with this provider, or null: another account's reference, an
 * unknown one and an expired one get the same null (no existence oracle).
 */
export async function getCheckout(
	db: Db,
	providerId: PaymentProvider['id'],
	userId: string,
	reference: string,
	now: number
): Promise<CheckoutView | null> {
	if (reference.length > 100) return null;
	const row = await db
		.select({
			reference: billingEvents.reference,
			plan: billingEvents.plan,
			amountMinor: billingEvents.amountMinor,
			currency: billingEvents.currency,
			createdAt: billingEvents.createdAt,
			paid: sql<number>`exists (select 1 from billing_events p where p.provider = ${providerId}
				and p.reference = ${reference} and p.kind = 'payment_succeeded')`
		})
		.from(billingEvents)
		.where(
			and(
				eq(billingEvents.provider, providerId),
				eq(billingEvents.kind, 'checkout_created'),
				eq(billingEvents.reference, reference),
				eq(billingEvents.userId, userId),
				gt(billingEvents.createdAt, now - CHECKOUT_TTL_MS)
			)
		)
		.get();
	if (!row || !row.reference || (row.plan !== 'pro' && row.plan !== 'agen')) return null;
	if (row.amountMinor === null || row.currency === null) return null;
	return {
		reference: row.reference,
		plan: row.plan,
		amountMinor: row.amountMinor,
		currency: row.currency,
		createdAt: row.createdAt,
		paid: Boolean(row.paid)
	};
}
