import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { startCheckout } from '#lib/server/billing/checkout';
import { creditBalance, planOf, planStateOf } from '#lib/server/billing/gate';
import {
	MOCK_SIGNATURE_HEADER,
	mockEventBody,
	mockProvider,
	signMockEvent
} from '#lib/server/billing/mock-provider';
import { processWebhook } from '#lib/server/billing/webhook';
import { getDb, type Db } from '#lib/server/db';
import { DAY_MS, PLAN_CATALOGUE } from '#lib/shared/billing/plans';
import { openLocalD1 } from '../helpers/d1';

/**
 * QA (fn-30-billing): the PRD's plan period is 30 days for a monthly plan (Pro/Agen). This proves the end-to-end
 * webhook -> plan grant -> expiry boundary using controlled `now` values, not wall-clock sleeps, so the exact
 * 30-day edge (`currentPeriodEnd > now` in `effectivePlan`) is exercised precisely.
 */
describe('plan expiry at the 30-day boundary (controlled time)', () => {
	let d1: D1Database;
	let db: Db;
	let dispose: () => Promise<void>;
	const SECRET = 'f'.repeat(64);
	const active = { provider: mockProvider, secret: SECRET, testMode: true };

	beforeAll(async () => {
		({ db: d1, dispose } = await openLocalD1());
		db = getDb(d1);
	});
	afterAll(() => dispose());

	it('a Pro payment grants exactly 30 days; still Pro one ms before the boundary, Gratis at and after it; credits are not clawed back', async () => {
		const start = Date.UTC(2026, 0, 1, 12, 0, 0); // arbitrary fixed instant, not wall-clock
		const r = await signUp(
			db,
			{
				name: 'Uji Kedaluwarsa',
				email: 'kedaluwarsa@contoh.id',
				password: 'kopi-pagi-2026',
				adultConfirmed: true,
				consentAccepted: true
			},
			start
		);
		if (!r.ok) throw new Error('setup failed');
		const userId = r.userId;

		const started = await startCheckout(db, mockProvider, userId, 'pro', start);
		if (!started.ok) throw new Error('checkout refused');
		const reference = started.checkoutUrl.split('/').pop() as string;
		const entry = PLAN_CATALOGUE.pro;
		const body = mockEventBody('evt_expiry_1', 'succeeded', {
			reference,
			amountMinor: entry.priceMinor,
			currency: entry.currency
		});
		const sig = await signMockEvent(body, SECRET, start);
		const outcome = await processWebhook(
			db,
			active,
			{
				body: new TextEncoder().encode(body),
				headers: new Headers({ [MOCK_SIGNATURE_HEADER]: sig })
			},
			start
		);
		expect(outcome).toEqual({ status: 200, outcome: 'applied' });

		const state = await planStateOf(db, userId, start);
		expect(state.plan).toBe('pro');
		expect(state.currentPeriodEnd).toBe(start + 30 * DAY_MS);
		const boundary = start + 30 * DAY_MS;

		// One millisecond before the boundary: still Pro.
		expect(await planOf(db, userId, boundary - 1)).toBe('pro');
		// Exactly at the boundary and any time after: lapsed to Gratis (effectivePlan requires `currentPeriodEnd > now`).
		expect(await planOf(db, userId, boundary)).toBe('gratis');
		expect(await planOf(db, userId, boundary + DAY_MS)).toBe('gratis');

		// The stored plan still shows Pro (so the UI can say it ended), but credits granted while paying are kept.
		const lapsedState = await planStateOf(db, userId, boundary);
		expect(lapsedState.plan).toBe('gratis');
		expect(lapsedState.storedPlan).toBe('pro');
		expect(await creditBalance(db, userId)).toBe(300 + entry.monthlyCreditGrant);
	});
});
