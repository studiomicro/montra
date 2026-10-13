import { describe, expect, it } from 'vitest';
import {
	MOCK_SIGNATURE_HEADER,
	MOCK_SIGNATURE_TOLERANCE_MS,
	mockEventBody,
	mockProvider,
	signMockEvent
} from './mock-provider';
import { activeProvider } from './provider';

const SECRET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NOW = 1_800_000_000_000;
const checkout = { reference: 'mock_ref1', amountMinor: 4_900_000, currency: 'IDR' };
const enc = (s: string) => new TextEncoder().encode(s);

async function verify(body: string, signature: string | null, now = NOW, secret = SECRET) {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (signature !== null) headers.set(MOCK_SIGNATURE_HEADER, signature);
	return mockProvider.verifyWebhook({ body: enc(body), headers }, secret, now);
}

describe('mock provider webhook verification', () => {
	const body = mockEventBody('evt_1', 'succeeded', checkout);

	it('accepts a body signed with the secret within the tolerance', async () => {
		const v = await verify(body, await signMockEvent(body, SECRET, NOW - 1000));
		expect(v).toEqual({
			ok: true,
			event: {
				eventId: 'evt_1',
				kind: 'payment_succeeded',
				reference: 'mock_ref1',
				amountMinor: 4_900_000,
				currency: 'IDR'
			}
		});
	});

	it('refuses a missing, malformed or wrong-key signature as `signature`', async () => {
		const good = await signMockEvent(body, SECRET, NOW);
		expect(await verify(body, null)).toEqual({ ok: false, reason: 'signature' });
		expect(await verify(body, 'garbage')).toEqual({ ok: false, reason: 'signature' });
		expect(await verify(body, good.toUpperCase())).toEqual({ ok: false, reason: 'signature' });
		expect(await verify(body, `${good},v2=00`)).toEqual({ ok: false, reason: 'signature' });
		expect(await verify(body, await signMockEvent(body, OTHER, NOW))).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it('refuses a tampered body or a re-dated signature', async () => {
		const sig = await signMockEvent(body, SECRET, NOW);
		expect(await verify(body.replace('4900000', '1'), sig)).toEqual({
			ok: false,
			reason: 'signature'
		});
		const redated = sig.replace(/^t=\d+/, `t=${NOW + 1}`);
		expect(await verify(body, redated)).toEqual({ ok: false, reason: 'signature' });
	});

	it('refuses a stale or future timestamp outside the tolerance', async () => {
		const old = await signMockEvent(body, SECRET, NOW - MOCK_SIGNATURE_TOLERANCE_MS - 1);
		expect(await verify(body, old)).toEqual({ ok: false, reason: 'signature' });
		const future = await signMockEvent(body, SECRET, NOW + MOCK_SIGNATURE_TOLERANCE_MS + 1);
		expect(await verify(body, future)).toEqual({ ok: false, reason: 'signature' });
		const edge = await signMockEvent(body, SECRET, NOW - MOCK_SIGNATURE_TOLERANCE_MS);
		expect((await verify(body, edge)).ok).toBe(true);
	});

	it('refuses a short secret even when the signature matches it', async () => {
		const sig = await signMockEvent(body, 'short', NOW);
		expect(await verify(body, sig, NOW, 'short')).toEqual({ ok: false, reason: 'signature' });
	});

	it('answers `payload` for a signed but unacceptable event (unknown type, extra keys, bad JSON)', async () => {
		const cases = [
			JSON.stringify({
				id: 'e',
				type: 'payment.refunded',
				data: { reference: 'r', amount_minor: 1, currency: 'IDR' }
			}),
			JSON.stringify({
				id: 'e',
				type: 'payment.succeeded',
				data: { reference: 'r', amount_minor: 1.5, currency: 'IDR' }
			}),
			JSON.stringify({
				id: 'e',
				type: 'payment.succeeded',
				data: { reference: 'r', amount_minor: 1, currency: 'IDR' },
				user_id: 'x'
			}),
			JSON.stringify({
				id: 'e e',
				type: 'payment.succeeded',
				data: { reference: 'r', amount_minor: 1, currency: 'IDR' }
			}),
			'{"id":',
			'[]'
		];
		for (const b of cases)
			expect(await verify(b, await signMockEvent(b, SECRET, NOW))).toEqual({
				ok: false,
				reason: 'payload'
			});
	});
});

describe('activeProvider', () => {
	it('is the mock only when BILLING_MOCK_ENABLED is exactly "1" and the secret is set', () => {
		expect(activeProvider(undefined)).toBeNull();
		expect(activeProvider({ MOCK_PAYMENT_WEBHOOK_SECRET: SECRET })).toBeNull();
		expect(
			activeProvider({ BILLING_MOCK_ENABLED: 'true', MOCK_PAYMENT_WEBHOOK_SECRET: SECRET })
		).toBeNull();
		expect(activeProvider({ BILLING_MOCK_ENABLED: '1' })).toBeNull();
		expect(
			activeProvider({ BILLING_MOCK_ENABLED: '1', MOCK_PAYMENT_WEBHOOK_SECRET: 'short' })
		).toBeNull();
		const active = activeProvider({
			BILLING_MOCK_ENABLED: '1',
			MOCK_PAYMENT_WEBHOOK_SECRET: SECRET
		});
		expect(active?.provider.id).toBe('mock');
		expect(active?.testMode).toBe(true);
	});
});

describe('mock checkout', () => {
	it('is a same-origin test page with a fresh reference each time', async () => {
		const input = { userId: 'u', plan: 'pro' as const, amountMinor: 1, currency: 'IDR' };
		const a = await mockProvider.createCheckout(input);
		const b = await mockProvider.createCheckout(input);
		expect(a.checkoutUrl).toBe(`/pengaturan/paket/uji/${a.providerReference}`);
		expect(a.providerReference).toMatch(/^mock_[A-Za-z0-9_-]+$/);
		expect(a.providerReference).not.toBe(b.providerReference);
	});
});
