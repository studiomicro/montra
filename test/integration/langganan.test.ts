import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { listCategories, ensurePresetCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { setFeatureFlag } from '#lib/server/feature-flags/repo';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	DEMO_NOT_PAYABLE,
	PAY_TRANSACTION_NOT_FOUND,
	SUBSCRIPTION_CHANGED,
	SUBSCRIPTION_LIMIT,
	SUBSCRIPTION_NOT_FOUND,
	WALLET_INVALID
} from '#lib/server/subscriptions/messages';
import { listNotifications, setNotificationPref } from '#lib/server/notifications/repo';
import { spacesWithSubscriptions } from '#lib/server/notifications/schedule';
import { evaluateBills } from '#lib/server/notifications/triggers';
import { dueBillReminders } from '#lib/server/subscriptions/reminders';
import { MAX_SUBSCRIPTIONS_PER_SPACE } from '#lib/server/subscriptions/repo';
import { createTransaction, deleteTransaction } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { addDays, formatShortDay, wibTodayString } from '#lib/shared/dates';
import { formatMoney } from '#lib/shared/money-format';
import { createTranslator } from '#lib/shared/i18n';
import { notificationText, notificationUrl, parseParams } from '#lib/shared/notifications';
import { billReminderDataKey, followingCharge, nextChargeOn } from '#lib/shared/subscriptions';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/langganan/+page.server');
const layout = await import('../../src/routes/(app)/+layout.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

type Action = (event: never) => unknown;

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
async function person(name = 'Uji') {
	const email = `langganan${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	return { user: { id: r.userId, email, name, createdAt: 0 }, spaceId: space.id };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An event as `who` in the space the cookie names (else their personal one); `space` overrides locals.space. */
async function ev(
	who: Person | null,
	opts: { path?: string; form?: Record<string, string>; spaceCookie?: string; space?: string }
) {
	let space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	if (opts.space) space = { id: opts.space, kind: 'shared', name: 'x', role: 'member' };
	return fakeEvent({
		url: `http://localhost${opts.path ?? '/langganan'}`,
		routeId: '/(app)/langganan',
		db,
		user: who?.user ?? null,
		space,
		form: opts.form
	}).event as never;
}

const load = (who: Person | null, path = '/langganan', spaceCookie?: string) =>
	run(async () => page.load(await ev(who, { path, spaceCookie })));
const act = (
	who: Person,
	name: string,
	form: Record<string, string>,
	opts: { spaceCookie?: string; space?: string } = {}
) =>
	run(async () =>
		(page.actions as Record<string, Action>)[name]!(await ev(who, { form, ...opts }))
	);

interface Loaded {
	today: string;
	subscriptions: {
		id: string;
		name: string;
		catalogueId: string | null;
		category: string;
		amountMinor: number;
		currency: string;
		schedule: { cycle: string; day: number; month: number | null };
		walletId: string | null;
		linked: { id: string; occurredOn: string } | null;
		nextChargeOn: string;
		updatedAt: number;
	}[];
	totals: { currency: string; totalMinor: number | null }[];
	categories: { id: string; tileKey: string; isPreset: boolean }[];
	expenses: { id: string }[];
}
async function listOf(who: Person, spaceCookie?: string) {
	const r = await load(who, '/langganan', spaceCookie);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value as unknown as Loaded;
}

const form = (fields: Record<string, string> = {}) => ({
	name: 'Netflix',
	category: 'streaming',
	amount: '186.000',
	currency: 'IDR',
	cycle: 'monthly',
	day: '15',
	weekday: '1',
	month: '1',
	reminderDays: '2',
	...fields
});
async function newSub(who: Person, fields: Record<string, string> = {}, spaceCookie?: string) {
	const r = await act(who, 'createSubscription', form(fields), { spaceCookie });
	if (r.kind !== 'ok') throw new Error(`create failed: ${JSON.stringify(r)}`);
	const list = await listOf(who, spaceCookie);
	return list.subscriptions.find((s) => s.name === (fields.name ?? 'Netflix'))!;
}
async function wallet(who: Person, currency: 'IDR' | 'USD' = 'IDR', spaceId = who.spaceId) {
	const r = await createWallet(
		db,
		{ spaceId, userId: who.user.id },
		{
			name: `Dompet ${currency}`,
			type: 'bank',
			currency,
			openingBalanceMinor: 0,
			isFavourite: false,
			lastFour: null
		},
		Date.now()
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}
async function category(who: Person, tileKey = 'hiburan', spaceId = who.spaceId) {
	await ensurePresetCategories(db, spaceId);
	return (await listCategories(db, spaceId)).find((c) => c.tileKey === tileKey)!.id;
}
async function expense(
	who: Person,
	walletId: string,
	opts: { currency?: string; type?: 'expense' | 'income'; spaceId?: string } = {}
) {
	const spaceId = opts.spaceId ?? who.spaceId;
	const type = opts.type ?? 'expense';
	const r = await createTransaction(
		db,
		{ spaceId, userId: who.user.id },
		{
			type,
			amountMinor: 18_600_000,
			currency: opts.currency ?? 'IDR',
			walletId,
			transferToWalletId: null,
			categoryId: await category(who, type === 'income' ? 'gaji' : 'hiburan', spaceId),
			title: 'Bayar Netflix',
			note: null,
			occurredOn: wibTodayString(),
			occurredTime: null
		},
		Date.now()
	);
	if (!r.ok) throw new Error('transaction failed');
	return r.id;
}
const rowOf = (id: string) =>
	d1.prepare('select * from subscriptions where id = ?').bind(id).first<Record<string, unknown>>();
const count = async (sql: string, ...binds: unknown[]) =>
	(await d1
		.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>())!.n;

describe('/langganan load', () => {
	it('an empty space gets an empty list, no totals and no error', async () => {
		const p = await person();
		expect(await load(p)).toMatchObject({
			kind: 'ok',
			value: { subscriptions: [], totals: [], loadError: null, today: wibTodayString() }
		});
	});

	it('reads the no-JavaScript open states from the query (bounded ids)', async () => {
		const p = await person();
		const r = await load(p, `/langganan?tambah=netflix&ubah=${'x'.repeat(100)}&bayar=abc`);
		expect(r).toMatchObject({
			value: { open: { add: 'netflix', edit: 'x'.repeat(64), pay: 'abc' } }
		});
	});

	it('signed out → /masuk', async () => {
		expect(await load(null)).toMatchObject({ kind: 'redirect', location: '/masuk' });
	});
});

describe('create, edit, delete', () => {
	it('creates from the catalogue: name and category copied, next charge in WIB, monthly total', async () => {
		const p = await person();
		expect(
			await act(
				p,
				'createSubscription',
				form({ catalogueId: 'disney-hotstar', name: '', category: '', day: '31' })
			)
		).toEqual({ kind: 'ok', value: { saved: 'created' } });
		const list = await listOf(p);
		const today = wibTodayString();
		expect(list.subscriptions).toMatchObject([
			{
				catalogueId: 'disney-hotstar',
				name: 'Disney+ Hotstar',
				category: 'streaming',
				amountMinor: 18_600_000,
				schedule: { cycle: 'monthly', day: 31, month: null },
				nextChargeOn: nextChargeOn({ cycle: 'monthly', day: 31, month: null }, today),
				linked: null
			}
		]);
		expect(list.totals).toEqual([{ currency: 'IDR', totalMinor: 18_600_000 }]);
	});

	it('a typed name has no catalogue id', async () => {
		const p = await person();
		const s = await newSub(p, { name: 'Gym Sehat', category: 'lainnya' });
		expect(s.catalogueId).toBeNull();
		expect((await rowOf(s.id))!.catalogue_id).toBeNull();
	});

	it('refuses bad fields with field errors, echoes them, writes nothing', async () => {
		const p = await person();
		const before = await count('select count(*) as n from subscriptions');
		const r = await act(p, 'createSubscription', form({ amount: '12,50', cycle: 'daily' }));
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { action: 'create', values: { amount: '12,50' } }
		});
		expect(Object.keys((r as unknown as { data: { errors: object } }).data.errors).sort()).toEqual([
			'amountMinor',
			'cycle'
		]);
		expect(await count('select count(*) as n from subscriptions')).toBe(before);
	});

	it('answers 400 to an oversized body and 415 to a non-form body, never 500', async () => {
		const p = await person();
		expect(await act(p, 'createSubscription', form({ name: 'x'.repeat(20 * 1024) }))).toMatchObject(
			{ kind: 'error', status: 400 }
		);
		const plain = await run(async () =>
			(page.actions as Record<string, Action>).createSubscription!(
				fakeEvent({
					url: 'http://localhost/langganan',
					db,
					user: p.user,
					space: await resolveCurrentSpace(db, p.user.id, undefined),
					form: form(),
					headers: { 'content-type': 'text/plain' }
				}).event as never
			)
		);
		expect(plain).toMatchObject({ kind: 'error', status: 415 });
	});

	it('takes a wallet of the same currency; refuses another currency or another space’s wallet', async () => {
		const p = await person();
		const other = await person();
		const idr = await wallet(p);
		const usd = await wallet(p, 'USD');
		const foreign = await wallet(other);
		for (const walletId of [usd, foreign, 'tidak-ada'])
			expect(await act(p, 'createSubscription', form({ walletId }))).toMatchObject({
				kind: 'fail',
				status: 400,
				data: { action: 'create', errors: { walletId: WALLET_INVALID } }
			});
		const s = await newSub(p, { walletId: idr });
		expect(s.walletId).toBe(idr);
	});

	it('edits; a stale form gets 409; an unknown or foreign id gets 404', async () => {
		const p = await person();
		const other = await person();
		const s = await newSub(p);
		const theirs = await newSub(other, { name: 'Spotify' });
		const edit = (fields: Record<string, string>, who = p) =>
			act(who, 'updateSubscription', form({ subscriptionId: s.id, ...fields }));
		expect(await edit({ updatedAt: String(s.updatedAt), amount: '199.000' })).toEqual({
			kind: 'ok',
			value: { saved: 'updated' }
		});
		expect((await listOf(p)).subscriptions[0]!.amountMinor).toBe(19_900_000);
		// The same (now stale) form again: refused, nothing overwritten.
		expect(await edit({ updatedAt: String(s.updatedAt), amount: '1.000' })).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: SUBSCRIPTION_CHANGED }
		});
		expect((await listOf(p)).subscriptions[0]!.amountMinor).toBe(19_900_000);
		for (const subscriptionId of [theirs.id, 'tidak-ada'])
			expect(
				await act(
					p,
					'updateSubscription',
					form({ subscriptionId, updatedAt: String(theirs.updatedAt) })
				)
			).toEqual({ kind: 'fail', status: 404, data: { error: SUBSCRIPTION_NOT_FOUND } });
		expect((await listOf(other)).subscriptions[0]!.amountMinor).toBe(18_600_000);
	});

	it('an edit keeps a paid-ahead next charge unless the schedule changes', async () => {
		const p = await person();
		const w = await wallet(p);
		const s = await newSub(p, { day: '15' });
		const tx = await expense(p, w);
		await act(p, 'markPaid', {
			subscriptionId: s.id,
			updatedAt: String(s.updatedAt),
			mode: 'link',
			transactionId: tx
		});
		const paid = (await listOf(p)).subscriptions[0]!;
		expect(paid.nextChargeOn).toBe(followingCharge(s.schedule as never, s.nextChargeOn));
		await act(
			p,
			'updateSubscription',
			form({ subscriptionId: s.id, updatedAt: String(paid.updatedAt), amount: '1.000' })
		);
		const priced = (await listOf(p)).subscriptions[0]!;
		expect(priced.nextChargeOn).toBe(paid.nextChargeOn);
		await act(
			p,
			'updateSubscription',
			form({ subscriptionId: s.id, updatedAt: String(priced.updatedAt), day: '3' })
		);
		expect((await listOf(p)).subscriptions[0]!.nextChargeOn).toBe(
			nextChargeOn({ cycle: 'monthly', day: 3, month: null }, wibTodayString())
		);
	});

	it('delete leaves a content-free tombstone; a second delete is 404', async () => {
		const p = await person();
		const w = await wallet(p);
		const s = await newSub(p, { walletId: w, catalogueId: 'netflix' });
		const del = () =>
			act(p, 'deleteSubscription', { subscriptionId: s.id, updatedAt: String(s.updatedAt) });
		expect(await del()).toEqual({ kind: 'ok', value: { saved: 'deleted' } });
		expect((await listOf(p)).subscriptions).toEqual([]);
		const row = (await rowOf(s.id))!;
		expect(row.deleted_at).not.toBeNull();
		for (const column of [
			'catalogue_id',
			'name',
			'category',
			'amount_minor',
			'currency',
			'billing_cycle',
			'billing_day',
			'billing_month',
			'wallet_id',
			'linked_transaction_id',
			'next_charge_on',
			'reminder_days_before'
		])
			expect(row[column], column).toBeNull();
		expect(await del()).toEqual({
			kind: 'fail',
			status: 404,
			data: { error: SUBSCRIPTION_NOT_FOUND }
		});
	});

	it('the DB refuses a tombstone with content and an invalid live schedule', async () => {
		const p = await person();
		const s = await newSub(p);
		await expect(
			d1.prepare('update subscriptions set deleted_at = 1 where id = ?').bind(s.id).run()
		).rejects.toThrow(/CHECK/);
		await expect(
			d1
				.prepare("update subscriptions set billing_cycle = 'weekly', billing_day = 8 where id = ?")
				.bind(s.id)
				.run()
		).rejects.toThrow(/CHECK/);
	});
});

describe('the cap (100 live per space)', () => {
	it('20 concurrent creates at 99 live rows: exactly one passes', async () => {
		const p = await person();
		const now = Date.now();
		const values = Array.from(
			{ length: MAX_SUBSCRIPTIONS_PER_SPACE - 1 },
			(_, i) =>
				`('seed-${p.spaceId}-${i}', '${p.spaceId}', 'S${i}', 'lainnya', 100, 'IDR', 'monthly', 1, '2026-11-01', 2, ${now}, ${now}, 0)`
		).join(',');
		await d1
			.prepare(
				`insert into subscriptions (id, space_id, name, category, amount_minor, currency, billing_cycle,
				billing_day, next_charge_on, reminder_days_before, created_at, updated_at, seq) values ${values}`
			)
			.run();
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				act(p, 'createSubscription', form({ name: `Baru ${i}` }))
			)
		);
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
		expect(results.filter((r) => r.kind === 'fail')).toEqual(
			Array.from({ length: 19 }, () => ({
				kind: 'fail',
				status: 409,
				data: { error: SUBSCRIPTION_LIMIT }
			}))
		);
		expect(
			await count(
				'select count(*) as n from subscriptions where space_id = ? and deleted_at is null',
				p.spaceId
			)
		).toBe(MAX_SUBSCRIPTIONS_PER_SPACE);
		// The list is bounded by the same cap.
		expect((await listOf(p)).subscriptions).toHaveLength(MAX_SUBSCRIPTIONS_PER_SPACE);
	});
});

describe('Tandai sudah dibayar', () => {
	it('"catat transaksi baru" writes exactly one manual expense through FN-05 and advances one cycle', async () => {
		const p = await person();
		const w = await wallet(p);
		const s = await newSub(p, { name: 'Netflix', category: 'streaming', walletId: w, day: '31' });
		const cat = await category(p, 'hiburan');
		const before = await count(
			'select count(*) as n from transactions where space_id = ?',
			p.spaceId
		);
		const pay = {
			subscriptionId: s.id,
			updatedAt: String(s.updatedAt),
			mode: 'new',
			walletId: w,
			categoryId: cat,
			occurredOn: wibTodayString()
		};
		expect(await act(p, 'markPaid', pay)).toEqual({ kind: 'ok', value: { saved: 'paid' } });
		const tx = await d1
			.prepare('select * from transactions where space_id = ? order by created_at desc limit 1')
			.bind(p.spaceId)
			.first<Record<string, unknown>>();
		expect(tx).toMatchObject({
			type: 'expense',
			amount_minor: 18_600_000,
			currency: 'IDR',
			wallet_id: w,
			category_id: cat,
			title: 'Netflix',
			source: 'manual',
			is_demo: 0,
			occurred_on: wibTodayString()
		});
		const after = (await listOf(p)).subscriptions[0]!;
		expect(after.linked).toEqual({ id: tx!.id, occurredOn: wibTodayString() });
		expect(after.nextChargeOn).toBe(followingCharge(s.schedule as never, s.nextChargeOn));
		// A replay of the same form (two tabs, double submit): refused, still exactly one new row.
		expect(await act(p, 'markPaid', pay)).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: SUBSCRIPTION_CHANGED }
		});
		expect(
			await count('select count(*) as n from transactions where space_id = ?', p.spaceId)
		).toBe(before + 1);
	});

	it('the new expense is refused by FN-05’s rules (other-currency or foreign wallet, foreign category, bad date)', async () => {
		const p = await person();
		const other = await person();
		const usd = await wallet(p, 'USD');
		const theirWallet = await wallet(other);
		const theirCat = await category(other);
		const cat = await category(p);
		const w = await wallet(p);
		const s = await newSub(p);
		const before = await count('select count(*) as n from transactions');
		for (const [fields, field] of [
			[{ walletId: usd, categoryId: cat, occurredOn: wibTodayString() }, 'walletId'],
			[{ walletId: theirWallet, categoryId: cat, occurredOn: wibTodayString() }, 'walletId'],
			[{ walletId: w, categoryId: theirCat, occurredOn: wibTodayString() }, 'categoryId'],
			[{ walletId: w, categoryId: cat, occurredOn: '2026-02-30' }, 'occurredOn']
		] as const) {
			const r = await act(p, 'markPaid', {
				subscriptionId: s.id,
				updatedAt: String(s.updatedAt),
				mode: 'new',
				...fields
			});
			expect(r).toMatchObject({ kind: 'fail', status: 400, data: { payFor: s.id } });
			expect(
				Object.keys((r as unknown as { data: { payErrors: object } }).data.payErrors)
			).toContain(field);
		}
		expect(await count('select count(*) as n from transactions')).toBe(before);
		expect((await rowOf(s.id))!.linked_transaction_id).toBeNull();
	});

	it('"hubungkan" links an existing expense and creates nothing', async () => {
		const p = await person();
		const w = await wallet(p);
		const s = await newSub(p);
		const tx = await expense(p, w);
		const before = await count('select count(*) as n from transactions');
		expect(
			await act(p, 'markPaid', {
				subscriptionId: s.id,
				updatedAt: String(s.updatedAt),
				mode: 'link',
				transactionId: tx
			})
		).toEqual({ kind: 'ok', value: { saved: 'paid' } });
		expect(await count('select count(*) as n from transactions')).toBe(before);
		expect((await rowOf(s.id))!.linked_transaction_id).toBe(tx);
	});

	it('another space’s, an unknown, an income or another currency’s transaction: one 404, nothing changed', async () => {
		const p = await person();
		const other = await person();
		const w = await wallet(p);
		const usd = await wallet(p, 'USD');
		const s = await newSub(p);
		const foreign = await expense(other, await wallet(other));
		const income = await expense(p, w, { type: 'income' });
		const dollars = await expense(p, usd, { currency: 'USD' });
		const before = JSON.stringify(await rowOf(s.id));
		for (const transactionId of [foreign, 'tidak-ada', income, dollars])
			expect(
				await act(p, 'markPaid', {
					subscriptionId: s.id,
					updatedAt: String(s.updatedAt),
					mode: 'link',
					transactionId
				})
			).toEqual({
				kind: 'fail',
				status: 404,
				data: { payFor: s.id, payError: PAY_TRANSACTION_NOT_FOUND }
			});
		expect(JSON.stringify(await rowOf(s.id))).toBe(before);
	});

	it('a deleted linked transaction reads as "not linked", never a broken reference', async () => {
		const p = await person();
		const w = await wallet(p);
		const s = await newSub(p);
		const tx = await expense(p, w);
		await act(p, 'markPaid', {
			subscriptionId: s.id,
			updatedAt: String(s.updatedAt),
			mode: 'link',
			transactionId: tx
		});
		expect((await listOf(p)).subscriptions[0]!.linked?.id).toBe(tx);
		const row = await d1
			.prepare('select updated_at as u from transactions where id = ?')
			.bind(tx)
			.first<{ u: number }>();
		expect(
			await deleteTransaction(db, { spaceId: p.spaceId, userId: p.user.id }, tx, row!.u, Date.now())
		).toBe('ok');
		expect((await listOf(p)).subscriptions[0]!.linked).toBeNull();
	});

	it('an unknown subscription is 404 and a stale one 409, before any transaction is written', async () => {
		const p = await person();
		const w = await wallet(p);
		const s = await newSub(p);
		const before = await count('select count(*) as n from transactions');
		const pay = {
			mode: 'new',
			walletId: w,
			categoryId: await category(p),
			occurredOn: wibTodayString()
		};
		expect(
			await act(p, 'markPaid', { subscriptionId: 'tidak-ada', updatedAt: '1', ...pay })
		).toEqual({ kind: 'fail', status: 404, data: { error: SUBSCRIPTION_NOT_FOUND } });
		expect(
			await act(p, 'markPaid', { subscriptionId: s.id, updatedAt: String(s.updatedAt - 1), ...pay })
		).toEqual({ kind: 'fail', status: 409, data: { error: SUBSCRIPTION_CHANGED } });
		expect(await count('select count(*) as n from transactions')).toBe(before);
	});
});

describe('next charge is never stale (AC4)', () => {
	it('a stored date in the past is recomputed from the schedule and today on load', async () => {
		const p = await person();
		const s = await newSub(p, { day: '10' });
		const today = wibTodayString();
		await d1
			.prepare('update subscriptions set next_charge_on = ? where id = ?')
			.bind(addDays(today, -400), s.id)
			.run();
		expect((await listOf(p)).subscriptions[0]!.nextChargeOn).toBe(
			nextChargeOn({ cycle: 'monthly', day: 10, month: null }, today)
		);
	});
});

describe('Data demo subscriptions', () => {
	it('are listed badged, never counted in the total, and never marked paid', async () => {
		const p = await person();
		const real = await newSub(p, { name: 'Nyata' });
		await d1
			.prepare(
				`insert into subscriptions (id, space_id, name, category, amount_minor, currency, billing_cycle,
				billing_day, next_charge_on, reminder_days_before, is_demo, created_at, updated_at, seq)
				values (?, ?, 'Contoh (demo)', 'lainnya', 999900, 'IDR', 'monthly', 1, '2026-11-01', 2, 1, 1, 1, 0)`
			)
			.bind(`demo-x-${p.spaceId}`, p.spaceId)
			.run();
		const list = await listOf(p);
		expect(
			list.subscriptions.map((s) => [s.name, (s as unknown as { isDemo: boolean }).isDemo]).sort()
		).toEqual([
			['Contoh (demo)', true],
			['Nyata', false]
		]);
		expect(list.totals).toEqual([{ currency: 'IDR', totalMinor: real.amountMinor }]);
		const demo = list.subscriptions.find((s) => s.name === 'Contoh (demo)')!;
		const w = await wallet(p);
		const before = await count('select count(*) as n from transactions');
		expect(
			await act(p, 'markPaid', {
				subscriptionId: demo.id,
				updatedAt: String(demo.updatedAt),
				mode: 'new',
				walletId: w,
				categoryId: await category(p),
				occurredOn: wibTodayString()
			})
		).toEqual({ kind: 'fail', status: 400, data: { error: DEMO_NOT_PAYABLE } });
		expect(await count('select count(*) as n from transactions')).toBe(before);
		expect(await spacesWithSubscriptions(db, '', 1000)).toContain(p.spaceId);
	});
});

describe('totals per currency (AC7)', () => {
	it('never adds across currencies; yearly ÷ 12, weekly × 52 ÷ 12', async () => {
		const p = await person();
		await newSub(p, { name: 'A', amount: '120.000', cycle: 'yearly', month: '3', day: '1' });
		await newSub(p, { name: 'B', amount: '12.000', cycle: 'weekly', weekday: '5' });
		await newSub(p, { name: 'C', amount: '10', currency: 'USD' });
		expect((await listOf(p)).totals).toEqual([
			{ currency: 'IDR', totalMinor: 1_000_000 + 5_200_000 },
			{ currency: 'USD', totalMinor: 1000 }
		]);
	});
});

describe('one access rule (AC9)', () => {
	async function shared() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const s = await newSub(owner, { name: 'IndiHome', category: 'telko' }, spaceId);
		return { owner, member, spaceId, s };
	}

	it('a member sees and edits the shared space’s subscriptions', async () => {
		const { member, spaceId, s } = await shared();
		expect((await listOf(member, spaceId)).subscriptions.map((x) => x.id)).toEqual([s.id]);
		expect(
			await act(
				member,
				'updateSubscription',
				form({ subscriptionId: s.id, updatedAt: String(s.updatedAt), name: 'IndiHome 50' }),
				{ spaceCookie: spaceId }
			)
		).toMatchObject({ kind: 'ok' });
	});

	it('a non-member and a removed member get 404 on the load and every action; nothing changes', async () => {
		const { owner, member, spaceId, s } = await shared();
		const stranger = await person();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		const snapshot = async () =>
			JSON.stringify(
				(await d1.prepare('select * from subscriptions where space_id = ?').bind(spaceId).all())
					.results
			);
		const before = await snapshot();
		for (const who of [stranger, member]) {
			// A forged/stale current space (locals.space naming a space they are not in): requireSpaceAccess.
			expect(await run(async () => page.load(await ev(who, { space: spaceId })))).toEqual({
				kind: 'error',
				status: 404,
				body: { message: 'Not found', status: 404 }
			});
			const fields = { subscriptionId: s.id, updatedAt: String(s.updatedAt) };
			for (const [name, body] of [
				['createSubscription', form()],
				['updateSubscription', form(fields)],
				['deleteSubscription', fields],
				['markPaid', { ...fields, mode: 'link', transactionId: 'x' }]
			] as const)
				expect(await act(who, name, body, { space: spaceId })).toEqual({
					kind: 'error',
					status: 404,
					body: { message: 'Not found', status: 404 }
				});
			// In their own space, the shared space's id is simply unknown.
			for (const [name, body] of [
				['updateSubscription', form(fields)],
				['deleteSubscription', fields],
				['markPaid', { ...fields, mode: 'link', transactionId: 'x' }]
			] as const)
				expect(await act(who, name, body, { spaceCookie: spaceId })).toEqual({
					kind: 'fail',
					status: 404,
					data: { error: SUBSCRIPTION_NOT_FOUND }
				});
			expect((await listOf(who, spaceId)).subscriptions).toEqual([]);
		}
		expect(await snapshot()).toBe(before);
	});
});

describe('account deletion (AC11)', () => {
	it('purges the subscriptions of a space the user was the last member of; a shared space keeps its own', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Rumah', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const w = await wallet(owner);
		const personal = await newSub(owner, { name: 'Pribadi', walletId: w });
		await act(owner, 'markPaid', {
			subscriptionId: personal.id,
			updatedAt: String(personal.updatedAt),
			mode: 'link',
			transactionId: await expense(owner, w)
		});
		await newSub(owner, { name: 'Bersama' }, spaceId);
		const proof = await signInWithPassword(db, owner.user.email, PASSWORD, 1);
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, owner.user.id, proof.hash)).toBe(true);
		expect(
			await count('select count(*) as n from subscriptions where space_id = ?', owner.spaceId)
		).toBe(0);
		expect((await listOf(member, spaceId)).subscriptions.map((s) => s.name)).toEqual(['Bersama']);
	});
});

describe('FN-12 module toggle (AC8)', () => {
	it('hiding Langganan changes the nav only: the page still loads with its totals', async () => {
		const p = await person();
		await newSub(p);
		await setFeatureFlag(db, p.user.id, 'langganan', false, Date.now());
		const nav = await run(async () =>
			layout.load(fakeEvent({ url: 'http://localhost/langganan', db, user: p.user }).event as never)
		);
		expect(nav).toMatchObject({ kind: 'ok', value: { hiddenModules: ['langganan'] } });
		expect((await listOf(p)).totals).toEqual([{ currency: 'IDR', totalMinor: 18_600_000 }]);
	});
});

describe('bill reminders (FN-24 bill_reminder, AC6)', () => {
	const today = () => wibTodayString();
	/** A monthly bill charging tomorrow (WIB), so a 2-day reminder is due today. */
	const tomorrowDay = () => String(Number(addDays(today(), 1).slice(8)));
	const billRows = async (userId: string) =>
		(
			await d1
				.prepare(
					`select * from space_notifications where user_id = ? and kind = 'bill_reminder' order by created_at`
				)
				.bind(userId)
				.all<Record<string, unknown>>()
		).results;

	it('due bills of a space: within reminder_days_before of the next charge only', async () => {
		const p = await person();
		const s = await newSub(p, { name: 'Besok', day: tomorrowDay(), reminderDays: '2' });
		await newSub(p, { name: 'Nanti', day: String(Number(addDays(today(), 10).slice(8))) });
		expect(await dueBillReminders(db, p.spaceId, today())).toEqual([
			{
				subscriptionId: s.id,
				name: 'Besok',
				amountMinor: 18_600_000,
				currency: 'IDR',
				nextChargeOn: s.nextChargeOn,
				dataKey: billReminderDataKey(s.id, s.nextChargeOn)
			}
		]);
	});

	it('every live member gets one; a replayed tick creates nothing new; it renders in the reader’s language', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Rumah', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const s = await newSub(owner, { name: 'IndiHome', day: tomorrowDay() }, spaceId);
		const first = await evaluateBills(db, spaceId, Date.now());
		expect(first.map((r) => r.created)).toEqual([true, true]);
		const again = await evaluateBills(db, spaceId, Date.now() + 1000);
		expect(again.map((r) => r.created)).toEqual([false, false]);
		expect(new Set(again.map((r) => r.id))).toEqual(new Set(first.map((r) => r.id)));
		const [row] = await billRows(member.user.id);
		expect(row).toMatchObject({
			space_id: spaceId,
			data_key: billReminderDataKey(s.id, s.nextChargeOn)
		});
		expect(await billRows(owner.user.id)).toHaveLength(1);
		const params = parseParams('bill_reminder', row!.params as string);
		expect(params).toEqual({
			subscriptionId: s.id,
			name: 'IndiHome',
			currency: 'IDR',
			amountMinor: 18_600_000,
			chargeOn: s.nextChargeOn
		});
		const id = notificationText('bill_reminder', params, createTranslator('id'), 'Rumah');
		const en = notificationText('bill_reminder', params, createTranslator('en'), 'Rumah');
		expect(id.title).toBe('IndiHome segera ditagih');
		expect(en.title).toBe('IndiHome is due soon');
		expect(id.body).toBe(
			`${formatMoney(18_600_000, 'IDR')} pada ${formatShortDay(s.nextChargeOn, 'id')} · Rumah`
		);
		expect(notificationUrl('bill_reminder', params)).toBe('/langganan');
		// The list shows it to the member.
		expect((await listNotifications(db, member.user.id)).map((n) => n.kind)).toContain(
			'bill_reminder'
		);
	});

	it('a removed member gets nothing; preference off → nothing', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Kos', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		await newSub(owner, { name: 'Listrik', day: tomorrowDay() }, spaceId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		await setNotificationPref(db, owner.user.id, 'bill_reminder', false, Date.now());
		expect(await evaluateBills(db, spaceId, Date.now())).toEqual([]);
		expect(await billRows(member.user.id)).toEqual([]);
		expect(await billRows(owner.user.id)).toEqual([]);
		// Turned back on: the owner gets it on the next tick.
		await setNotificationPref(db, owner.user.id, 'bill_reminder', true, Date.now());
		expect((await evaluateBills(db, spaceId, Date.now())).map((r) => r.created)).toEqual([true]);
	});

	it('after "sudah dibayar" the next cycle is far away: nothing more until it comes near', async () => {
		const p = await person();
		const s = await newSub(p, { name: 'Besok', day: tomorrowDay() });
		expect(await evaluateBills(db, p.spaceId, Date.now())).toHaveLength(1);
		const w = await wallet(p);
		await act(p, 'markPaid', {
			subscriptionId: s.id,
			updatedAt: String(s.updatedAt),
			mode: 'link',
			transactionId: await expense(p, w)
		});
		expect(await dueBillReminders(db, p.spaceId, today())).toEqual([]);
		expect(await evaluateBills(db, p.spaceId, Date.now())).toEqual([]);
		expect(await billRows(p.user.id)).toHaveLength(1);
	});

	async function sharedPair(name: string) {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, name, Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		return { owner, member, spaceId };
	}

	it('L1: churning subscriptions cannot flood a member: at most 5 single reminders per WIB day, the rest grouped once', async () => {
		const { owner, member, spaceId } = await sharedPair('Banjir');
		let pushes = 0;
		for (let round = 0; round < 3; round++) {
			// Delete and recreate 8 bills (new ids → new keys), then a cron pass.
			const list = await listOf(owner, spaceId);
			for (const s of list.subscriptions)
				await act(
					owner,
					'deleteSubscription',
					{ subscriptionId: s.id, updatedAt: String(s.updatedAt) },
					{ spaceCookie: spaceId }
				);
			for (let i = 0; i < 8; i++)
				await newSub(owner, { name: `Churn ${round}-${i}`, day: tomorrowDay() }, spaceId);
			const made = await evaluateBills(db, spaceId, Date.now());
			pushes += made.filter((m) => m.created).length;
		}
		const live = (await billRows(member.user.id)).filter((r) => r.deleted_at === null);
		const all = await billRows(member.user.id);
		const singles = all.filter((r) => String(r.data_key).startsWith('bill:'));
		const grouped = all.filter((r) => String(r.data_key).startsWith('bills:'));
		expect(singles).toHaveLength(5);
		expect(grouped).toHaveLength(1);
		expect(parseParams('bill_reminder', grouped[0]!.params as string)).toEqual({
			count: 3,
			date: wibTodayString()
		});
		// Owner and member each: 5 singles + 1 group.
		expect(pushes).toBe(12);
		const text = notificationText(
			'bill_reminder',
			parseParams('bill_reminder', grouped[0]!.params as string),
			createTranslator('id'),
			'Banjir'
		);
		expect(text.title).toBe('3 tagihan langganan lagi segera jatuh tempo');
		expect(live.length).toBeGreaterThanOrEqual(1);
	});

	it('L2: deleting a subscription blanks its reminders for every member in the same batch', async () => {
		const { owner, member, spaceId } = await sharedPair('Hapus');
		const s = await newSub(owner, { name: 'Aplikasi X', day: tomorrowDay() }, spaceId);
		const keep = await newSub(owner, { name: 'Tetap', day: tomorrowDay() }, spaceId);
		await evaluateBills(db, spaceId, Date.now());
		expect(await billRows(member.user.id)).toHaveLength(2);
		await act(
			owner,
			'deleteSubscription',
			{ subscriptionId: s.id, updatedAt: String(s.updatedAt) },
			{ spaceCookie: spaceId }
		);
		for (const who of [owner, member]) {
			const rows = await billRows(who.user.id);
			const gone = rows.find((r) => r.data_key === billReminderDataKey(s.id, s.nextChargeOn))!;
			expect(gone).toMatchObject({ params: null, read_at: null });
			expect(gone.deleted_at).not.toBeNull();
			const kept = rows.find(
				(r) => r.data_key === billReminderDataKey(keep.id, keep.nextChargeOn)
			)!;
			expect(kept.deleted_at).toBeNull();
			expect(JSON.stringify(await listNotifications(db, who.user.id))).not.toContain('Aplikasi X');
		}
		// The key stays: a replayed tick never brings it back.
		await evaluateBills(db, spaceId, Date.now());
		expect(
			(await billRows(member.user.id)).filter(
				(r) => r.data_key === billReminderDataKey(s.id, s.nextChargeOn)
			)
		).toHaveLength(1);
	});

	it('the cron walks only live spaces with a live subscription', async () => {
		const p = await person();
		const empty = await person();
		const s = await newSub(p);
		const ids = await spacesWithSubscriptions(db, '', 1000);
		expect(ids).toContain(p.spaceId);
		expect(ids).not.toContain(empty.spaceId);
		await act(p, 'deleteSubscription', { subscriptionId: s.id, updatedAt: String(s.updatedAt) });
		expect(await spacesWithSubscriptions(db, '', 1000)).not.toContain(p.spaceId);
	});
});

describe('FN-47: subscriptions in TWD with cents', () => {
	it('149,50 TWD persists with the bare TWD code; a third fraction digit is refused', async () => {
		const p = await person();
		const s = await newSub(p, { name: 'Spotify TW', currency: 'TWD', amount: '149,50' });
		expect(s).toMatchObject({ amountMinor: 14_950, currency: 'TWD' });
		const r = await act(
			p,
			'createSubscription',
			form({ name: 'X', currency: 'TWD', amount: '149,505' })
		);
		expect(r).toMatchObject({ kind: 'fail', status: 400 });
		expect((await listOf(p)).subscriptions.map((x) => x.name)).toEqual(['Spotify TW']);
	});
});
