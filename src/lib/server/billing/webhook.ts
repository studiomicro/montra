import { and, eq, inArray, sql } from 'drizzle-orm';
import { PERIOD_DAYS, PLAN_CATALOGUE } from '#lib/shared/billing/plans';
import type { Db } from '../db';
import { billingEvents, billingRefunds, type BillingEventKind } from '../db/schema';
import { newId } from '../util';
import { CHECKOUT_TTL_MS } from './checkout';
import { creditGrantStep, notDowngrade, planGrantSteps } from './plan-state';
import type { ActiveProvider, VerifiedEvent } from './provider';

/** Largest webhook body read (64 KiB); a provider event is a few hundred bytes. */
export const WEBHOOK_BODY_MAX_BYTES = 64 * 1024;

/**
 * `applied`: a new payment event, its effect written. `ignored_paid`: a new, verified payment that granted
 * nothing (a lower tier while a higher plan runs, or its checkout had expired) — stored as
 * `paid_not_applied` with a pending `billing_refunds` row (billing/refunds.ts). `recorded`: a new event with no effect (a failed
 * payment). `replay`: the event (or another payment for the same checkout) was already processed; the
 * existing row's `replay_count` went up, nothing else.
 */
export type WebhookOutcome =
	| { status: 200; outcome: 'applied' | 'ignored_paid' | 'recorded' | 'replay' }
	| { status: 400 | 401 };

/**
 * Handles one webhook delivery (FN-30). Unsigned, wrongly signed, stale or (with no active provider)
 * unverifiable deliveries: 401, nothing written. Signed but unacceptable (unknown event type, malformed JSON,
 * unknown checkout, amount or currency not the checkout's): 400, nothing written.
 *
 * A valid event is inserted with ON CONFLICT DO NOTHING on (provider, provider_event_id) — and, for a
 * payment, on (provider, reference) — and its effect (plan period + the plan's credits, audited in
 * `plan_changes`) is written in the SAME `db.batch`, guarded on that insert's own row existing as
 * `payment_succeeded`. Whether a payment applies is decided in SQL inside the insert (not a downgrade, checkout
 * not expired), so the stored kind and the effect cannot disagree. A replayed, concurrently retried or
 * re-identified delivery never applies twice, and a failure arriving after the success changes nothing.
 */
export async function processWebhook(
	db: Db,
	active: ActiveProvider | null,
	raw: { body: Uint8Array; headers: Headers },
	now: number
): Promise<WebhookOutcome> {
	if (!active) return { status: 401 };
	const verdict = await active.provider.verifyWebhook(raw, active.secret, now);
	if (!verdict.ok) return { status: verdict.reason === 'signature' ? 401 : 400 };
	const event = verdict.event;
	const providerId = active.provider.id;

	const checkout = await db
		.select({
			userId: billingEvents.userId,
			plan: billingEvents.plan,
			amountMinor: billingEvents.amountMinor,
			currency: billingEvents.currency,
			createdAt: billingEvents.createdAt
		})
		.from(billingEvents)
		.where(
			and(
				eq(billingEvents.provider, providerId),
				eq(billingEvents.kind, 'checkout_created'),
				eq(billingEvents.reference, event.reference)
			)
		)
		.get();
	if (
		!checkout?.userId ||
		(checkout.plan !== 'pro' && checkout.plan !== 'agen') ||
		checkout.amountMinor !== event.amountMinor ||
		checkout.currency !== event.currency
	)
		return { status: 400 };
	const userId = checkout.userId;
	const plan = checkout.plan;

	const eventRowId = newId();
	let inserted: { kind: BillingEventKind }[];
	if (event.kind === 'payment_succeeded') {
		// A checkout past its expiry never applies (L5); otherwise it applies unless it would downgrade (L1).
		const expired = now - checkout.createdAt > CHECKOUT_TTL_MS;
		const kind = expired
			? sql`'paid_not_applied'`
			: sql`case when ${notDowngrade(userId, plan, now)} then 'payment_succeeded' else 'paid_not_applied' end`;
		const insert = db
			.insert(billingEvents)
			.select((qb) =>
				qb
					.select({
						id: sql`${eventRowId}`.as('id'),
						userId: sql`${userId}`.as('user_id'),
						provider: sql`${providerId}`.as('provider'),
						providerEventId: sql`${event.eventId}`.as('provider_event_id'),
						kind: kind.as('kind'),
						reference: sql`${event.reference}`.as('reference'),
						plan: sql`${plan}`.as('plan'),
						amountMinor: sql`${event.amountMinor}`.as('amount_minor'),
						currency: sql`${event.currency}`.as('currency'),
						signatureValid: sql`1`.as('signature_valid'),
						createdAt: sql`${now}`.as('created_at'),
						replayCount: sql`0`.as('replay_count'),
						lastSeenAt: sql`null`.as('last_seen_at')
					})
					.from(sql`(select 1)`)
					.where(sql`1`)
			)
			.onConflictDoNothing()
			.returning({ kind: billingEvents.kind });
		const entry = PLAN_CATALOGUE[plan];
		const trigger = sql`exists (select 1 from billing_events e where e.id = ${eventRowId}
			and e.kind = 'payment_succeeded')`;
		const { audit, upsert, guard } = planGrantSteps(
			db,
			{
				userId,
				plan,
				days: PERIOD_DAYS[entry.billingPeriod],
				billingPeriod: entry.billingPeriod,
				source: 'payment',
				referenceId: eventRowId,
				now
			},
			trigger,
			newId()
		);
		const grant = creditGrantStep(
			db,
			{
				id: newId(),
				userId,
				delta: entry.monthlyCreditGrant,
				reason: 'monthly_grant',
				referenceId: eventRowId,
				now
			},
			guard
		);
		// A payment that granted nothing owes a refund: its obligation is selected from the event row this batch
		// stored, so the stored kind and the obligation cannot disagree, and a replay (no new row) adds none.
		const refund = db.insert(billingRefunds).select((qb) =>
			qb
				.select({
					id: sql`${newId()}`.as('id'),
					billingEventId: billingEvents.id,
					userId: billingEvents.userId,
					provider: billingEvents.provider,
					reference: billingEvents.reference,
					amountMinor: billingEvents.amountMinor,
					currency: billingEvents.currency,
					reason: sql`${expired ? 'checkout_expired' : 'plan_higher'}`.as('reason'),
					status: sql`'pending'`.as('status'),
					providerRefundId: sql`null`.as('provider_refund_id'),
					createdAt: sql`${now}`.as('created_at'),
					updatedAt: sql`${now}`.as('updated_at'),
					resolvedAt: sql`null`.as('resolved_at')
				})
				.from(billingEvents)
				.where(and(eq(billingEvents.id, eventRowId), eq(billingEvents.kind, 'paid_not_applied')))
		);
		// The grant goes first: its guard reads the plan state before the upsert changes it, like the audit.
		const results = await db.batch([insert, refund, grant, audit, upsert]);
		inserted = results[0];
	} else {
		inserted = await db
			.insert(billingEvents)
			.values({
				id: eventRowId,
				userId,
				provider: providerId,
				providerEventId: event.eventId,
				kind: event.kind,
				reference: event.reference,
				plan,
				amountMinor: event.amountMinor,
				currency: event.currency,
				signatureValid: true,
				createdAt: now
			})
			.onConflictDoNothing()
			.returning({ kind: billingEvents.kind });
	}
	const row = inserted[0];
	if (row?.kind === 'payment_succeeded') return { status: 200, outcome: 'applied' };
	if (row?.kind === 'paid_not_applied') return { status: 200, outcome: 'ignored_paid' };
	if (row) return { status: 200, outcome: 'recorded' };

	await countReplay(db, providerId, event, now);
	return { status: 200, outcome: 'replay' };
}

/**
 * A replay adds no row (L5): the original event's row — or, for a payment re-sent under a new event id, the
 * checkout's payment row — gets `replay_count + 1` and `last_seen_at` (the only update its trigger allows).
 */
async function countReplay(
	db: Db,
	providerId: ActiveProvider['provider']['id'],
	event: VerifiedEvent,
	now: number
) {
	const bump = { replayCount: sql`${billingEvents.replayCount} + 1`, lastSeenAt: now };
	const same = await db
		.update(billingEvents)
		.set(bump)
		.where(
			and(eq(billingEvents.provider, providerId), eq(billingEvents.providerEventId, event.eventId))
		)
		.returning({ id: billingEvents.id });
	if (same.length > 0 || event.kind !== 'payment_succeeded') return;
	await db
		.update(billingEvents)
		.set(bump)
		.where(
			and(
				eq(billingEvents.provider, providerId),
				eq(billingEvents.reference, event.reference),
				inArray(billingEvents.kind, ['payment_succeeded', 'paid_not_applied'])
			)
		);
}
