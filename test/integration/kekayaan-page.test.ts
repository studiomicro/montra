import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import type { CreditCardSpend } from '#lib/server/net-worth/credit-cards';
import { createNetWorthItem } from '#lib/server/net-worth/repo';
import { upsertSnapshot } from '#lib/server/net-worth/summary';
import { netWorthTrend, TREND_MAX_POINTS } from '#lib/server/net-worth/trend';
import type { NetWorthInput } from '#lib/server/net-worth/validation';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { periodTotals, walletExpenseTotals } from '#lib/server/transactions/aggregate';
import { createTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { addDays, wibTodayString } from '#lib/shared/dates';
import type { WalletType } from '#lib/shared/wallets';
import type { Allocation } from '#lib/shared/wealth';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { fakeKv } from '../helpers/kv';

/**
 * FN-25b: /kekayaan's load end to end on local D1 — the trend read from stored snapshots, the allocation split,
 * the grouped subtotals and the credit cards' 30-day spend — across two users and two spaces.
 */
const binding: { DB?: D1Database; CACHE?: KVNamespace } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/kekayaan/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.now();

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
	binding.CACHE = fakeKv() as unknown as KVNamespace;
});
afterAll(() => dispose());

async function run(fn: () => unknown) {
	try {
		return { kind: 'ok' as const, value: (await fn()) as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

let n = 0;
async function person(name = 'Uji') {
	const email = `kekayaan-halaman${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const scope: SpaceScope = { spaceId: personal, userId: r.userId };
	return { user: { id: r.userId, email, name, createdAt: 0 }, scope };
}
type Person = Awaited<ReturnType<typeof person>>;

interface PageData {
	netWorth: {
		summary: { totalMinor: number | null; classes: { cls: string; minor: number | null }[] } | null;
		wallets: { id: string; balanceMinor: number | null }[];
		allocation: Allocation | null;
		sections: Record<string, { currency: string; totalMinor: number | null }[]> | null;
	};
	trend: { range: string; points: { date: string; totalMinor: number; partial: boolean }[] };
	creditCards: { cards: CreditCardSpend[]; failed: boolean };
	suggestion: string | null;
}

async function load(who: Person, url = '/kekayaan', space?: App.Locals['space']) {
	const current = space ?? (await resolveCurrentSpace(db, who.user.id, undefined));
	const { event } = fakeEvent({
		url: `http://localhost${url}`,
		routeId: '/(app)/kekayaan',
		db,
		user: who.user,
		space: current
	});
	return run(async () => page.load(event as never));
}
async function data(who: Person, url?: string): Promise<PageData> {
	const r = await load(who, url);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value as unknown as PageData;
}

async function wallet(
	scope: SpaceScope,
	name: string,
	type: WalletType,
	openingBalanceMinor = 0,
	currency: 'IDR' | 'USD' = 'IDR'
) {
	const r = await createWallet(
		db,
		scope,
		{
			name,
			type,
			currency,
			openingBalanceMinor,
			isFavourite: false,
			lastFour: type === 'kartu_kredit' ? '4242' : null
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

/** A preset expense category of the space (an expense row names one). */
async function expenseCategory(scope: SpaceScope) {
	await ensurePresetCategories(db, scope.spaceId, NOW);
	return (await listCategories(db, scope.spaceId)).find((c) => c.tileKey === 'belanja')!.id;
}

async function tx(scope: SpaceScope, over: Partial<TransactionInput>) {
	const categoryId = over.type && over.type !== 'expense' ? null : await expenseCategory(scope);
	const r = await createTransaction(
		db,
		scope,
		{
			type: 'expense',
			amountMinor: 1_000_00,
			currency: 'IDR',
			walletId: '',
			transferToWalletId: null,
			categoryId,
			title: 'Belanja',
			note: null,
			occurredOn: wibTodayString(),
			occurredTime: null,
			...over
		},
		NOW
	);
	if (!r.ok) throw new Error(`tx failed: ${JSON.stringify(r)}`);
	return r.id;
}

const manual = (over: Partial<NetWorthInput> = {}): NetWorthInput => ({
	kind: 'property',
	name: 'Rumah',
	currency: 'IDR',
	priceSource: 'manual',
	priceSymbol: null,
	quantityScaled: null,
	quantityScale: null,
	manualValueMinor: 500_000_000_00,
	acquiredOn: null,
	note: null,
	...over
});
async function item(scope: SpaceScope, input: NetWorthInput) {
	const r = await createNetWorthItem(db, scope, input, NOW);
	if (!r.ok) throw new Error('item failed');
	return r.id;
}

describe('trend chart data (netWorthTrend)', () => {
	it('a new user: no points, so the chart shows its empty text (no invented line)', async () => {
		const p = await person();
		const d = await data(p);
		expect(d.trend).toEqual({ range: '1m', points: [], failed: false });
		expect(d.netWorth.allocation).toEqual({ slices: [], assetsMinor: null, outside: [] });
		expect(d.creditCards).toEqual({ cards: [], failed: false });
	});

	it('plots exactly the stored totals of the range, oldest first, partial days flagged', async () => {
		const p = await person();
		const today = wibTodayString();
		const days = [400, 100, 40, 20, 10, 1, 0];
		for (const [i, back] of days.entries())
			await upsertSnapshot(
				db,
				p.scope.spaceId,
				addDays(today, -back),
				(i + 1) * 1_000_00,
				NOW,
				back === 10
			);
		// A tombstoned day never shows.
		await d1
			.prepare(
				'update net_worth_snapshots set deleted_at = ?, total_minor = null where space_id = ? and date = ?'
			)
			.bind(NOW, p.scope.spaceId, addDays(today, -1))
			.run();

		const m1 = await data(p);
		expect(m1.trend.points).toEqual([
			{ date: addDays(today, -20), totalMinor: 4_000_00, partial: false },
			{ date: addDays(today, -10), totalMinor: 5_000_00, partial: true },
			{ date: today, totalMinor: 7_000_00, partial: false }
		]);
		const m3 = await data(p, '/kekayaan?rentang=3m');
		expect(m3.trend.range).toBe('3m');
		expect(m3.trend.points.map((x) => x.totalMinor)).toEqual([
			3_000_00, 4_000_00, 5_000_00, 7_000_00
		]);
		const y1 = await data(p, '/kekayaan?rentang=1y');
		expect(y1.trend.points[0]?.date).toBe(addDays(today, -100));
		const all = await data(p, '/kekayaan?rentang=all');
		expect(all.trend.points.map((x) => x.date)).toEqual(
			[400, 100, 40, 20, 10, 0].map((b) => addDays(today, -b))
		);
		// An unknown range is the default, never an error.
		expect((await data(p, '/kekayaan?rentang=%3Cx%3E')).trend.range).toBe('1m');
	});

	it(`reads at most ${TREND_MAX_POINTS} points (the newest)`, async () => {
		const p = await person();
		const today = '2030-01-01';
		// One statement: a recursive count writes a snapshot for each of the last TREND_MAX_POINTS + 5 days.
		await d1
			.prepare(
				`with recursive n(i) as (select 0 union all select i + 1 from n where i < ?)
				insert into net_worth_snapshots
					(space_id, date, total_minor, currency, partial, created_at, updated_at, seq)
				select ?, date(?, '-' || i || ' days'), i, 'IDR', 0, ?, ?, 1 from n`
			)
			.bind(TREND_MAX_POINTS + 4, p.scope.spaceId, today, NOW, NOW)
			.run();
		const points = await netWorthTrend(db, p.scope.spaceId, 'all', today);
		expect(points).toHaveLength(TREND_MAX_POINTS);
		expect(points.at(-1)?.date).toBe(today);
		expect(points[0]?.date).toBe(addDays(today, -(TREND_MAX_POINTS - 1)));
	});

	it('two spaces: each load reads only its own snapshots', async () => {
		const a = await person('A');
		const b = await person('B');
		const today = wibTodayString();
		await upsertSnapshot(db, a.scope.spaceId, addDays(today, -1), 111_00, NOW);
		await upsertSnapshot(db, a.scope.spaceId, today, 222_00, NOW);
		await upsertSnapshot(db, b.scope.spaceId, today, 999_00, NOW);
		expect((await data(a)).trend.points.map((x) => x.totalMinor)).toEqual([111_00, 222_00]);
		expect((await data(b)).trend.points.map((x) => x.totalMinor)).toEqual([999_00]);
	});

	it('a removed member and a stranger get the same 404 as an unknown space; nothing is read', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const stranger = await person('Orang lain');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		await upsertSnapshot(db, spaceId, wibTodayString(), 5_00, NOW);
		const shared = {
			id: spaceId,
			kind: 'shared' as const,
			name: 'Keluarga',
			role: 'member' as const
		};
		expect((await load(member, '/kekayaan', shared)).kind).toBe('ok');

		const m = (await listMembers(db, spaceId, owner.user.id)).find((x) => !x.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: m.id }, NOW);
		const removed = await load(member, '/kekayaan', shared);
		const foreign = await load(stranger, '/kekayaan', shared);
		const unknown = await load(stranger, '/kekayaan', { ...shared, id: 'tidak-ada' });
		expect(removed).toEqual({ kind: 'error', status: 404, body: expect.anything() });
		expect(foreign).toEqual(removed);
		expect(unknown).toEqual(removed);
	});
});

describe('allocation, sections and Data demo', () => {
	it('bar = assets only (exact), debts a separate line; subtotals equal their rows; demo rows move nothing', async () => {
		const p = await person();
		await wallet(p.scope, 'BCA', 'bank', 16_356_000_00);
		await wallet(p.scope, 'Tunai', 'tunai', 3_643_000_00);
		await item(
			p.scope,
			manual({ kind: 'investment_stock', name: 'BBCA', manualValueMinor: 4_937_500_00 })
		);
		await item(
			p.scope,
			manual({ kind: 'property', name: 'Rumah', manualValueMinor: 18_500_000_00 })
		);
		await item(p.scope, manual({ kind: 'debt', name: 'KPR', manualValueMinor: 250_000_000_00 }));
		const before = await data(p);

		// A Data demo item and a demo transaction on a wallet: the figures stay the same.
		const demo = await item(
			p.scope,
			manual({ kind: 'investment_stock', name: 'Demo', manualValueMinor: 1_000_000_000_00 })
		);
		await d1.prepare('update net_worth_items set is_demo = 1 where id = ?').bind(demo).run();
		const after = await data(p);
		expect(after.netWorth.allocation).toEqual(before.netWorth.allocation);
		expect(after.netWorth.sections).toEqual(before.netWorth.sections);

		const a = after.netWorth.allocation!;
		expect(a.slices.map((s) => [s.cls, s.minor])).toEqual([
			['wallets', 19_999_000_00],
			['investment', 4_937_500_00],
			['property', 18_500_000_00]
		]);
		expect(a.assetsMinor).toBe(43_436_500_00);
		expect(a.slices.reduce((s, x) => s + x.pct, 0)).toBe(100);
		expect(a.outside).toEqual([{ cls: 'debt', minor: -250_000_000_00 }]);
		// The bar plus the debt line is the hero figure.
		expect(after.netWorth.summary!.totalMinor).toBe(43_436_500_00 - 250_000_000_00);

		expect(after.netWorth.sections).toEqual({
			wallets: [{ currency: 'IDR', totalMinor: 19_999_000_00 }],
			investment: [{ currency: 'IDR', totalMinor: 4_937_500_00 }],
			crypto: []
		});
		expect(after.netWorth.wallets.map((w) => w.balanceMinor)).toEqual([
			16_356_000_00, 3_643_000_00
		]);
	});
});

describe('credit cards: 30-day spend', () => {
	it('sums expenses of the last 30 WIB days per card, reconciling with Riwayat for that wallet and period', async () => {
		const p = await person();
		await expenseCategory(p.scope);
		const income = (await listCategories(db, p.scope.spaceId)).find(
			(c) => c.tileKey === 'gaji'
		)!.id;
		const card = await wallet(p.scope, 'Visa', 'kartu_kredit');
		const other = await wallet(p.scope, 'Master', 'kartu_kredit');
		const bank = await wallet(p.scope, 'BCA', 'bank', 10_000_000_00);
		const today = wibTodayString();
		await tx(p.scope, { walletId: card, amountMinor: 2_000_000_00 });
		await tx(p.scope, { walletId: card, amountMinor: 330_000_00, occurredOn: addDays(today, -29) });
		// Outside the window (30 days back), income, a payment into the card, and a bank expense: not counted.
		await tx(p.scope, { walletId: card, amountMinor: 999_00, occurredOn: addDays(today, -30) });
		await tx(p.scope, { walletId: card, type: 'income', amountMinor: 50_00, categoryId: income });
		await tx(p.scope, {
			walletId: bank,
			type: 'transfer',
			transferToWalletId: card,
			amountMinor: 1_000_000_00
		});
		await tx(p.scope, { walletId: bank, amountMinor: 77_00 });
		// A Data demo expense on the card never counts.
		const demo = await tx(p.scope, { walletId: card, amountMinor: 5_000_000_00 });
		await d1.prepare('update transactions set is_demo = 1 where id = ?').bind(demo).run();

		const d = await data(p);
		expect(d.creditCards.cards).toEqual([
			{
				walletId: card,
				name: 'Visa',
				lastFour: '4242',
				currency: 'IDR',
				from: addDays(today, -29),
				to: today,
				totals: [{ currency: 'IDR', outMinor: 2_330_000_00 }]
			},
			{
				walletId: other,
				name: 'Master',
				lastFour: '4242',
				currency: 'IDR',
				from: addDays(today, -29),
				to: today,
				totals: []
			}
		]);
		const riwayat = await periodTotals(db, p.scope.spaceId, {
			from: addDays(today, -29),
			to: today,
			type: 'expense',
			categoryId: null,
			walletId: card,
			q: null
		});
		expect(riwayat.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 2_330_000_00 }]);
	});

	it("never reads another space's card; 101+ ids bind once (no parameter limit)", async () => {
		const a = await person('A');
		const b = await person('B');
		const cardA = await wallet(a.scope, 'Visa A', 'kartu_kredit');
		await tx(a.scope, { walletId: cardA, amountMinor: 12_00 });
		const today = wibTodayString();
		const ids = [cardA, ...Array.from({ length: 120 }, (_, i) => `x-${i}`)];
		const period = { from: addDays(today, -29), to: today };
		expect(await walletExpenseTotals(db, b.scope.spaceId, period, ids)).toEqual([]);
		expect(await walletExpenseTotals(db, a.scope.spaceId, period, ids)).toEqual([
			{ walletId: cardA, currency: 'IDR', outMinor: 12_00 }
		]);
		expect((await data(b)).creditCards.cards).toEqual([]);
	});
});

describe('suggestion pre-fill parameter', () => {
	it('only the two known cards are read from `saran`', async () => {
		const p = await person();
		expect((await data(p, '/kekayaan?aset=baru&saran=emas')).suggestion).toBe('gold');
		expect((await data(p, '/kekayaan?aset=baru&saran=pensiun')).suggestion).toBe('pension');
		expect((await data(p, '/kekayaan?aset=baru&saran=__proto__')).suggestion).toBeNull();
	});
});
