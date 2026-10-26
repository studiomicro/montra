import { z } from 'zod';
import { equalConstantTime } from '../auth/password';
import { bytesToHex, randomToken } from '../util';
import type { Checkout, PaymentProvider, WebhookVerdict } from './provider';

/**
 * The mock payment provider (FN-30, "mode uji"): the only PaymentProvider this pass. Its checkout is a
 * same-origin page that charges nothing; "paying" there makes the app post a signed event to its own webhook,
 * so the real verification path (HMAC-SHA256 over the raw body, constant-time compare, timestamp tolerance,
 * replay protection) runs on every mock payment — never a stub that always says yes.
 *
 * Signature header: `t=<unix ms>,v1=<hex HMAC-SHA256(secret, "<t>." + raw body)>`. The timestamp is inside the
 * signed message, so a captured delivery cannot be re-dated.
 */

export const MOCK_SIGNATURE_HEADER = 'x-financer-mock-signature';
/** A delivery signed more than this far from the server's clock (either way) is refused. */
export const MOCK_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
export const MOCK_SECRET_MIN_LENGTH = 32;

const SIGNATURE = /^t=(\d{13}),v1=([0-9a-f]{64})$/;
const ID = /^[A-Za-z0-9_.:-]+$/;

const eventSchema = z.strictObject({
	id: z.string().min(1).max(100).regex(ID),
	type: z.enum(['payment.succeeded', 'payment.failed']),
	data: z.strictObject({
		reference: z.string().min(1).max(100).regex(ID),
		amount_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		currency: z.string().regex(/^[A-Z]{3}$/)
	})
});
type MockEventBody = z.infer<typeof eventSchema>;

async function hmacHex(secret: string, message: Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return bytesToHex(await crypto.subtle.sign('HMAC', key, message as BufferSource));
}

function signedMessage(t: string, body: Uint8Array): Uint8Array {
	const prefix = new TextEncoder().encode(`${t}.`);
	const out = new Uint8Array(prefix.byteLength + body.byteLength);
	out.set(prefix, 0);
	out.set(body, prefix.byteLength);
	return out;
}

/** The signature header value for `body` at `now` (what the mock "provider" sends with each event). */
export async function signMockEvent(body: string, secret: string, now: number): Promise<string> {
	const t = String(Math.trunc(now)).padStart(13, '0');
	return `t=${t},v1=${await hmacHex(secret, signedMessage(t, new TextEncoder().encode(body)))}`;
}

/** The JSON body of a mock payment event for a checkout. */
export function mockEventBody(
	eventId: string,
	outcome: 'succeeded' | 'failed',
	checkout: { reference: string; amountMinor: number; currency: string }
): string {
	const body: MockEventBody = {
		id: eventId,
		type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
		data: {
			reference: checkout.reference,
			amount_minor: checkout.amountMinor,
			currency: checkout.currency
		}
	};
	return JSON.stringify(body);
}

export const mockProvider: PaymentProvider = {
	id: 'mock',

	// The mock needs nothing from the input: the amount and plan live on the checkout's billing event.
	async createCheckout(): Promise<Checkout> {
		const providerReference = `mock_${randomToken(18)}`;
		return { checkoutUrl: `/pengaturan/paket/uji/${providerReference}`, providerReference };
	},

	async verifyWebhook(raw, secret, now): Promise<WebhookVerdict> {
		const header = raw.headers.get(MOCK_SIGNATURE_HEADER) ?? '';
		const match = SIGNATURE.exec(header);
		if (!match || secret.length < MOCK_SECRET_MIN_LENGTH) return { ok: false, reason: 'signature' };
		const [, t = '', given = ''] = match;
		const expected = await hmacHex(secret, signedMessage(t, raw.body));
		// Compared before the timestamp, so a stale and a wrong signature cost the same work.
		const valid = equalConstantTime(expected, given);
		if (!valid || Math.abs(now - Number(t)) > MOCK_SIGNATURE_TOLERANCE_MS)
			return { ok: false, reason: 'signature' };
		let json: unknown;
		try {
			json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.body));
		} catch {
			return { ok: false, reason: 'payload' };
		}
		const parsed = eventSchema.safeParse(json);
		if (!parsed.success) return { ok: false, reason: 'payload' };
		const { id, type, data } = parsed.data;
		return {
			ok: true,
			event: {
				eventId: id,
				kind: type === 'payment.succeeded' ? 'payment_succeeded' : 'payment_failed',
				reference: data.reference,
				amountMinor: data.amount_minor,
				currency: data.currency
			}
		};
	}
};

/** The app's own webhook path (the mock "provider" delivers there). */
const WEBHOOK_PATH = '/api/v1/billing/webhook';

/**
 * Plays the provider for a mock checkout: signs a payment event with the webhook secret and POSTs it to the
 * app's own webhook through `fetchFn` (SvelteKit's `event.fetch`, which answers a same-origin path in process),
 * so the delivery passes the same verification as any other. Returns the webhook's `status` field on a 200,
 * else null (refused or unreachable). Never called for a real provider.
 */
export async function deliverMockEvent(
	fetchFn: typeof fetch,
	secret: string,
	checkout: { reference: string; amountMinor: number; currency: string },
	outcome: 'succeeded' | 'failed',
	now: number
): Promise<string | null> {
	const body = mockEventBody(`evt_${randomToken(16)}`, outcome, checkout);
	try {
		const response = await fetchFn(WEBHOOK_PATH, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				[MOCK_SIGNATURE_HEADER]: await signMockEvent(body, secret, now)
			},
			body
		});
		if (!response.ok) return null;
		const json = (await response.json()) as { status?: unknown };
		return typeof json.status === 'string' ? json.status : null;
	} catch {
		return null;
	}
}
