import { isActionFailure, isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { startCheckout } from '#lib/server/billing/checkout';
import { creditBalance, planOf, planStateOf } from '#lib/server/billing/gate';
import { listLedger } from '#lib/server/billing/ledger';
import {
	MOCK_SIGNATURE_HEADER,
	MOCK_SIGNATURE_TOLERANCE_MS,
	mockEventBody,
	mockProvider,
	signMockEvent
} from '#lib/server/billing/mock-provider';
import { pendingRefunds, refundsForUser } from '#lib/server/billing/refunds';
import { en } from '#lib/shared/i18n-en';
import { createVoucher, redeemVoucher, voucherAttemptLimited } from '#lib/server/billing/vouchers';
import { getDb, type Db } from '#lib/server/db';
import { DAY_MS, PLAN_CATALOGUE } from '#lib/shared/billing/plans';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const SECRET = 'f'.repeat(64);
const env: {
	DB?: D1Database;
	BILLING_MOCK_ENABLED?: string;
	MOCK_PAYMENT_WEBHOOK_SECRET?: string;
} = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => env }));

const webhook = await import('../../src/routes/api/v1/billing/webhook/+server');
const paket = await import('../../src/routes/(app)/pengaturan/paket/+page.server');
const uji = await import('../../src/routes/(app)/pengaturan/paket/uji/[ref]/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	env.DB = d1;
});
afterAll(() => dispose());
beforeEach(() => {
	env.BILLING_MOCK_ENABLED = '1';
	env.MOCK_PAYMENT_WEBHOOK_SECRET = SECRET;
});

let n = 0;
async function person() {
	const email = `bayar${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { id: r.userId, email, name: 'Uji', createdAt: 0 };
}
type Person = Awaited<ReturnType<typeof person>>;

const count = async (table: string, where = sql`1`) =>
	(await db.all<{ n: number }>(sql`select count(*) as n from ${sql.raw(table)} where ${where}`))[0]
		?.n ?? 0;

/** POSTs a raw body to the webhook route and answers its status (an HttpError's status included). */
async function postWebhook(body: string, headers: Record<string, string>) {
	const event = {
		request: new Request('http://localhost/api/v1/billing/webhook', {
			method: 'POST',
			headers,
			body
		}),
		locals: { db }
	} as unknown as Parameters<typeof webhook.POST>[0];
	try {
		const res = await webhook.POST(event);
		return { status: res.status, json: (await res.json()) as { status: string } };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body };
		throw e;
	}
}

async function signed(body: string, at = Date.now(), secret = SECRET) {
	return postWebhook(body, {
		'content-type': 'application/json',
		[MOCK_SIGNATURE_HEADER]: await signMockEvent(body, secret, at)
	});
}

/** A checkout for `who` and the body of a payment event for it. */
async function checkoutFor(who: Person, plan: 'pro' | 'agen' = 'pro') {
	const started = await startCheckout(db, mockProvider, who.id, plan, Date.now());
	if (!started.ok) throw new Error('checkout refused');
	const reference = started.checkoutUrl.split('/').pop() as string;
	const c = { reference, amountMinor: PLAN_CATALOGUE[plan].priceMinor, currency: 'IDR' };
	return {
		reference,
		body: (id: string, outcome: 'succeeded' | 'failed' = 'succeeded') =>
			mockEventBody(id, outcome, c)
	};
}

const ledgerOf = (userId: string) =>
	db.all<{ delta: number; reason: string }>(
		sql`select delta, reason from credit_ledger where user_id = ${userId} order by created_at, id`
	);

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail' as const,
				status: value.status,
				data: value.data as unknown as Record<string, unknown>
			};
		return { kind: 'ok' as const, value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

describe('sign-up starter state (AC1)', () => {
	it('starts every account on Gratis with exactly one 300-credit starter grant', async () => {
		const a = await person();
		const state = await planStateOf(db, a.id, Date.now());
		expect(state).toEqual({ plan: 'gratis', storedPlan: 'gratis', currentPeriodEnd: null });
		expect(await ledgerOf(a.id)).toEqual([{ delta: 300, reason: 'starter_grant' }]);
		expect(await creditBalance(db, a.id)).toBe(300);
	});

	it('writes them in the sign-up batch: a refused sign-up leaves no billing rows', async () => {
		const a = await person();
		const before = await count('credit_ledger');
		const again = await signUp(
			db,
			{
				name: 'Dua',
				email: a.email,
				password: PASSWORD,
				adultConfirmed: true,
				consentAccepted: true
			},
			Date.now()
		);
		expect(again.ok).toBe(false);
		expect(await count('credit_ledger')).toBe(before);
	});
});

describe('credit ledger (AC2)', () => {
	it('balance is SUM(delta) over any sequence of rows', async () => {
		const a = await person();
		const deltas = [1000, -250, 7, -1, 999_999_999, -999_999_999];
		let i = 0;
		for (const d of deltas)
			await d1
				.prepare(
					`insert into credit_ledger (id, user_id, delta, reason, reference_id, created_at)
					values (?, ?, ?, 'admin_adjustment', null, ?)`
				)
				.bind(`adj-${a.id}-${i}`, a.id, d, 10 + i++)
				.run();
		expect(await creditBalance(db, a.id)).toBe(300 + deltas.reduce((s, d) => s + d, 0));
	});

	it('refuses a zero, fractional, text or oversized delta (CHECK)', async () => {
		const a = await person();
		for (const delta of [0, 1.5, 'abc', 1_000_000_001, -1_000_000_001])
			await expect(
				d1
					.prepare(
						`insert into credit_ledger (id, user_id, delta, reason, created_at)
						values (?, ?, ?, 'admin_adjustment', 1)`
					)
					.bind(crypto.randomUUID(), a.id, delta)
					.run()
			).rejects.toThrow();
		expect(await creditBalance(db, a.id)).toBe(300);
	});

	it('L3: a live account’s history rows cannot have user_id nulled (only account deletion may)', async () => {
		const a = await person();
		await createVoucher(
			db,
			{ code: 'L3-LIVE-KODE-2026', kind: 'credits', creditsAmount: 5, maxRedemptions: 5 },
			1
		);
		await redeemVoucher(db, a.id, 'L3-LIVE-KODE-2026', Date.now());
		const c = await checkoutFor(a);
		await signed(c.body('evt_l3_1'));
		for (const table of ['credit_ledger', 'billing_events', 'voucher_redemptions', 'plan_changes'])
			await expect(
				d1.prepare(`update ${table} set user_id = null where user_id = ?`).bind(a.id).run(),
				table
			).rejects.toThrow(/append-only/);
		expect(await creditBalance(db, a.id)).toBe(1305);
		// replay_count may only grow by one at a time, nothing else with it.
		await expect(
			d1
				.prepare('update billing_events set replay_count = replay_count + 5 where user_id = ?')
				.bind(a.id)
				.run()
		).rejects.toThrow(/append-only/);
	});

	it('is append-only: rows cannot be updated or deleted (triggers)', async () => {
		const a = await person();
		await expect(
			d1.prepare('update credit_ledger set delta = 5000 where user_id = ?').bind(a.id).run()
		).rejects.toThrow(/append-only/);
		await expect(
			d1.prepare('delete from credit_ledger where user_id = ?').bind(a.id).run()
		).rejects.toThrow(/append-only/);
		await checkoutFor(a);
		await expect(
			d1.prepare('delete from billing_events where user_id = ?').bind(a.id).run()
		).rejects.toThrow(/append-only/);
		await expect(
			d1.prepare('update billing_events set amount_minor = 1 where user_id = ?').bind(a.id).run()
		).rejects.toThrow(/append-only/);
		expect(await creditBalance(db, a.id)).toBe(300);
	});

	it('pages newest first with the running balance after each row', async () => {
		const a = await person();
		for (let i = 0; i < 25; i++)
			await d1
				.prepare(
					`insert into credit_ledger (id, user_id, delta, reason, created_at)
					values (?, ?, 1, 'admin_adjustment', ?)`
				)
				.bind(`p-${a.id}-${String(i).padStart(2, '0')}`, a.id, Date.now() + 1000 + i)
				.run();
		const first = await listLedger(db, a.id, null);
		expect(first.rows).toHaveLength(20);
		expect(first.more).toBe(true);
		expect(first.rows[0]?.balanceAfter).toBe(325);
		const last = first.rows.at(-1)!;
		const second = await listLedger(db, a.id, { createdAt: last.createdAt, id: last.id });
		expect(second.rows).toHaveLength(6);
		expect(second.more).toBe(false);
		expect(second.rows.at(-1)).toMatchObject({ reason: 'starter_grant', balanceAfter: 300 });
	});
});

describe('vouchers (AC3, AC4, §9)', () => {
	it('20 concurrent redemptions of a 1-use voucher: exactly one succeeds', async () => {
		const people = await Promise.all(Array.from({ length: 20 }, () => person()));
		await createVoucher(
			db,
			{ code: 'RACE-ONE-KODE-2026', kind: 'credits', creditsAmount: 50, maxRedemptions: 1 },
			1
		);
		const results = await Promise.all(
			people.map((p) => redeemVoucher(db, p.id, 'RACE-ONE-KODE-2026', Date.now()))
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok && r.reason === 'used_up')).toHaveLength(19);
		expect(
			await count('vouchers', sql`redemption_count = 1 and max_redemptions = 1`)
		).toBeGreaterThanOrEqual(1);
		const balances = await Promise.all(people.map((p) => creditBalance(db, p.id)));
		expect(balances.filter((b) => b === 350)).toHaveLength(1);
		expect(balances.filter((b) => b === 300)).toHaveLength(19);
	});

	it('20 concurrent redemptions by one user of a multi-use voucher: exactly one (unique index)', async () => {
		const a = await person();
		await createVoucher(
			db,
			{ code: 'RACE-SELF-KODE-2026', kind: 'credits', creditsAmount: 10, maxRedemptions: 100 },
			1
		);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => redeemVoucher(db, a.id, 'race-self-kode-2026', Date.now()))
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok && r.reason === 'already_redeemed')).toHaveLength(19);
		expect(await creditBalance(db, a.id)).toBe(310);
	});

	it('a second sequential redemption is refused by the (voucher, user) unique index', async () => {
		const a = await person();
		const { id } = await createVoucher(
			db,
			{ code: 'TWICE-1-KODE-2026', kind: 'credits', creditsAmount: 5, maxRedemptions: 10 },
			1
		);
		expect((await redeemVoucher(db, a.id, 'TWICE-1-KODE-2026', Date.now())).ok).toBe(true);
		expect(await redeemVoucher(db, a.id, 'TWICE-1-KODE-2026', Date.now())).toEqual({
			ok: false,
			reason: 'already_redeemed'
		});
		// The index itself refuses a direct second row, whatever the application does.
		await expect(
			d1
				.prepare(
					'insert into voucher_redemptions (id, voucher_id, user_id, redeemed_at) values (?, ?, ?, 1)'
				)
				.bind(crypto.randomUUID(), id, a.id)
				.run()
		).rejects.toThrow(/UNIQUE/);
		expect(await creditBalance(db, a.id)).toBe(305);
		expect(await count('vouchers', sql`id = ${id} and redemption_count = 1`)).toBe(1);
	});

	it('names unknown, revoked, expired and used-up codes distinctly; stores only the hash', async () => {
		const a = await person();
		const b = await person();
		const now = Date.now();
		await createVoucher(
			db,
			{
				code: 'OLD-CODE-KODE-2026',
				kind: 'credits',
				creditsAmount: 5,
				maxRedemptions: 5,
				expiresAt: now - 1
			},
			1
		);
		const { id: revoked } = await createVoucher(
			db,
			{ code: 'GONE-CODE-KODE-2026', kind: 'credits', creditsAmount: 5, maxRedemptions: 5 },
			1
		);
		await d1.prepare('update vouchers set deleted_at = 1 where id = ?').bind(revoked).run();
		await createVoucher(
			db,
			{ code: 'ONE-SHOT-KODE-2026', kind: 'credits', creditsAmount: 5, maxRedemptions: 1 },
			1
		);
		expect(await redeemVoucher(db, a.id, 'NOPE-NOPE-KODE-2026', now)).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await redeemVoucher(db, a.id, 'GONE-CODE-KODE-2026', now)).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await redeemVoucher(db, a.id, 'OLD-CODE-KODE-2026', now)).toEqual({
			ok: false,
			reason: 'expired'
		});
		expect((await redeemVoucher(db, a.id, 'ONE-SHOT-KODE-2026', now)).ok).toBe(true);
		expect(await redeemVoucher(db, b.id, 'ONE-SHOT-KODE-2026', now)).toEqual({
			ok: false,
			reason: 'used_up'
		});
		expect(
			await count('vouchers', sql`code_hash like '%SHOT%' or code_hash = 'ONE-SHOT-KODE-2026'`)
		).toBe(0);
		expect(await creditBalance(db, b.id)).toBe(300);
	});

	it('a plan_days voucher grants a time-boxed plan (audited) and never downgrades', async () => {
		const a = await person();
		const now = Date.now();
		await createVoucher(
			db,
			{ code: 'PRO-7-KODE-2026', kind: 'plan_days', plan: 'pro', planDays: 7, maxRedemptions: 10 },
			1
		);
		await createVoucher(
			db,
			{
				code: 'AGEN-3-KODE-2026',
				kind: 'plan_days',
				plan: 'agen',
				planDays: 3,
				maxRedemptions: 10
			},
			1
		);
		await createVoucher(
			db,
			{
				code: 'PRO-30-KODE-2026',
				kind: 'plan_days',
				plan: 'pro',
				planDays: 30,
				maxRedemptions: 10
			},
			1
		);
		expect(await redeemVoucher(db, a.id, 'PRO-7-KODE-2026', now)).toMatchObject({
			ok: true,
			plan: 'pro',
			days: 7
		});
		const s1 = await planStateOf(db, a.id, now);
		expect(s1.plan).toBe('pro');
		expect(s1.currentPeriodEnd).toBe(now + 7 * DAY_MS);
		expect((await redeemVoucher(db, a.id, 'AGEN-3-KODE-2026', now + 1)).ok).toBe(true);
		expect(await planOf(db, a.id, now + 2)).toBe('agen');
		// Pro while Agen runs: refused, nothing written (not even the redemption).
		expect(await redeemVoucher(db, a.id, 'PRO-30-KODE-2026', now + 3)).toEqual({
			ok: false,
			reason: 'plan_higher'
		});
		expect(await count('voucher_redemptions', sql`user_id = ${a.id}`)).toBe(2);
		const audit = await db.all<{ from_plan: string; to_plan: string; source: string }>(
			sql`select from_plan, to_plan, source from plan_changes where user_id = ${a.id} order by created_at`
		);
		expect(audit).toEqual([
			{ from_plan: 'gratis', to_plan: 'pro', source: 'voucher' },
			{ from_plan: 'pro', to_plan: 'agen', source: 'voucher' }
		]);
		// Once Agen has lapsed, the Pro voucher works again.
		expect((await redeemVoucher(db, a.id, 'PRO-30-KODE-2026', now + 4 * DAY_MS)).ok).toBe(true);
	});
});

describe('webhook (AC5, AC6) and probes', () => {
	it('applies a signed payment once; a replay bumps replay_count on the same row, answers 200 and grants nothing', async () => {
		const a = await person();
		const c = await checkoutFor(a);
		const body = c.body('evt_once_1');
		const first = await signed(body);
		expect(first).toEqual({ status: 200, json: { status: 'applied' } });
		expect(await planOf(db, a.id, Date.now())).toBe('pro');
		expect(await creditBalance(db, a.id)).toBe(1300);
		const replay = await signed(body);
		expect(replay).toEqual({ status: 200, json: { status: 'replay' } });
		expect(await creditBalance(db, a.id)).toBe(1300);
		expect(
			await count('billing_events', sql`user_id = ${a.id} and kind = 'payment_succeeded'`)
		).toBe(1);
		// L5: no new row per replay; the original row counts it.
		const before = await count('billing_events');
		expect((await signed(body)).json?.status).toBe('replay');
		expect(await count('billing_events')).toBe(before);
		const [row] = await db.all<{ replay_count: number; last_seen_at: number | null }>(
			sql`select replay_count, last_seen_at from billing_events where provider_event_id = 'evt_once_1'`
		);
		expect(row?.replay_count).toBe(2);
		expect(row?.last_seen_at).toBeGreaterThan(0);
		expect(await count('plan_changes', sql`user_id = ${a.id}`)).toBe(1);
	});

	it('L1: a paid event that grants nothing is stored as paid_not_applied, answers ignored_paid, counts for refund', async () => {
		const a = await person();
		const pro = await checkoutFor(a, 'pro');
		const agen = await checkoutFor(a, 'agen');
		const refundsBefore = await pendingRefunds(db);
		expect((await signed(agen.body('evt_l1_agen'))).json?.status).toBe('applied');
		expect(await signed(pro.body('evt_l1_pro'))).toEqual({
			status: 200,
			json: { status: 'ignored_paid' }
		});
		expect(await planOf(db, a.id, Date.now())).toBe('agen');
		expect(await creditBalance(db, a.id)).toBe(1300);
		expect(
			await count('billing_events', sql`user_id = ${a.id} and kind = 'paid_not_applied'`)
		).toBe(1);
		const refunds = await pendingRefunds(db);
		expect(refunds.count).toBe(refundsBefore.count + 1);
		expect(refunds.rows[0]).toMatchObject({
			provider: 'mock',
			reference: pro.reference,
			amountMinor: 4_900_000,
			currency: 'IDR',
			reason: 'plan_higher'
		});
		expect(Object.keys(refunds.rows[0] ?? {}).sort()).toEqual(
			['amountMinor', 'createdAt', 'currency', 'id', 'provider', 'reason', 'reference'].sort()
		);
		// A second delivery of that payment is a replay, not a second refund.
		expect((await signed(pro.body('evt_l1_pro_again'))).json?.status).toBe('replay');
		expect((await pendingRefunds(db)).count).toBe(refunds.count);
	});

	it('L5: a payment for a checkout past its 1-hour expiry is paid_not_applied, never applied', async () => {
		const a = await person();
		const started = await startCheckout(db, mockProvider, a.id, 'pro', Date.now() - 61 * 60 * 1000);
		if (!started.ok) throw new Error('checkout refused');
		const reference = started.checkoutUrl.split('/').pop() as string;
		const body = mockEventBody('evt_l5_late', 'succeeded', {
			reference,
			amountMinor: 4_900_000,
			currency: 'IDR'
		});
		expect((await signed(body)).json?.status).toBe('ignored_paid');
		expect(await planOf(db, a.id, Date.now())).toBe('gratis');
		expect(await creditBalance(db, a.id)).toBe(300);
	});

	it('the same payment under a new event id is still one grant (unique reference)', async () => {
		const a = await person();
		const c = await checkoutFor(a);
		expect((await signed(c.body('evt_ref_1'))).json?.status).toBe('applied');
		expect((await signed(c.body('evt_ref_2'))).json?.status).toBe('replay');
		expect(await creditBalance(db, a.id)).toBe(1300);
	});

	it('20 concurrent deliveries of one event grant exactly once', async () => {
		const a = await person();
		const c = await checkoutFor(a);
		const body = c.body('evt_conc_1');
		const results = await Promise.all(Array.from({ length: 20 }, () => signed(body)));
		expect(results.every((r) => r.status === 200)).toBe(true);
		expect(results.filter((r) => r.json?.status === 'applied')).toHaveLength(1);
		expect(await creditBalance(db, a.id)).toBe(1300);
		const s = await planStateOf(db, a.id, Date.now());
		expect(s.currentPeriodEnd! - Date.now()).toBeLessThanOrEqual(30 * DAY_MS);
	});

	it('reordered events never downgrade: a failure after success, or a Pro payment after Agen', async () => {
		const a = await person();
		const pro = await checkoutFor(a, 'pro');
		const agen = await checkoutFor(a, 'agen');
		expect((await signed(agen.body('evt_ord_agen'))).json?.status).toBe('applied');
		// The older Pro checkout's success arrives late: recorded, but the plan stays Agen.
		expect((await signed(pro.body('evt_ord_pro'))).json?.status).toBe('ignored_paid');
		expect(await planOf(db, a.id, Date.now())).toBe('agen');
		expect((await signed(agen.body('evt_ord_fail', 'failed'))).json?.status).toBe('recorded');
		expect(await planOf(db, a.id, Date.now())).toBe('agen');
		expect(await creditBalance(db, a.id)).toBe(1300);
		expect(await count('plan_changes', sql`user_id = ${a.id}`)).toBe(1);
		// A failure before a success does not block it.
		const b = await person();
		const cb = await checkoutFor(b);
		expect((await signed(cb.body('evt_b_fail', 'failed'))).json?.status).toBe('recorded');
		expect(await planOf(db, b.id, Date.now())).toBe('gratis');
		expect((await signed(cb.body('evt_b_ok'))).json?.status).toBe('applied');
		expect(await planOf(db, b.id, Date.now())).toBe('pro');
	});

	it('refuses bad signatures with one fixed 401 and writes nothing', async () => {
		const a = await person();
		const c = await checkoutFor(a);
		const body = c.body('evt_bad_1');
		const before = await count('billing_events');
		const answers = [
			await postWebhook(body, { 'content-type': 'application/json' }),
			await postWebhook(body, { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: 'x' }),
			await signed(body, Date.now(), 'e'.repeat(64)),
			await signed(body, Date.now() - MOCK_SIGNATURE_TOLERANCE_MS - 1000),
			await signed(body, Date.now() + MOCK_SIGNATURE_TOLERANCE_MS + 1000)
		];
		for (const r of answers)
			expect(r).toMatchObject({ status: 401, body: { message: 'Invalid signature' } });
		expect(await count('billing_events')).toBe(before);
		expect(await creditBalance(db, a.id)).toBe(300);
	});

	it('refuses signed but unacceptable events with 400 and writes nothing', async () => {
		const a = await person();
		const c = await checkoutFor(a);
		const before = await count('billing_events');
		const unknownType = c.body('evt_type_1').replace('payment.succeeded', 'payment.refunded');
		const wrongAmount = mockEventBody('evt_amt_1', 'succeeded', {
			reference: c.reference,
			amountMinor: 1,
			currency: 'IDR'
		});
		const unknownRef = mockEventBody('evt_ref_x', 'succeeded', {
			reference: 'mock_nope',
			amountMinor: 4_900_000,
			currency: 'IDR'
		});
		for (const body of [unknownType, wrongAmount, unknownRef])
			expect(await signed(body)).toMatchObject({ status: 400, body: { message: 'Invalid event' } });
		expect(await count('billing_events')).toBe(before);
	});

	it('bounds the body (413), wants JSON (415), and refuses everything with the mock off (401)', async () => {
		const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
		expect((await signed(big)).status).toBe(413);
		expect((await postWebhook('{}', { 'content-type': 'text/plain' })).status).toBe(415);
		const a = await person();
		const c = await checkoutFor(a);
		env.BILLING_MOCK_ENABLED = undefined;
		expect((await signed(c.body('evt_off_1'))).status).toBe(401);
		expect(await planOf(db, a.id, Date.now())).toBe('gratis');
	});
});

describe('/pengaturan/paket and the mock checkout routes', () => {
	const ev = (
		who: Person | null,
		url: string,
		routeId: string,
		form?: Record<string, string>,
		params?: Record<string, string>,
		ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
	) => {
		const { event } = fakeEvent({
			url,
			routeId,
			db,
			user: who,
			form,
			params,
			headers: { 'cf-connecting-ip': ip }
		});
		// event.fetch: the mock delivers to the app's own webhook, answered in process like SvelteKit does.
		(event as { fetch: typeof fetch }).fetch = async (path, init) => {
			const req = new Request(new URL(String(path), 'http://localhost'), init);
			try {
				return await webhook.POST({ request: req, locals: { db } } as unknown as Parameters<
					typeof webhook.POST
				>[0]);
			} catch (e) {
				if (isHttpError(e)) return Response.json(e.body, { status: e.status });
				throw e;
			}
		};
		return event as RequestEvent;
	};
	const PAKET = '/(app)/pengaturan/paket';
	const UJI = '/(app)/pengaturan/paket/uji/[ref]';

	it('loads only the signed-in user’s own plan, balance and ledger', async () => {
		const a = await person();
		const b = await person();
		await createVoucher(
			db,
			{ code: 'ONLY-B-KODE-2026', kind: 'credits', creditsAmount: 40, maxRedemptions: 5 },
			1
		);
		await redeemVoucher(db, b.id, 'ONLY-B-KODE-2026', Date.now());
		const r = await run(() =>
			paket.load(ev(a, 'http://localhost/pengaturan/paket', PAKET) as never)
		);
		expect(r.kind).toBe('ok');
		const data = (r as { value: Record<string, unknown> }).value;
		expect(data.balance).toBe(300);
		expect((data.ledger as unknown[]).length).toBe(1);
		expect(data.mockCheckout).toBe(true);
	});

	it('flag off: no upgrade in the data, checkout POST and the test page are 404 (gating bypass probe)', async () => {
		const a = await person();
		env.BILLING_MOCK_ENABLED = '0';
		const r = await run(() =>
			paket.load(ev(a, 'http://localhost/pengaturan/paket', PAKET) as never)
		);
		expect((r as { value: Record<string, unknown> }).value.mockCheckout).toBe(false);
		const post = await run(() =>
			paket.actions.checkout!(
				ev(a, 'http://localhost/pengaturan/paket?/checkout', PAKET, { plan: 'pro' }) as never
			)
		);
		expect(post).toMatchObject({ kind: 'error', status: 404, body: { message: 'Not found' } });
		env.BILLING_MOCK_ENABLED = '1';
		const c = await checkoutFor(a);
		env.BILLING_MOCK_ENABLED = undefined;
		const page = await run(() =>
			uji.load(
				ev(a, `http://localhost/pengaturan/paket/uji/${c.reference}`, UJI, undefined, {
					ref: c.reference
				}) as never
			)
		);
		expect(page).toMatchObject({ kind: 'error', status: 404 });
		const pay = await run(() =>
			uji.actions.pay!(
				ev(
					a,
					`http://localhost/pengaturan/paket/uji/${c.reference}?/pay`,
					UJI,
					{},
					{ ref: c.reference }
				) as never
			)
		);
		expect(pay).toMatchObject({ kind: 'error', status: 404 });
		expect(await planOf(db, a.id, Date.now())).toBe('gratis');
	});

	it('checkout → pay: the plan changes only through the signed webhook, then reads back', async () => {
		const a = await person();
		const start = await run(() =>
			paket.actions.checkout!(
				ev(a, 'http://localhost/pengaturan/paket?/checkout', PAKET, { plan: 'agen' }) as never
			)
		);
		expect(start.kind).toBe('redirect');
		const ref = (start as { location: string }).location.split('/').pop() as string;
		const failRun = await run(() =>
			uji.actions.fail!(
				ev(a, `http://localhost/pengaturan/paket/uji/${ref}?/fail`, UJI, {}, { ref }) as never
			)
		);
		expect(failRun).toEqual({ kind: 'ok', value: { result: 'failed' } });
		expect(await planOf(db, a.id, Date.now())).toBe('gratis');
		const payRun = await run(() =>
			uji.actions.pay!(
				ev(a, `http://localhost/pengaturan/paket/uji/${ref}?/pay`, UJI, {}, { ref }) as never
			)
		);
		expect(payRun).toMatchObject({ kind: 'ok', value: { result: 'paid', plan: 'agen' } });
		expect(await creditBalance(db, a.id)).toBe(1300);
		const again = await run(() =>
			uji.actions.pay!(
				ev(a, `http://localhost/pengaturan/paket/uji/${ref}?/pay`, UJI, {}, { ref }) as never
			)
		);
		expect(again).toMatchObject({ kind: 'fail', status: 409 });
		expect(await creditBalance(db, a.id)).toBe(1300);
		// A plan below the one in force cannot be bought.
		const lower = await run(() =>
			paket.actions.checkout!(
				ev(a, 'http://localhost/pengaturan/paket?/checkout', PAKET, { plan: 'pro' }) as never
			)
		);
		expect(lower).toMatchObject({ kind: 'fail', status: 409 });
		const bogus = await run(() =>
			paket.actions.checkout!(
				ev(a, 'http://localhost/pengaturan/paket?/checkout', PAKET, { plan: 'gratis' }) as never
			)
		);
		expect(bogus).toMatchObject({ kind: 'fail', status: 400 });
	});

	it('cross-account: another user’s checkout is the same 404 as an unknown one', async () => {
		const a = await person();
		const b = await person();
		const c = await checkoutFor(a);
		for (const ref of [c.reference, 'mock_unknown'])
			expect(
				await run(() =>
					uji.load(
						ev(b, `http://localhost/pengaturan/paket/uji/${ref}`, UJI, undefined, { ref }) as never
					)
				)
			).toMatchObject({ kind: 'error', status: 404, body: { message: 'Not found' } });
		const pay = await run(() =>
			uji.actions.pay!(
				ev(
					b,
					`http://localhost/pengaturan/paket/uji/${c.reference}?/pay`,
					UJI,
					{},
					{ ref: c.reference }
				) as never
			)
		);
		expect(pay).toMatchObject({ kind: 'fail', status: 404 });
		expect(await planOf(db, a.id, Date.now())).toBe('gratis');
		expect(await planOf(db, b.id, Date.now())).toBe('gratis');
	});

	it('redeem action: specific refusals, success and throttling', async () => {
		const a = await person();
		await createVoucher(
			db,
			{ code: 'FORM-10-KODE-2026', kind: 'credits', creditsAmount: 10, maxRedemptions: 5 },
			1
		);
		const redeem = (code: string) =>
			run(() =>
				paket.actions.redeem!(
					ev(a, 'http://localhost/pengaturan/paket?/redeem', PAKET, { code }) as never
				)
			);
		expect(await redeem('x')).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { error: 'Kode tidak valid atau sudah tidak berlaku.' }
		});
		expect(await redeem('form-10-kode-2026')).toMatchObject({
			kind: 'ok',
			value: { redeemed: { credits: 10 } }
		});
		expect(await redeem('FORM-10-KODE-2026')).toMatchObject({
			kind: 'fail',
			status: 409,
			data: { error: 'Kamu sudah pernah menukar voucher ini.' }
		});
		expect(await redeem('NOT-THERE-KODE-2026')).toMatchObject({
			kind: 'fail',
			status: 404,
			data: { error: 'Kode tidak valid atau sudah tidak berlaku.' }
		});
		let last;
		for (let i = 0; i < 20; i++) last = await redeem('NOT-THERE-KODE-2026');
		expect(last).toMatchObject({ kind: 'fail', status: 429 });
		expect(await creditBalance(db, a.id)).toBe(310);
	});
});

describe('cycle 2 (red team L1, L2)', () => {
	const PAKET = '/(app)/pengaturan/paket';
	const UJI = '/(app)/pengaturan/paket/uji/[ref]';
	const evAt = (
		who: Person,
		url: string,
		routeId: string,
		ip: string,
		form?: Record<string, string>,
		params?: Record<string, string>
	) => {
		const { event } = fakeEvent({
			url,
			routeId,
			db,
			user: who,
			form,
			params,
			headers: { 'cf-connecting-ip': ip }
		});
		(event as { fetch: typeof fetch }).fetch = async (path, init) => {
			const req = new Request(new URL(String(path), 'http://localhost'), init);
			try {
				return await webhook.POST({ request: req, locals: { db } } as unknown as Parameters<
					typeof webhook.POST
				>[0]);
			} catch (e) {
				if (isHttpError(e)) return Response.json(e.body, { status: e.status });
				throw e;
			}
		};
		return event as RequestEvent;
	};
	const UNIFORM = 'Kode tidak valid atau sudah tidak berlaku.';

	it('L2: not found, expired and used up get one uniform answer', async () => {
		const a = await person();
		const b = await person();
		await createVoucher(
			db,
			{
				code: 'EXPIRED-KODE-2026',
				kind: 'credits',
				creditsAmount: 5,
				maxRedemptions: 5,
				expiresAt: 1
			},
			1
		);
		await createVoucher(
			db,
			{ code: 'SINGLE-KODE-2026', kind: 'credits', creditsAmount: 5, maxRedemptions: 1 },
			1
		);
		await redeemVoucher(db, b.id, 'SINGLE-KODE-2026', Date.now());
		const answers = [];
		for (const code of ['MISSING-KODE-2026', 'EXPIRED-KODE-2026', 'SINGLE-KODE-2026'])
			answers.push(
				await run(() =>
					paket.actions.redeem!(
						evAt(a, 'http://localhost/pengaturan/paket?/redeem', PAKET, '198.18.200.1', {
							code
						}) as never
					)
				)
			);
		for (const r of answers)
			expect(r).toEqual({
				kind: 'fail',
				status: 404,
				data: { action: 'redeem', code: expect.any(String), error: UNIFORM }
			});
	});

	it('L2: a per-client budget across accounts, alongside the per-user one', async () => {
		const ip = '198.19.250.250';
		const people = await Promise.all(Array.from({ length: 4 }, () => person()));
		const results = [];
		for (let i = 0; i < 24; i++) {
			const who = people[i % 4]!;
			results.push(
				await run(() =>
					paket.actions.redeem!(
						evAt(who, 'http://localhost/pengaturan/paket?/redeem', PAKET, ip, {
							code: `GAMES-${i}-KODE-AB`
						}) as never
					)
				)
			);
		}
		// Each account made only 6 attempts (under its own 20), yet the client's 20 are spent.
		expect(results.slice(0, 20).every((r) => r.kind === 'fail' && r.status === 404)).toBe(true);
		expect(results.slice(20).every((r) => r.kind === 'fail' && r.status === 429)).toBe(true);
	});

	it('L2: the voucher throttle fails closed when D1 errors', async () => {
		const broken = new Proxy(
			{},
			{
				get: () => () => {
					throw new Error('D1_ERROR');
				}
			}
		) as unknown as Db;
		const request = new Request('http://localhost/', {
			headers: { 'cf-connecting-ip': '198.18.1.1' }
		});
		expect(await voucherAttemptLimited(broken, request, 'u', Date.now())).toBe(true);
	});

	it('L2: createVoucher refuses a code shorter than 10 symbols', async () => {
		await expect(
			createVoucher(
				db,
				{ code: 'PENDEK-1', kind: 'credits', creditsAmount: 1, maxRedemptions: 1 },
				1
			)
		).rejects.toThrow();
		const generated = await createVoucher(
			db,
			{ kind: 'credits', creditsAmount: 1, maxRedemptions: 1 },
			1
		);
		expect(generated.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
	});

	it('L1: the mock pay action reports a payment that was not applied (needs refund), not success', async () => {
		const a = await person();
		const pro = await checkoutFor(a, 'pro');
		await createVoucher(
			db,
			{
				code: 'AGEN-NOW-KODE-2026',
				kind: 'plan_days',
				plan: 'agen',
				planDays: 5,
				maxRedemptions: 5
			},
			1
		);
		expect((await redeemVoucher(db, a.id, 'AGEN-NOW-KODE-2026', Date.now())).ok).toBe(true);
		const r = await run(() =>
			uji.actions.pay!(
				evAt(
					a,
					`http://localhost/pengaturan/paket/uji/${pro.reference}?/pay`,
					UJI,
					'198.18.3.3',
					{},
					{ ref: pro.reference }
				) as never
			)
		);
		expect(r).toMatchObject({
			kind: 'fail',
			status: 409,
			data: {
				error:
					'Pembayaran uji tercatat tetapi tidak diterapkan ke paketmu. Pengembalian dana dicatat dan bisa kamu lihat di Paket & kredit.'
			}
		});
		expect(en[(r as unknown as { data: { error: string } }).data.error]).toBe(
			'The test payment was recorded but not applied to your plan. A refund has been recorded; you can see it in Plan & credits.'
		);
		expect(await planOf(db, a.id, Date.now())).toBe('agen');
		// FN-30 hardening criterion 9: the obligation it names exists, pending, for this account.
		expect(await refundsForUser(db, a.id)).toMatchObject([
			{ status: 'pending', amountMinor: 4_900_000, currency: 'IDR', plan: 'pro', provider: 'mock' }
		]);
	});
});

describe('account deletion (AC12)', () => {
	it('removes the plan state and keeps the append-only history without the account', async () => {
		const a = await person();
		const b = await person();
		await createVoucher(
			db,
			{ code: 'KEEP-SPENT-KODE-2026', kind: 'credits', creditsAmount: 5, maxRedemptions: 1 },
			1
		);
		await redeemVoucher(db, a.id, 'KEEP-SPENT-KODE-2026', Date.now());
		const c = await checkoutFor(a);
		await signed(c.body('evt_del_1'));
		const proof = await signInWithPassword(db, a.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, a.id, proof.hash)).toBe(true);
		expect(await count('user_plan_state', sql`user_id = ${a.id}`)).toBe(0);
		for (const t of ['credit_ledger', 'billing_events', 'voucher_redemptions', 'plan_changes'])
			expect(await count(t, sql`user_id = ${a.id}`)).toBe(0);
		expect(
			await count('credit_ledger', sql`user_id is null and reason = 'voucher_redeemed'`)
		).toBeGreaterThanOrEqual(1);
		expect(
			await count('billing_events', sql`user_id is null and kind = 'payment_succeeded'`)
		).toBeGreaterThanOrEqual(1);
		// The code stays used: another account cannot take its one redemption.
		expect(await redeemVoucher(db, b.id, 'KEEP-SPENT-KODE-2026', Date.now())).toEqual({
			ok: false,
			reason: 'used_up'
		});
		expect(await creditBalance(db, b.id)).toBe(300);
	});
});
