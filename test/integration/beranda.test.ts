import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import {
	BUDGET_AMOUNT_INVALID,
	BUDGET_CHANGED,
	BUDGET_CURRENCY_INVALID,
	BUDGET_TOO_LARGE
} from '#lib/server/budgets/messages';
import { deleteBudget, getActiveBudget, setBudget } from '#lib/server/budgets/repo';
import {
	berandaSummary,
	billsDueWithin,
	UPCOMING_DAYS,
	UPCOMING_ROWS
} from '#lib/server/budgets/summary';
import { createSubscription, type SubscriptionSummary } from '#lib/server/subscriptions/repo';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import {
	createSharedSpace,
	listMembers,
	purgeSpaces,
	removeMember
} from '#lib/server/spaces/spaces';
import { createTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { addDays, wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const beranda = await import('../../src/routes/(app)/+page.server');
const riwayat = await import('../../src/routes/(app)/riwayat/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

type Handler = (event: never) => unknown;

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
	const email = `beranda${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const scope: SpaceScope = { spaceId: personal, userId: r.userId };
	return { user: { id: r.userId, email, name, createdAt: 0 }, scope };
}
type Person = Awaited<ReturnType<typeof person>>;

async function ev(
	who: Person | null,
	opts: {
		form?: Record<string, string>;
		url?: string;
		space?: string;
		headers?: Record<string, string>;
	}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.space) : null;
	return fakeEvent({
		url: `http://localhost${opts.url ?? '/'}`,
		routeId: '/(app)',
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		headers: opts.headers
	}).event as never;
}

type Summary = NonNullable<Awaited<ReturnType<typeof berandaSummary>>>;

async function load(who: Person | null, space?: string, url = '/') {
	return run(async () => beranda.load(await ev(who, { space, url })));
}
async function summaryOf(who: Person, space?: string): Promise<Summary> {
	const r = await load(who, space);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.summary as Summary;
}
const action = async (
	who: Person,
	name: 'setBudget' | 'deleteBudget',
	form: Record<string, string>,
	space?: string
) =>
	run(async () =>
		(beranda.actions as Record<string, Handler>)[name]!(await ev(who, { form, space }))
	);

const liveBudgets = async (spaceId: string) =>
	(await d1
		.prepare('select count(*) as n from budgets where space_id = ? and deleted_at is null')
		.bind(spaceId)
		.first<{ n: number }>())!.n;
const allBudgets = async (spaceId: string) =>
	(await d1
		.prepare('select count(*) as n from budgets where space_id = ?')
		.bind(spaceId)
		.first<{ n: number }>())!.n;

/** A ledger in `scope`: presets, an IDR wallet (favourite) and a USD wallet. */
async function ledger(scope: SpaceScope) {
	await ensurePresetCategories(db, scope.spaceId, NOW);
	const cats = await listCategories(db, scope.spaceId);
	const wallet = async (name: string, currency: 'IDR' | 'USD' | 'CNY') => {
		const r = await createWallet(
			db,
			scope,
			{ name, type: 'bank', currency, openingBalanceMinor: 0, isFavourite: false, lastFour: null },
			NOW
		);
		if (!r.ok) throw new Error('wallet failed');
		return r.id;
	};
	const bca = await wallet('BCA', 'IDR');
	const gopay = await wallet('GoPay', 'IDR');
	const wise = await wallet('Wise', 'USD');
	const tx = async (over: Partial<TransactionInput>) => {
		const r = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor: 2_500_000,
				currency: 'IDR',
				walletId: bca,
				transferToWalletId: null,
				categoryId: cats.find((c) => c.tileKey === 'kopi')!.id,
				title: 'Kopi',
				note: null,
				occurredOn: wibTodayString(),
				occurredTime: null,
				...over
			},
			NOW
		);
		if (!r.ok) throw new Error('tx failed');
		return r.id;
	};
	const cat = (tile: string) => cats.find((c) => c.tileKey === tile)!.id;
	return { bca, gopay, wise, tx, cat, wallet };
}

describe('Beranda load', () => {
	it('sends a signed-out visitor to /masuk', async () => {
		expect(await load(null)).toMatchObject({ kind: 'redirect', status: 303, location: '/masuk' });
	});

	it('an empty space shows Rp 0, no budget, no today list (honest zero, not hidden)', async () => {
		const p = await person();
		const s = await summaryOf(p);
		expect(s).toMatchObject({
			currency: 'IDR',
			spentMinor: 0,
			budget: null,
			safeToSpend: null,
			todayGroup: null,
			categories: [],
			diffMinor: 0,
			avgPerDayMinor: 0
		});
		expect(s.bars).toHaveLength(14);
	});

	it('counts the space’s wallets: none shows the first-wallet card, a deleted one is not counted', async () => {
		const p = await person();
		expect((await summaryOf(p)).walletCount).toBe(0);
		await ledger(p.scope);
		const count = (await summaryOf(p)).walletCount;
		expect(count).toBeGreaterThan(0);
		await d1
			.prepare(
				'update wallets set deleted_at = 1 where space_id = ? and id = (select min(id) from wallets where space_id = ?)'
			)
			.bind(p.scope.spaceId, p.scope.spaceId)
			.run();
		expect((await summaryOf(p)).walletCount).toBe(count - 1);
	});

	it('the hero currency is the favourite wallet’s', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await d1
			.prepare('update wallets set is_favourite = (id = ?) where space_id = ?')
			.bind(l.wise, p.scope.spaceId)
			.run();
		await l.tx({ walletId: l.wise, currency: 'USD', amountMinor: 1_250 });
		await l.tx({});
		const s = await summaryOf(p);
		expect(s.currency).toBe('USD');
		expect(s.spentMinor).toBe(1_250);
		expect(s.otherCurrencies).toEqual([{ currency: 'IDR', outMinor: 2_500_000 }]);
	});
});

describe('FN-47: a CNY spend is its own chip, never summed into rupiah', () => {
	it('IDR and CNY in one month: the hero shows IDR only, CNY as an other-currency chip', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await d1
			.prepare('update wallets set is_favourite = (id = ?) where space_id = ?')
			.bind(l.bca, p.scope.spaceId)
			.run();
		const alipay = await l.wallet('Alipay', 'CNY');
		await l.tx({});
		await l.tx({ walletId: alipay, currency: 'CNY', amountMinor: 8_880 });
		const s = await summaryOf(p);
		expect(s.currency).toBe('IDR');
		expect(s.spentMinor).toBe(2_500_000);
		expect(s.otherCurrencies).toEqual([{ currency: 'CNY', outMinor: 8_880 }]);
	});
});

describe('Beranda totals equal Riwayat totals for the same filter (pre-handoff probe)', () => {
	it('month total, today’s totals and today’s rows match Riwayat; transfers and income never count', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const today = wibTodayString();
		await l.tx({ amountMinor: 2_500_000 });
		await l.tx({ amountMinor: 7_300_000, categoryId: l.cat('makan') });
		await l.tx({ type: 'income', amountMinor: 900_000_000, categoryId: l.cat('gaji') });
		await l.tx({
			type: 'transfer',
			amountMinor: 50_000_000,
			categoryId: null,
			transferToWalletId: l.gopay
		});
		await l.tx({ walletId: l.wise, currency: 'USD', amountMinor: 999 });
		const s = await summaryOf(p);

		const month = await run(async () =>
			riwayat.load(await ev(p, { url: '/riwayat?type=expense' }))
		);
		const monthTotals = (
			month as unknown as {
				value: { totals: { totals: { currency: string; outMinor: number }[] } };
			}
		).value.totals.totals;
		expect(s.spentMinor).toBe(monthTotals.find((t) => t.currency === 'IDR')!.outMinor);
		expect(s.spentMinor).toBe(9_800_000);

		const day = await run(async () =>
			riwayat.load(await ev(p, { url: `/riwayat?period=range&from=${today}&to=${today}` }))
		);
		const riwayatDay = (
			day as unknown as {
				value: { page: { days: { date: string; totals: unknown; rows: { id: string }[] }[] } };
			}
		).value.page.days[0]!;
		expect(s.todayGroup!.totals).toEqual(riwayatDay.totals);
		expect(s.todayGroup!.rows.map((r) => r.id)).toEqual(riwayatDay.rows.map((r) => r.id));
		// The day header's money out equals the sum of the listed expense rows.
		const listedOut = s
			.todayGroup!.rows.filter((r) => r.type === 'expense' && r.currency === 'IDR' && !r.isDemo)
			.reduce((sum, r) => sum + r.amountMinor, 0);
		expect(s.todayGroup!.totals.find((t) => t.currency === 'IDR')!.outMinor).toBe(listedOut);
		// Charts come from the same sums.
		expect(s.bars.at(-1)!.minor).toBe(9_800_000);
		expect(s.categories.reduce((sum, c) => sum + c.minor!, 0)).toBe(9_800_000);
	});

	it('demo rows are listed with their badge but never counted in any Beranda figure', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const today = wibTodayString();
		await l.tx({ amountMinor: 2_500_000 });
		await setBudget(db, p.scope, { amountMinor: 10_000_000, currency: 'IDR' }, null, NOW);
		const before = await berandaSummary(db, p.scope.spaceId, today);
		const demo = await l.tx({ amountMinor: 7_000_000, categoryId: l.cat('makan') });
		await d1.prepare('update transactions set is_demo = 1 where id = ?').bind(demo).run();
		const after = await berandaSummary(db, p.scope.spaceId, today);
		expect(after.spentMinor).toBe(2_500_000);
		expect(after.safeToSpend).toEqual(before.safeToSpend);
		expect(after.diffMinor).toBe(before.diffMinor);
		expect(after.bars).toEqual(before.bars);
		expect(after.categories).toEqual(before.categories);
		expect(after.lines).toEqual(before.lines);
		expect(after.todayGroup!.totals).toEqual(before.todayGroup!.totals);
		expect(after.todayGroup!.rows.find((r) => r.id === demo)?.isDemo).toBe(true);
	});
});

describe('WIB month boundaries (pre-handoff probe)', () => {
	it('at 23:30 WIB on the 31st, a row from 00:30 WIB on the 1st (same UTC date) is next month', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		// 23:30 WIB 31 Oct = 16:30 UTC 31 Oct; 00:30 WIB 1 Nov = 17:30 UTC 31 Oct (same UTC date).
		await l.tx({ occurredOn: '2026-10-31', occurredTime: '23:30', amountMinor: 1_000_000 });
		await l.tx({ occurredOn: '2026-11-01', occurredTime: '00:30', amountMinor: 7_000_000 });
		await setBudget(db, p.scope, { amountMinor: 5_000_000, currency: 'IDR' }, null, NOW);

		const oct = await berandaSummary(
			db,
			p.scope.spaceId,
			wibTodayString(Date.parse('2026-10-31T16:30:00Z'))
		);
		expect(oct.today).toBe('2026-10-31');
		expect(oct.dayOfMonth).toBe(31);
		expect(oct.spentMinor).toBe(1_000_000);
		expect(oct.safeToSpend).toEqual({
			kind: 'left',
			remainingMinor: 4_000_000,
			perDayMinor: 4_000_000,
			days: 1
		});

		const nov = await berandaSummary(
			db,
			p.scope.spaceId,
			wibTodayString(Date.parse('2026-10-31T17:30:00Z'))
		);
		expect(nov.today).toBe('2026-11-01');
		expect(nov.dayOfMonth).toBe(1);
		expect(nov.spentMinor).toBe(7_000_000);
		expect(nov.safeToSpend).toEqual({ kind: 'over', overMinor: 2_000_000 });
		// The 1st compares with 1 October only.
		expect(nov.diffMinor).toBe(7_000_000);
		expect(nov.todayGroup!.rows).toHaveLength(1);
	});

	it('the 31st compares with all of a 30-day month', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ occurredOn: '2026-09-30', amountMinor: 3_000_000 });
		await l.tx({ occurredOn: '2026-08-31', amountMinor: 99_000_000 }); // two months back: never compared
		await l.tx({ occurredOn: '2026-10-31', amountMinor: 10_000_000 });
		const s = await berandaSummary(db, p.scope.spaceId, '2026-10-31');
		expect(s.diffMinor).toBe(10_000_000 - 3_000_000);
		expect(s.avgPerDayMinor).toBe(Math.floor(10_000_000 / 31));
		expect(s.lines.lastMonth).toHaveLength(30);
		expect(s.lines.lastMonth.at(-1)).toBe(3_000_000);
	});
});

describe('budget actions', () => {
	const budgetOf = async (p: Person) => (await summaryOf(p)).budget;

	it('set → persists across a reload, shows safe-to-spend; edit; delete returns to no budget', async () => {
		const p = await person();
		expect(
			await action(p, 'setBudget', { amount: '3.000.000', currency: 'IDR', updatedAt: '' })
		).toEqual({
			kind: 'ok',
			value: { saved: 'set' }
		});
		const first = (await budgetOf(p))!;
		expect(first).toMatchObject({ amountMinor: 300_000_000, currency: 'IDR' });
		const s = await summaryOf(p);
		expect(s.safeToSpend?.kind).toBe('left');

		expect(
			await action(p, 'setBudget', {
				amount: '4.000.000',
				currency: 'IDR',
				updatedAt: String(first.updatedAt)
			})
		).toMatchObject({ kind: 'ok' });
		const second = (await budgetOf(p))!;
		expect(second.amountMinor).toBe(400_000_000);
		expect(second.updatedAt).toBeGreaterThan(first.updatedAt);

		const seqBefore = (await d1
			.prepare('select seq from budgets where space_id = ?')
			.bind(p.scope.spaceId)
			.first<{ seq: number }>())!.seq;
		expect(await action(p, 'deleteBudget', { updatedAt: String(second.updatedAt) })).toEqual({
			kind: 'ok',
			value: { saved: 'deleted' }
		});
		expect(await budgetOf(p)).toBeNull();
		expect((await summaryOf(p)).safeToSpend).toBeNull();
		const tomb = (await d1
			.prepare('select amount_minor, deleted_at, seq from budgets where space_id = ?')
			.bind(p.scope.spaceId)
			.first<{ amount_minor: number; deleted_at: number | null; seq: number }>())!;
		expect(tomb.amount_minor).toBe(0); // content-free tombstone
		expect(tomb.deleted_at).not.toBeNull();
		expect(tomb.seq).toBeGreaterThan(seqBefore);

		// Reversible: a new budget can be set again.
		expect(
			await action(p, 'setBudget', { amount: '1.000.000', currency: 'IDR', updatedAt: '' })
		).toMatchObject({ kind: 'ok' });
		expect(await liveBudgets(p.scope.spaceId)).toBe(1);
	});

	it.each([
		['blank', ''],
		['zero', '0'],
		['negative', '-1.000'],
		['14 digits', '12345678901234']
	])('refuses a %s amount with a field error and writes nothing', async (_, amount) => {
		const p = await person();
		expect(await action(p, 'setBudget', { amount, currency: 'IDR', updatedAt: '' })).toEqual({
			kind: 'fail',
			status: 400,
			// FN-47 follow-up: the typed text is echoed, so the no-JS form never re-shows the stored budget.
			data: { action: 'setBudget', error: BUDGET_AMOUNT_INVALID, typed: amount }
		});
		expect(await allBudgets(p.scope.spaceId)).toBe(0);
	});

	it('refuses an unknown currency', async () => {
		const p = await person();
		expect(await action(p, 'setBudget', { amount: '100', currency: 'XAU' })).toMatchObject({
			status: 400,
			data: { error: BUDGET_CURRENCY_INVALID }
		});
	});

	it('L2: the shared whole-amount contract and the 10^13 transaction cap', async () => {
		const p = await person();
		expect(
			await action(p, 'setBudget', { amount: '1 200', currency: 'IDR', updatedAt: '' })
		).toMatchObject({ status: 400, data: { error: BUDGET_AMOUNT_INVALID } });
		expect(
			await action(p, 'setBudget', { amount: '100.000.000.001', currency: 'IDR', updatedAt: '' })
		).toMatchObject({ status: 400, data: { error: BUDGET_TOO_LARGE } });
		expect(await allBudgets(p.scope.spaceId)).toBe(0);
		expect(
			await action(p, 'setBudget', { amount: '100.000.000.000', currency: 'IDR', updatedAt: '' })
		).toMatchObject({ kind: 'ok' });
		expect((await budgetOf(p))!.amountMinor).toBe(10_000_000_000_000);
	});

	it('L3: the currency must be a live wallet’s (IDR without wallets), never just what the form says', async () => {
		const p = await person();
		// No wallets: IDR only.
		expect(
			await action(p, 'setBudget', { amount: '100', currency: 'JPY', updatedAt: '' })
		).toMatchObject({ status: 400, data: { error: BUDGET_CURRENCY_INVALID } });
		const l = await ledger(p.scope); // BCA, GoPay (IDR) and Wise (USD)
		expect(
			await action(p, 'setBudget', { amount: '100', currency: 'JPY', updatedAt: '' })
		).toMatchObject({ status: 400, data: { error: BUDGET_CURRENCY_INVALID } });
		expect(await allBudgets(p.scope.spaceId)).toBe(0);
		expect(
			await action(p, 'setBudget', { amount: '100', currency: 'USD', updatedAt: '' })
		).toMatchObject({ kind: 'ok' });
		// The budget's own currency stays accepted after its last wallet is archived (edit the amount only).
		await d1.prepare('update wallets set deleted_at = 1 where id = ?').bind(l.wise).run();
		const b = (await budgetOf(p))!;
		expect(
			await action(p, 'setBudget', {
				amount: '200',
				currency: 'USD',
				updatedAt: String(b.updatedAt)
			})
		).toMatchObject({ kind: 'ok' });
		expect((await budgetOf(p))!).toMatchObject({ amountMinor: 20_000, currency: 'USD' });
	});

	it('L1: set → delete churn keeps one row per space (the tombstone is revived, never piled up)', async () => {
		const p = await person();
		for (let i = 1; i <= 5; i++) {
			expect(
				await action(p, 'setBudget', { amount: String(i * 1_000), currency: 'IDR', updatedAt: '' })
			).toMatchObject({ kind: 'ok' });
			const b = (await budgetOf(p))!;
			expect(b.amountMinor).toBe(i * 100_000);
			expect(await action(p, 'deleteBudget', { updatedAt: String(b.updatedAt) })).toMatchObject({
				kind: 'ok'
			});
			expect(await allBudgets(p.scope.spaceId)).toBe(1);
		}
		expect(await budgetOf(p)).toBeNull();
		// A revived row is newer than its tombstone and carries a fresh seq.
		const before = (await d1
			.prepare('select updated_at as u, seq from budgets where space_id = ?')
			.bind(p.scope.spaceId)
			.first<{ u: number; seq: number }>())!;
		await action(p, 'setBudget', { amount: '7.000', currency: 'IDR', updatedAt: '' });
		const after = (await d1
			.prepare('select updated_at as u, seq, deleted_at from budgets where space_id = ?')
			.bind(p.scope.spaceId)
			.first<{ u: number; seq: number; deleted_at: number | null }>())!;
		expect(after.deleted_at).toBeNull();
		expect(after.u).toBeGreaterThan(before.u);
		expect(after.seq).toBeGreaterThan(before.seq);
		expect(await allBudgets(p.scope.spaceId)).toBe(1);
	});

	it('two tabs with the same stale form: the second is refused, never an overwrite', async () => {
		const p = await person();
		await action(p, 'setBudget', { amount: '1.000.000', currency: 'IDR', updatedAt: '' });
		const loaded = String((await budgetOf(p))!.updatedAt);
		expect(
			await action(p, 'setBudget', { amount: '2.000.000', currency: 'IDR', updatedAt: loaded })
		).toMatchObject({ kind: 'ok' });
		expect(
			await action(p, 'setBudget', { amount: '9.000.000', currency: 'IDR', updatedAt: loaded })
		).toEqual({ kind: 'fail', status: 409, data: { error: BUDGET_CHANGED } });
		expect(await action(p, 'deleteBudget', { updatedAt: loaded })).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: BUDGET_CHANGED }
		});
		expect((await budgetOf(p))!.amountMinor).toBe(200_000_000);
		// A second "create" form while a budget already exists is also stale.
		expect(
			await action(p, 'setBudget', { amount: '5.000.000', currency: 'IDR', updatedAt: '' })
		).toMatchObject({ status: 409 });
		// Delete without a loaded budget: nothing to remove.
		expect(await action(p, 'deleteBudget', {})).toMatchObject({ status: 409 });
	});

	it('20 concurrent first budgets: exactly one live row, the rest refused cleanly', async () => {
		const p = await person();
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				action(p, 'setBudget', { amount: String(1_000 + i), currency: 'IDR', updatedAt: '' })
			)
		);
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
		expect(results.filter((r) => r.kind === 'fail' && r.status === 409)).toHaveLength(19);
		expect(await liveBudgets(p.scope.spaceId)).toBe(1);
		expect(await allBudgets(p.scope.spaceId)).toBe(1);
	});

	it('20 concurrent edits from the same loaded form: exactly one wins', async () => {
		const p = await person();
		await action(p, 'setBudget', { amount: '1.000', currency: 'IDR', updatedAt: '' });
		const loaded = String((await budgetOf(p))!.updatedAt);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				action(p, 'setBudget', { amount: String(2_000 + i), currency: 'IDR', updatedAt: loaded })
			)
		);
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
		expect(await liveBudgets(p.scope.spaceId)).toBe(1);
	});

	it('a malformed or oversized body is 415/400, never a 500', async () => {
		const p = await person();
		const bad = await run(async () =>
			(beranda.actions as Record<string, Handler>).setBudget!(
				fakeEvent({
					url: 'http://localhost/',
					db,
					user: p.user,
					space: await resolveCurrentSpace(db, p.user.id, undefined),
					method: 'POST',
					headers: { 'content-type': 'text/plain' }
				}).event as never
			)
		);
		expect(bad).toMatchObject({ kind: 'error', status: 415 });
		const big = await action(p, 'setBudget', { amount: '1'.repeat(9_000), currency: 'IDR' });
		expect(big).toMatchObject({ kind: 'error', status: 400 });
	});
});

describe('one access rule across spaces (pre-handoff cross-space probe)', () => {
	async function shared() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		await action(
			owner,
			'setBudget',
			{ amount: '2.000.000', currency: 'IDR', updatedAt: '' },
			spaceId
		);
		const budget = (await getActiveBudget(db, spaceId))!;
		return { owner, member, spaceId, budget };
	}

	it('a member sees and edits the shared space’s budget', async () => {
		const { member, spaceId, budget } = await shared();
		expect((await summaryOf(member, spaceId)).budget).toMatchObject({ amountMinor: 200_000_000 });
		expect(
			await action(
				member,
				'setBudget',
				{ amount: '2.500.000', currency: 'IDR', updatedAt: String(budget.updatedAt) },
				spaceId
			)
		).toMatchObject({ kind: 'ok' });
	});

	it('a non-member naming the space (cookie) only ever reaches their own personal space', async () => {
		const { spaceId, budget } = await shared();
		const stranger = await person('Orang lain');
		expect((await summaryOf(stranger, spaceId)).budget).toBeNull();
		expect(
			await action(stranger, 'deleteBudget', { updatedAt: String(budget.updatedAt) }, spaceId)
		).toMatchObject({ status: 409 });
		await action(stranger, 'setBudget', { amount: '1', currency: 'IDR', updatedAt: '' }, spaceId);
		expect(await getActiveBudget(db, spaceId)).toEqual(budget);
		expect(await liveBudgets(stranger.scope.spaceId)).toBe(1);
		// The repo refuses a scope whose user is not a member (the write repeats the membership): 'gone' → 404, the same answer as a non-member everywhere.
		expect(
			await setBudget(
				db,
				{ spaceId, userId: stranger.user.id },
				{ amountMinor: 1, currency: 'IDR' },
				budget.updatedAt,
				NOW
			)
		).toBe('gone');
		expect(
			await deleteBudget(db, { spaceId, userId: stranger.user.id }, budget.updatedAt, NOW)
		).toBe('gone');
		expect(await getActiveBudget(db, spaceId)).toEqual(budget);
	});

	it('a removed member loses the shared budget at once', async () => {
		const { owner, member, spaceId, budget } = await shared();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		expect((await summaryOf(member, spaceId)).budget).toBeNull();
		expect(
			await action(member, 'deleteBudget', { updatedAt: String(budget.updatedAt) }, spaceId)
		).toMatchObject({ status: 409 });
		expect(await deleteBudget(db, { spaceId, userId: member.user.id }, budget.updatedAt, NOW)).toBe(
			'gone'
		);
		expect(
			await setBudget(
				db,
				{ spaceId, userId: member.user.id },
				{ amountMinor: 1, currency: 'IDR' },
				null,
				NOW
			)
		).toBe('gone');
		expect(await getActiveBudget(db, spaceId)).toEqual(budget);
	});
});

describe('totals past 2^53 (exact TEXT + BigInt sums, "too large" state)', () => {
	/** `count` live IDR expense rows of 10^13 on `date` (one statement, past the form's per-row cap check). */
	async function bulk(
		spaceId: string,
		walletId: string,
		categoryId: string,
		count: number,
		date: string
	) {
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					occurred_on, occurred_at, created_at, updated_at, seq)
				select lower(hex(randomblob(16))), ?, 'expense', 10000000000000, 'IDR', ?, ?, ?, 0, 0, 0, 1 from n`
			)
			.bind(count, spaceId, categoryId, walletId, date)
			.run();
	}

	it('one huge day: the page still loads; every figure built on it is null, never rounded or thrown', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await setBudget(db, p.scope, { amountMinor: 100_000_000, currency: 'IDR' }, null, NOW);
		await bulk(p.scope.spaceId, l.bca, l.cat('kopi'), 1000, wibTodayString()); // 10^16
		const r = await load(p);
		expect(r).toMatchObject({ kind: 'ok', value: { loadError: null } });
		const s = (r as unknown as { value: { summary: Summary } }).value.summary;
		expect(s.spentMinor).toBeNull();
		expect(s.diffMinor).toBeNull();
		expect(s.avgPerDayMinor).toBeNull();
		expect(s.safeToSpend).toEqual({ kind: 'over', overMinor: null });
		expect(s.bars.at(-1)!.minor).toBeNull();
		expect(s.categories[0]!.minor).toBeNull();
		expect(s.lines.thisMonth.at(-1)).toBeNull();
		expect(s.todayGroup!.totals[0]!.outMinor).toBeNull();
		expect(s.todayGroup!.rows).toHaveLength(50);
	});

	it('days that are each safe but sum past 2^53: bars stay exact, month figures turn null', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		// 600 × 10^13 = 6·10^15 per day (safe); two days = 1.2·10^16 (past 2^53 ≈ 9.007·10^15).
		await bulk(p.scope.spaceId, l.bca, l.cat('kopi'), 600, '2026-10-07');
		await bulk(p.scope.spaceId, l.bca, l.cat('makan'), 600, '2026-10-08');
		const s = await berandaSummary(db, p.scope.spaceId, '2026-10-08');
		expect(s.bars.at(-2)!.minor).toBe(6_000_000_000_000_000);
		expect(s.bars.at(-1)!.minor).toBe(6_000_000_000_000_000);
		expect(s.spentMinor).toBeNull();
		expect(s.diffMinor).toBeNull();
		expect(s.avgPerDayMinor).toBeNull();
		expect(s.lines.thisMonth).toHaveLength(8);
		expect(s.lines.thisMonth[6]).toBe(6_000_000_000_000_000);
		expect(s.lines.thisMonth[7]).toBeNull();
		expect(s.categories.map((c) => c.minor)).toEqual([
			6_000_000_000_000_000, 6_000_000_000_000_000
		]);
	});
});

describe('space deletion removes budgets', () => {
	it('purgeSpaces deletes the space’s budget rows (tombstones included) and nothing of another space', async () => {
		const p = await person();
		const other = await person();
		await setBudget(db, p.scope, { amountMinor: 100, currency: 'IDR' }, null, NOW);
		const b = (await getActiveBudget(db, p.scope.spaceId))!;
		await deleteBudget(db, p.scope, b.updatedAt, NOW + 1);
		await setBudget(db, other.scope, { amountMinor: 300, currency: 'IDR' }, null, NOW);
		expect(await allBudgets(p.scope.spaceId)).toBe(1); // the tombstone
		expect(await liveBudgets(p.scope.spaceId)).toBe(0);
		await db.batch(purgeSpaces(db, sql`select ${p.scope.spaceId}`, () => sql`1`) as never);
		expect(await allBudgets(p.scope.spaceId)).toBe(0);
		expect(await allBudgets(other.scope.spaceId)).toBe(1);
	});

	it('account deletion deletes the personal space’s budget with it', async () => {
		const p = await person();
		await setBudget(db, p.scope, { amountMinor: 100, currency: 'IDR' }, null, NOW);
		const proof = await signInWithPassword(db, p.user.email, PASSWORD, NOW);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, p.user.id, proof.hash, NOW)).toBe(true);
		expect(await allBudgets(p.scope.spaceId)).toBe(0);
	});
});

describe('Terbaru and Akan datang (APP_PARITY wave A)', () => {
	type Lists = {
		recent: { id: string; title: string | null }[];
		upcoming: { name: string; inDays: number }[];
	};
	async function listsOf(who: Person, space?: string): Promise<Lists> {
		const r = await load(who, space);
		if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
		return r.value.lists as Lists;
	}
	const isoWeekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
	async function bill(scope: SpaceScope, name: string, inDays: number) {
		const today = wibTodayString();
		const r = await createSubscription(
			db,
			scope,
			{
				catalogueId: null,
				name,
				category: 'streaming',
				amountMinor: 5_499_000,
				currency: 'IDR',
				schedule: { cycle: 'weekly', day: isoWeekday(addDays(today, inDays)), month: null },
				walletId: null,
				reminderDaysBefore: 1
			},
			today,
			NOW
		);
		if (!r.ok) throw new Error('subscription failed');
	}

	it('Terbaru: the newest three rows of the space, the order Riwayat shows', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const today = wibTodayString();
		await l.tx({ title: 'Lama', occurredOn: addDays(today, -40) });
		await l.tx({ title: 'Kemarin', occurredOn: addDays(today, -1) });
		await l.tx({ title: 'Pagi', occurredOn: today, occurredTime: '07:00' });
		await l.tx({ title: 'Siang', occurredOn: today, occurredTime: '12:00' });
		expect((await listsOf(p)).recent.map((r) => r.title)).toEqual(['Siang', 'Pagi', 'Kemarin']);
	});

	it('Akan datang: bills charging within 7 days, soonest first; none further out', async () => {
		const p = await person();
		await bill(p.scope, 'Musik', 3);
		await bill(p.scope, 'Video', 0);
		const lists = await listsOf(p);
		expect(lists.upcoming.map((b) => [b.name, b.inDays])).toEqual([
			['Video', 0],
			['Musik', 3]
		]);
		expect((await listsOf(await person())).upcoming).toEqual([]);
	});

	it('never shows another space’s rows or bills (cross-space probe)', async () => {
		const owner = await person('Pemilik');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const sharedScope = { spaceId, userId: owner.user.id };
		const l = await ledger(sharedScope);
		await l.tx({ title: 'Belanja bersama' });
		await bill(sharedScope, 'Langganan bersama', 1);
		// The owner's personal space does not see the shared rows…
		expect(await listsOf(owner)).toEqual({ recent: [], upcoming: [] });
		// …a stranger naming the shared space (cookie) reaches only their own personal space…
		expect(await listsOf(await person('Orang lain'), spaceId)).toEqual({
			recent: [],
			upcoming: []
		});
		// …and the owner in the shared space sees them.
		const inShared = await listsOf(owner, spaceId);
		expect(inShared.recent.map((r) => r.title)).toEqual(['Belanja bersama']);
		expect(inShared.upcoming.map((b) => b.name)).toEqual(['Langganan bersama']);
	});

	it('billsDueWithin: window edges, past dates and the row cap', () => {
		const sub = (id: string, nextChargeOn: string) =>
			({
				id,
				name: id,
				amountMinor: 1,
				currency: 'IDR',
				nextChargeOn,
				isDemo: false
			}) as SubscriptionSummary;
		const today = '2026-10-31';
		const due = billsDueWithin(
			[
				sub('d', '2026-11-07'),
				sub('a', '2026-10-31'),
				sub('past', '2026-10-30'),
				sub('c', '2026-11-06'),
				sub('b', '2026-11-01')
			],
			today,
			UPCOMING_DAYS,
			10
		);
		expect(due.map((b) => [b.id, b.inDays])).toEqual([
			['a', 0],
			['b', 1],
			['c', 6]
		]);
		expect(
			billsDueWithin(
				['1', '2', '3', '4'].map((id) => sub(id, today)),
				today,
				UPCOMING_DAYS,
				UPCOMING_ROWS
			)
		).toHaveLength(3);
	});
});
