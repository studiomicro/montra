import type { PaidPlan } from '#lib/shared/billing/plans';
import type { BillingProvider } from '../db/schema';
import { MOCK_SECRET_MIN_LENGTH, mockProvider } from './mock-provider';

/**
 * FN-30 payment-provider boundary. Domain code (checkout.ts, webhook.ts, the routes) talks only to this
 * interface; a real provider (Xendit or Midtrans, an open owner decision) is a second implementation plus its
 * own secret, wired in `activeProvider` — nothing else changes. Only the mock exists this pass: it never
 * charges anything and is reachable only when BILLING_MOCK_ENABLED is "1".
 */

interface CheckoutInput {
	userId: string;
	plan: PaidPlan;
	amountMinor: number;
	currency: string;
}

export interface Checkout {
	/** Where the user completes the payment (the mock: a same-origin "mode uji" page). */
	checkoutUrl: string;
	/** The provider's id for this checkout; payment events name it. */
	providerReference: string;
}

/** A webhook event whose signature verified and whose payload parsed. */
export interface VerifiedEvent {
	/** The provider's own idempotency key for the event. */
	eventId: string;
	kind: 'payment_succeeded' | 'payment_failed';
	reference: string;
	amountMinor: number;
	currency: string;
}

/** `signature`: missing, malformed, stale or wrong (one fixed 401). `payload`: signed but not an event we accept. */
export type WebhookVerdict =
	{ ok: true; event: VerifiedEvent } | { ok: false; reason: 'signature' | 'payload' };

export interface PaymentProvider {
	id: BillingProvider;
	createCheckout(input: CheckoutInput): Promise<Checkout>;
	verifyWebhook(
		raw: { body: Uint8Array; headers: Headers },
		secret: string,
		now: number
	): Promise<WebhookVerdict>;
}

export interface ActiveProvider {
	provider: PaymentProvider;
	secret: string;
	/** True for the mock: every screen it reaches carries the "mode uji" banner. */
	testMode: boolean;
}

/**
 * The provider payments go through, or null when none is configured. Today: the mock, only while
 * BILLING_MOCK_ENABLED is exactly "1" and MOCK_PAYMENT_WEBHOOK_SECRET is set (≥ 32 characters). Otherwise the
 * upgrade UI is absent and the webhook refuses every delivery with its fixed 401.
 */
export function activeProvider(
	env: { BILLING_MOCK_ENABLED?: string; MOCK_PAYMENT_WEBHOOK_SECRET?: string } | undefined
): ActiveProvider | null {
	const secret = env?.MOCK_PAYMENT_WEBHOOK_SECRET ?? '';
	if (env?.BILLING_MOCK_ENABLED !== '1' || secret.length < MOCK_SECRET_MIN_LENGTH) return null;
	return { provider: mockProvider, secret, testMode: true };
}
