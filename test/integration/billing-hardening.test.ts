import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { startCheckout } from '#lib/server/billing/checkout';
import {
	CLAIM_MARKER_RETENTION_MS,
	CLAIM_SWEEP_BATCH,
	sweepClaimMarkers
} from '#lib/server/billing/claim-sweep';
import { claimHashes } from '#lib/server/billing/claims';
import { creditBalance, planOf, planStateOf } from '#lib/server/billing/gate';
import { VOUCHER_ALREADY_REDEEMED } from '#lib/server/billing/messages';
import {
	MOCK_SIGNATURE_HEADER,
	mockEventBody,
	mockProvider,
	signMockEvent
} from '#lib/server/billing/mock-provider';
import {
	pendingRefunds,
	recordRefundOutcome,
	REFUND_LIST_LIMIT,
	refundsForUser
} from '#lib/server/billing/refunds';
import { createVoucher, redeemVoucher } from '#lib/server/billing/vouchers';
import { getDb, type Db } from '#lib/server/db';
import { base64urlEncode } from '#lib/shared/base64url';
import { DAY_MS, PLAN_CATALOGUE } from '#lib/shared/billing/plans';
import { formatMoney } from '#lib/shared/money-format';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// FN-30 hardening (docs/features/fn-30-pro-hardening/PRD.md) against a local D1: refund obligations for verified
// payments that granted nothing, re-claim markers at account deletion, and their checks at sign-up and voucher
// redemption. Sign-up, deletion and redemption go through their real routes, so the wiring of CLAIM_HASH_KEY is
// tested, not only the helpers. No provider is called: the mock webhook is signed and answered in process.

const SECRET = 'f'.repeat(64);
const K1 = base64urlEncode(new Uint8Array(32).fill(41));
const K2 = base64urlEncode(new Uint8Array(32).fill(42));
const env: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => env }));

const webhook = await import('../../src/routes/api/v1/billing/webhook/+server');
const paket = await import('../../src/routes/(app)/pengaturan/paket/+page.server');
const daftar = await import('../../src/routes/(auth)/daftar/+page.server');
const akun = await import('../../src/routes/(app)/pengaturan/akun/+page.server');

let d1: D1Database;
let db: Db;
let bindings: { DB: D1Database; FILES: R2Bucket };
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, env: bindings, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

function configure(o: { key?: string; previous?: string } = {}) {
	for (const k of Object.keys(env)) delete env[k];
	Object.assign(env, bindings, {
		JOBS_QUEUE: { send: async () => {}, sendBatch: async () => {} },
		BILLING_MOCK_ENABLED: '1',
		MOCK_PAYMENT_WEBHOOK_SECRET: SECRET,
		CLAIM_HASH_KEY: o.key,
		CLAIM_HASH_KEY_PREVIOUS: o.previous
	});
}
beforeEach(() => configure({ key: K1 }));

const count = async (table: string, where = sql`1`) =>
	(await db.all<{ n: number }>(sql`select count(*) as n from ${sql.raw(table)} where ${where}`))[0]
		?.n ?? 0;

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

let n = 0;
const ip = () => `198.19.${++n % 250}.${Math.floor(Math.random() * 250)}`;

/** Signs up through /daftar, as the browser does (the route computes the claim hashes). */
async function signUpVia(email: string) {
	const { event } = fakeEvent({
		url: 'http://localhost/daftar',
		routeId: '/(auth)/daftar',
		db,
		headers: { 'cf-connecting-ip': ip() },
		form: { name: 'Uji', email, password: PASSWORD, adult: 'on', consent: 'on' }
	});
	const r = await run(() => daftar.actions.default!(event as never));
	expect(r, email).toMatchObject({ kind: 'redirect', status: 303 });
	const row = await d1
		.prepare('select id from users where email = ?')
		.bind(email.trim().toLowerCase())
		.first<{ id: string }>();
	return { id: row!.id, email: email.trim().toLowerCase(), name: 'Uji', createdAt: 0 };
}
type Person = Awaited<ReturnType<typeof signUpVia>>;
let people = 0;
const person = () => signUpVia(`keras${++people}@contoh.id`);

/** Deletes through /pengaturan/akun with the right password (the route writes the markers). */
async function deleteVia(who: Person) {
	const { event } = fakeEvent({
		url: 'http://localhost/pengaturan/akun?/deleteAccount',
		routeId: '/(app)/pengaturan/akun',
		db,
		user: who,
		form: { password: PASSWORD, confirm: 'on' }
	});
	expect(await run(() => akun.actions.deleteAccount!(event as never))).toMatchObject({
		kind: 'redirect',
		location: '/akun-dihapus'
	});
}

/** Redeems through /pengaturan/paket (the route passes the claim hashes). */
const redeemVia = (who: Person, code: string) => {
	const { event } = fakeEvent({
		url: 'http://localhost/pengaturan/paket?/redeem',
		routeId: '/(app)/pengaturan/paket',
		db,
		user: who,
		headers: { 'cf-connecting-ip': ip() },
		form: { code }
	});
	return run(() => paket.actions.redeem!(event as never));
};

async function signed(body: string) {
	const event = {
		request: new Request('http://localhost/api/v1/billing/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				[MOCK_SIGNATURE_HEADER]: await signMockEvent(body, SECRET, Date.now())
			},
			body
		}),
		locals: { db }
	} as unknown as Parameters<typeof webhook.POST>[0];
	const res = await webhook.POST(event);
	return ((await res.json()) as { status: string }).status;
}

async function checkoutFor(who: Person, plan: 'pro' | 'agen' = 'pro', at = Date.now()) {
	const started = await startCheckout(db, mockProvider, who.id, plan, at);
	if (!started.ok) throw new Error('checkout refused');
	const reference = started.checkoutUrl.split('/').pop() as string;
	const c = { reference, amountMinor: PLAN_CATALOGUE[plan].priceMinor, currency: 'IDR' };
	return { reference, body: (id: string) => mockEventBody(id, 'succeeded', c) };
}

const refundRows = (where = sql`1`) =>
	db.all<Record<string, unknown>>(sql`select * from billing_refunds where ${where}`);

/** A user with Agen active and a Pro payment that then arrives: one refund obligation (criterion 1). */
async function notApplied(tag: string) {
	const a = await person();
	const pro = await checkoutFor(a, 'pro');
	const agen = await checkoutFor(a, 'agen');
	expect(await signed(agen.body(`evt_${tag}_agen`))).toBe('applied');
	expect(await signed(pro.body(`evt_${tag}_pro`))).toBe('ignored_paid');
	return { a, pro };
}

describe('refund obligations (criteria 1–4)', () => {
	it('a payment that grants nothing stores one paid_not_applied event and one pending plan_higher refund', async () => {
		const { a, pro } = await notApplied('c1');
		const [event] = await db.all<{ id: string; amount_minor: number; currency: string }>(
			sql`select id, amount_minor, currency from billing_events
				where reference = ${pro.reference} and kind = 'paid_not_applied'`
		);
		expect(event).toBeDefined();
		const refunds = await refundRows(sql`billing_event_id = ${event!.id}`);
		expect(refunds).toEqual([
			expect.objectContaining({
				user_id: a.id,
				provider: 'mock',
				reference: pro.reference,
				amount_minor: event!.amount_minor,
				currency: event!.currency,
				reason: 'plan_higher',
				status: 'pending',
				provider_refund_id: null,
				resolved_at: null
			})
		]);
		// No credit and no plan row came from that payment.
		expect(await count('credit_ledger', sql`reference_id = ${event!.id}`)).toBe(0);
		expect(await count('plan_changes', sql`reference_id = ${event!.id}`)).toBe(0);
		expect(await creditBalance(db, a.id)).toBe(1300);
	});

	it('a paid checkout past its expiry owes a checkout_expired refund', async () => {
		const a = await person();
		const late = await checkoutFor(a, 'pro', Date.now() - 61 * 60 * 1000);
		expect(await signed(late.body('evt_c2_late'))).toBe('ignored_paid');
		expect(await refundRows(sql`reference = ${late.reference}`)).toEqual([
			expect.objectContaining({ reason: 'checkout_expired', status: 'pending', user_id: a.id })
		]);
		expect(await planOf(db, a.id, Date.now())).toBe('gratis');
	});

	it('a replay, a new event id for the same reference and 20 concurrent deliveries leave exactly one refund', async () => {
		const { pro } = await notApplied('c3');
		expect(await signed(pro.body('evt_c3_pro'))).toBe('replay');
		expect(await signed(pro.body('evt_c3_pro_new_id'))).toBe('replay');
		expect(await count('billing_refunds', sql`reference = ${pro.reference}`)).toBe(1);

		const b = await person();
		const proB = await checkoutFor(b, 'pro');
		const agenB = await checkoutFor(b, 'agen');
		expect(await signed(agenB.body('evt_c3b_agen'))).toBe('applied');
		const outcomes = await Promise.all(
			Array.from({ length: 20 }, (_, i) => signed(proB.body(`evt_c3b_pro_${i}`)))
		);
		expect(outcomes.filter((o) => o === 'ignored_paid')).toHaveLength(1);
		expect(outcomes.filter((o) => o === 'replay')).toHaveLength(19);
		expect(await count('billing_refunds', sql`reference = ${proB.reference}`)).toBe(1);
	});

	it('an applied payment owes no refund', async () => {
		const a = await person();
		const c = await checkoutFor(a);
		expect(await signed(c.body('evt_c4_ok'))).toBe('applied');
		expect(await count('billing_refunds', sql`reference = ${c.reference}`)).toBe(0);
		expect(await count('billing_refunds', sql`user_id = ${a.id}`)).toBe(0);
	});
});

describe('recordRefundOutcome (criterion 5)', () => {
	const refundOf = async (reference: string) =>
		(await refundRows(sql`reference = ${reference}`))[0] as { id: string };

	it('pending → refunded once; a second call changes nothing; an unknown id is not_found', async () => {
		const { pro } = await notApplied('c5');
		const { id } = await refundOf(pro.reference);
		const at = Date.now();
		expect(await recordRefundOutcome(db, id, 'refunded', 'rf_mock:2026-10.1', at)).toBe('done');
		const [after] = await refundRows(sql`id = ${id}`);
		expect(after).toMatchObject({
			status: 'refunded',
			provider_refund_id: 'rf_mock:2026-10.1',
			resolved_at: at,
			updated_at: at
		});
		expect(await recordRefundOutcome(db, id, 'cancelled', null, at + 1)).toBe('already_resolved');
		expect((await refundRows(sql`id = ${id}`))[0]).toEqual(after);
		expect(await recordRefundOutcome(db, crypto.randomUUID(), 'refunded', null, at)).toBe(
			'not_found'
		);
		await expect(recordRefundOutcome(db, id, 'refunded', 'spasi tidak boleh', at)).rejects.toThrow(
			RangeError
		);
		await expect(recordRefundOutcome(db, id, 'refunded', 'x'.repeat(101), at)).rejects.toThrow(
			RangeError
		);
	});

	it('20 concurrent calls give exactly one done', async () => {
		const { pro } = await notApplied('c5b');
		const { id } = await refundOf(pro.reference);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				recordRefundOutcome(db, id, i % 2 ? 'refunded' : 'cancelled', null, Date.now())
			)
		);
		expect(results.filter((r) => r === 'done')).toHaveLength(1);
		expect(results.filter((r) => r === 'already_resolved')).toHaveLength(19);
	});
});

describe('billing_refunds triggers (criterion 6)', () => {
	it('refuse a DELETE, an amount change, refunded → pending and nulling user_id of a live user', async () => {
		const { a, pro } = await notApplied('c6');
		const [{ id }] = (await refundRows(sql`reference = ${pro.reference}`)) as [{ id: string }];
		const refused = (statement: string, ...binds: unknown[]) =>
			expect(
				d1
					.prepare(statement)
					.bind(...binds)
					.run()
			).rejects.toThrow(/append-only/);
		await refused('delete from billing_refunds where id = ?', id);
		await refused('update billing_refunds set amount_minor = 1 where id = ?', id);
		await refused('update billing_refunds set user_id = null where id = ?', id);
		// A pending row may not "resolve" without resolved_at, nor change its reason on the way.
		await expect(
			d1.prepare(`update billing_refunds set status = 'cancelled' where id = ?`).bind(id).run()
		).rejects.toThrow();
		await refused(
			`update billing_refunds set status = 'cancelled', resolved_at = 1, reason = 'unknown' where id = ?`,
			id
		);
		expect(await recordRefundOutcome(db, id, 'refunded', null, Date.now())).toBe('done');
		await refused(
			`update billing_refunds set status = 'pending', resolved_at = null where id = ?`,
			id
		);
		await refused(`update billing_refunds set provider_refund_id = 'later' where id = ?`, id);
		expect(await count('billing_refunds', sql`id = ${id} and user_id = ${a.id}`)).toBe(1);
	});
});

describe('/pengaturan/paket refunds (criterion 8) and deletion (criterion 10)', () => {
	const load = (who: Person) => {
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/paket',
			routeId: '/(app)/pengaturan/paket',
			db,
			user: who
		});
		return run(() => paket.load(event as never)) as Promise<{
			kind: 'ok';
			value: { refunds: { amountMinor: number; currency: string }[] } & Record<string, unknown>;
		}>;
	};

	it('lists only the signed-in user’s own refunds; a user with none gets an empty list', async () => {
		const { a, pro } = await notApplied('c8');
		const b = await person();
		const mine = await load(a);
		expect(mine.value.refunds).toEqual([
			{
				id: expect.any(String),
				provider: 'mock',
				amountMinor: 4_900_000,
				currency: 'IDR',
				plan: 'pro',
				status: 'pending',
				createdAt: expect.any(Number)
			}
		]);
		const [row] = mine.value.refunds;
		expect(formatMoney(row!.amountMinor, row!.currency).replace(/\s/g, ' ')).toBe('Rp 49.000');
		expect(JSON.stringify(mine.value.refunds)).not.toContain(pro.reference);
		expect((await load(b)).value.refunds).toEqual([]);
		expect(await refundsForUser(db, b.id)).toEqual([]);
	});

	it('a refund survives account deletion with user_id null and stays in pendingRefunds', async () => {
		const { a, pro } = await notApplied('c10');
		await deleteVia(a);
		const [row] = await refundRows(sql`reference = ${pro.reference}`);
		expect(row).toMatchObject({ user_id: null, status: 'pending' });
		const pending = await pendingRefunds(db);
		expect(pending.rows.map((r) => r.reference)).toContain(pro.reference);
	});
});

describe('pendingRefunds (criterion 11)', () => {
	it('counts exactly beyond 101 pending rows and lists at most 100, newest first', async () => {
		const before = (await pendingRefunds(db)).count;
		await d1
			.prepare(
				`with recursive k(i) as (select 1 union all select i + 1 from k where i < 105)
				insert into billing_events (id, user_id, provider, provider_event_id, kind, reference, plan, amount_minor,
					currency, signature_valid, created_at)
				select 'bulk-evt-' || i, null, 'mock', 'bulk-pe-' || i, 'paid_not_applied', 'bulk-ref-' || i, 'pro',
					4900000, 'IDR', 1, 1000 + i from k`
			)
			.run();
		await d1
			.prepare(
				`insert into billing_refunds (id, billing_event_id, user_id, provider, reference, amount_minor, currency,
					reason, status, created_at, updated_at)
				select 'bulk-rf-' || substr(id, 10), id, null, provider, reference, amount_minor, currency, 'unknown',
					'pending', created_at, created_at from billing_events where id like 'bulk-evt-%'`
			)
			.run();
		const listed = await pendingRefunds(db);
		expect(listed.count).toBe(before + 105);
		expect(listed.rows).toHaveLength(REFUND_LIST_LIMIT);
		const times = listed.rows.map((r) => r.createdAt);
		expect([...times].sort((x, y) => y - x)).toEqual(times);
		for (const r of listed.rows)
			expect(Object.keys(r).sort()).toEqual(
				['amountMinor', 'createdAt', 'currency', 'id', 'provider', 'reason', 'reference'].sort()
			);
	});
});

describe('re-claim markers (criteria 15–22)', () => {
	const markers = () =>
		db.all<Record<string, unknown>>(sql`select * from claim_markers order by created_at`);
	const markersOf = async (email: string, key = K1) => {
		const hashes = await claimHashes({ CLAIM_HASH_KEY: key }, email);
		return db.all<{ kind: string; voucher_id: string | null }>(
			sql`select kind, voucher_id from claim_markers where email_hmac = ${hashes!.current}
				order by kind, voucher_id`
		);
	};

	it('delete and sign up again with a Gmail alias: the account exists on Gratis with 0 credits (criterion 15)', async () => {
		const a = await signUpVia('ab15@gmail.com');
		expect(await creditBalance(db, a.id)).toBe(300);
		await deleteVia(a);
		expect(await markersOf('ab15@gmail.com')).toEqual([
			{ kind: 'starter_grant', voucher_id: null }
		]);
		const again = await signUpVia('a.b15+1@gmail.com');
		expect(await planStateOf(db, again.id, Date.now())).toEqual({
			plan: 'gratis',
			storedPlan: 'gratis',
			currentPeriodEnd: null
		});
		expect(await creditBalance(db, again.id)).toBe(0);
		expect(await markersOf('ab15@gmail.com')).toHaveLength(1);
		// No column of any marker holds the raw or the canonical address, nor any part of it.
		const text = JSON.stringify(await markers());
		for (const part of ['ab15', 'a.b15', 'gmail', '@']) expect(text).not.toContain(part);
	});

	it('a per-person voucher redeemed before deletion answers already_redeemed after re-sign-up (criteria 16, 17)', async () => {
		const { code, id: voucherId } = await createVoucher(
			db,
			{ code: 'BEKAS-KREDIT-2026-16', kind: 'credits', creditsAmount: 50, maxRedemptions: 100 },
			1
		);
		const a = await signUpVia('ani16@contoh.id');
		expect(await redeemVia(a, code)).toMatchObject({ kind: 'ok' });
		await deleteVia(a);
		expect(await markersOf('ani16@contoh.id')).toEqual([
			{ kind: 'starter_grant', voucher_id: null },
			{ kind: 'voucher', voucher_id: voucherId }
		]);
		const again = await signUpVia('Ani16+lagi@contoh.id');
		expect(await redeemVia(again, code)).toEqual({
			kind: 'fail',
			status: 409,
			data: { action: 'redeem', code, error: VOUCHER_ALREADY_REDEEMED }
		});
		expect(await count('credit_ledger', sql`user_id = ${again.id}`)).toBe(0);
		// 20 concurrent redemptions by the re-signed-up account: none succeeds.
		const hashes = await claimHashes({ CLAIM_HASH_KEY: K1 }, again.email);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => redeemVoucher(db, again.id, code, Date.now(), hashes))
		);
		expect(results.every((r) => !r.ok && r.reason === 'already_redeemed')).toBe(true);
		expect(await count('voucher_redemptions', sql`user_id = ${again.id}`)).toBe(0);
		// Another person still can.
		const other = await person();
		expect(await redeemVia(other, code)).toMatchObject({ kind: 'ok' });
		expect(await creditBalance(db, other.id)).toBe(350);
	});

	it('key rotation: markers under the previous key still refuse; without _PREVIOUS they are forgotten (criterion 18)', async () => {
		const { code } = await createVoucher(
			db,
			{ code: 'ROTASI-KREDIT-2026-18', kind: 'credits', creditsAmount: 7, maxRedemptions: 100 },
			1
		);
		const a = await signUpVia('budi18@contoh.id');
		expect(await redeemVia(a, code)).toMatchObject({ kind: 'ok' });
		await deleteVia(a); // markers under K1
		configure({ key: K2, previous: K1 });
		const b = await signUpVia('budi18+b@contoh.id');
		expect(await creditBalance(db, b.id)).toBe(0);
		expect(await redeemVia(b, code)).toMatchObject({ kind: 'fail', status: 409 });
		configure({ key: K2 });
		const c = await signUpVia('budi18+c@contoh.id');
		expect(await creditBalance(db, c.id)).toBe(300);
		expect(await redeemVia(c, code)).toMatchObject({ kind: 'ok' });
	});

	it('CLAIM_HASH_KEY unset: deletion succeeds without a marker, sign-up grants 300, redeem works (criterion 19)', async () => {
		configure({});
		const { code } = await createVoucher(
			db,
			{ code: 'TANPA-KEY-2026-19', kind: 'credits', creditsAmount: 9, maxRedemptions: 100 },
			1
		);
		const a = await signUpVia('citra19@contoh.id');
		expect(await redeemVia(a, code)).toMatchObject({ kind: 'ok' });
		const before = await count('claim_markers');
		await deleteVia(a);
		expect(await count('claim_markers')).toBe(before);
		expect(await count('users', sql`id = ${a.id}`)).toBe(0);
		const again = await signUpVia('citra19+x@contoh.id');
		expect(await creditBalance(db, again.id)).toBe(300);
		expect(await redeemVia(again, code)).toMatchObject({ kind: 'ok' });
		// Malformed counts as unset.
		configure({ key: base64urlEncode(new Uint8Array(33)) });
		const b = await signUpVia('citra19+y@contoh.id');
		expect(await creditBalance(db, b.id)).toBe(300);
	});

	it('a wrong proof deletes nothing and writes no marker (criterion 20)', async () => {
		const a = await signUpVia('dewi20@contoh.id');
		const hashes = await claimHashes({ CLAIM_HASH_KEY: K1 }, a.email);
		const before = await count('claim_markers');
		expect(await deleteAccount(db, a.id, 'not-the-hash', Date.now(), hashes!.current)).toBe(false);
		expect(await count('claim_markers')).toBe(before);
		expect(await count('users', sql`id = ${a.id}`)).toBe(1);
	});

	it('a live account holds no marker: sign-up and redeem write none (criterion 22)', async () => {
		const { code } = await createVoucher(
			db,
			{ code: 'AKTIF-KREDIT-2026-22', kind: 'credits', creditsAmount: 3, maxRedemptions: 5 },
			1
		);
		const before = await count('claim_markers');
		const a = await signUpVia('eka22@contoh.id');
		expect(await redeemVia(a, code)).toMatchObject({ kind: 'ok' });
		expect(await count('claim_markers')).toBe(before);
		expect(await markersOf(a.email)).toEqual([]);
	});

	it('red team L5: deleting the same address again restarts the marker’s 730 days', async () => {
		const a = await signUpVia('l5again@example.com');
		await deleteVia(a);
		const hashes = await claimHashes({ CLAIM_HASH_KEY: K1 }, 'l5again@example.com');
		const old = Date.now() - 400 * DAY_MS;
		await d1
			.prepare('update claim_markers set created_at = ? where email_hmac = ?')
			.bind(old, hashes!.current)
			.run();
		const again = await signUpVia('l5again@example.com');
		expect(await creditBalance(db, again.id)).toBe(0);
		const before = Date.now();
		await deleteVia(again);
		const [row] = await db.all<{ created_at: number }>(
			sql`select created_at from claim_markers where email_hmac = ${hashes!.current}`
		);
		expect(row!.created_at).toBeGreaterThanOrEqual(before);
		expect(await markersOf('l5again@example.com')).toHaveLength(1);
	});

	it('retention: only markers older than 730 days go, at most 500 per call (criterion 21)', async () => {
		const now = Date.now();
		const insert = (tag: string, createdAt: number, rows = 1) =>
			d1
				.prepare(
					`with recursive k(i) as (select 1 union all select i + 1 from k where i < ?)
					insert into claim_markers (email_hmac, kind, voucher_id, created_at)
					select substr(? || '-' || i || '-' || hex(randomblob(32)), 1, 43), 'starter_grant', null, ? from k`
				)
				.bind(rows, tag, createdAt)
				.run();
		await insert('old731', now - 731 * DAY_MS);
		await insert('new729', now - 729 * DAY_MS);
		expect(await sweepClaimMarkers(db, now)).toBe(1);
		expect(await count('claim_markers', sql`email_hmac like 'old731-%'`)).toBe(0);
		expect(await count('claim_markers', sql`email_hmac like 'new729-%'`)).toBe(1);
		expect(CLAIM_MARKER_RETENTION_MS).toBe(730 * DAY_MS);

		await insert('bulk', now - 800 * DAY_MS, CLAIM_SWEEP_BATCH + 7);
		expect(await sweepClaimMarkers(db, now)).toBe(CLAIM_SWEEP_BATCH);
		expect(await sweepClaimMarkers(db, now)).toBe(7);
		expect(await count('claim_markers', sql`email_hmac like 'new729-%'`)).toBe(1);
	});
});
