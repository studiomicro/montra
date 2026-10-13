import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { laporanReport } from '#lib/server/reports/laporan';
import { moneyFlowReport, type MoneyFlowReport } from '#lib/server/reports/money-flow';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	categoryTotals,
	MONEY_FLOW_MAX_GROUPS,
	moneyFlowTotals,
	periodTotals,
	type TransactionFilter
} from '#lib/server/transactions/aggregate';
import { createTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { monthOf, monthRange, shiftMonth, wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/alur-uang/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
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
	const email = `alur${++n}@contoh.id`;
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

async function ev(who: Person | null, url: string, space?: string) {
	const current = who ? await resolveCurrentSpace(db, who.user.id, space) : null;
	return fakeEvent({
		url: `http://localhost${url}`,
		routeId: '/(app)/alur-uang',
		db,
		user: who?.user ?? null,
		space: current
	}).event as never;
}

async function flowOf(who: Person, url = '/alur-uang', space?: string): Promise<MoneyFlowReport> {
	const r = await run(async () => page.load(await ev(who, url, space)));
	if (r.kind !== 'ok' || r.value.loadError) throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.report as MoneyFlowReport;
}

/** Presets, two IDR wallets, a USD wallet and a wallet that never moves money. */
async function ledger(scope: SpaceScope) {
	await ensurePresetCategories(db, scope.spaceId, NOW);
	const cats = await listCategories(db, scope.spaceId);
	const wallet = async (name: string, currency: 'IDR' | 'USD') => {
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
	const idle = await wallet('Celengan', 'IDR');
	const cat = (tile: string) => cats.find((c) => c.tileKey === tile)!.id;
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
				categoryId: cat('kopi'),
				title: 'Kopi',
				note: null,
				occurredOn: wibTodayString(),
				occurredTime: null,
				...over
			},
			NOW
		);
		if (!r.ok) throw new Error(`tx failed: ${JSON.stringify(r)}`);
		return r.id;
	};
	return { bca, gopay, wise, idle, tx, cat };
}

const filterOf = (month: string, over: Partial<TransactionFilter> = {}): TransactionFilter => ({
	...monthRange(month),
	type: null,
	categoryId: null,
	walletId: null,
	q: null,
	...over
});

const idr = (totals: { currency: string; inMinor: number | null; outMinor: number | null }[]) =>
	totals.find((t) => t.currency === 'IDR') ?? { currency: 'IDR', inMinor: 0, outMinor: 0 };

async function seeded() {
	const p = await person();
	const l = await ledger(p.scope);
	const today = wibTodayString();
	await l.tx({
		type: 'income',
		amountMinor: 900_000_000,
		categoryId: l.cat('gaji'),
		title: 'Gaji'
	});
	await l.tx({
		type: 'income',
		amountMinor: 50_000_000,
		walletId: l.gopay,
		categoryId: l.cat('bonus'),
		title: 'Bonus'
	});
	await l.tx({ amountMinor: 2_500_000 });
	await l.tx({ amountMinor: 7_300_000, categoryId: l.cat('makan'), title: 'Warteg' });
	await l.tx({ amountMinor: 1_200_000, walletId: l.gopay, title: 'Kopi susu' });
	await l.tx({
		type: 'transfer',
		amountMinor: 40_000_000,
		categoryId: null,
		transferToWalletId: l.gopay
	});
	await l.tx({ walletId: l.wise, currency: 'USD', amountMinor: 999, title: 'Netflix' });
	// Last month: a category (Belanja) that has no flow this month.
	await l.tx({
		occurredOn: `${shiftMonth(monthOf(today), -1)}-15`,
		amountMinor: 4_000_000,
		categoryId: l.cat('belanja')
	});
	const demo = await l.tx({
		amountMinor: 123_000_000,
		title: 'Demo',
		categoryId: l.cat('hiburan')
	});
	await d1.prepare('update transactions set is_demo = 1 where id = ?').bind(demo).run();
	return { p, l, month: monthOf(today), today };
}

describe('/alur-uang load', () => {
	it('sends a signed-out visitor to /masuk', async () => {
		expect(await run(async () => page.load(await ev(null, '/alur-uang')))).toMatchObject({
			kind: 'redirect',
			status: 303,
			location: '/masuk'
		});
	});

	it('an empty month: no node and no link, honest zeros (the page shows its empty state)', async () => {
		const p = await person();
		await ledger(p.scope);
		const r = await flowOf(p);
		expect(r).toMatchObject({
			month: monthOf(wibTodayString()),
			currency: 'IDR',
			income: [],
			wallets: [],
			expense: [],
			links: [],
			inMinor: 0,
			outMinor: 0,
			otherCurrencies: [],
			otherCount: 0
		});
	});

	it('reads ?p=YYYY-MM and clamps a future month to this month', async () => {
		const p = await person();
		const month = shiftMonth(monthOf(wibTodayString()), -2);
		expect((await flowOf(p, `/alur-uang?p=${month}`)).month).toBe(month);
		expect((await flowOf(p, '/alur-uang?p=2999-01')).month).toBe(monthOf(wibTodayString()));
	});
});

describe('the flow reconciles with Laporan and Riwayat (pre-handoff probe: totals reconcile)', () => {
	it('each wallet’s links equal its income and expense totals for the same filter', async () => {
		const { p, l, month } = await seeded();
		const r = await flowOf(p);
		for (const walletId of [l.bca, l.gopay]) {
			const w = r.wallets.find((x) => x.walletId === walletId)!;
			const into = r.links.filter((x) => x.to === w.key).reduce((s, x) => s + x.amountMinor!, 0);
			const outOf = r.links.filter((x) => x.from === w.key).reduce((s, x) => s + x.amountMinor!, 0);
			const inc = await periodTotals(
				db,
				p.scope.spaceId,
				filterOf(month, { walletId, type: 'income' })
			);
			const exp = await periodTotals(
				db,
				p.scope.spaceId,
				filterOf(month, { walletId, type: 'expense' })
			);
			expect(into).toBe(idr(inc.totals).inMinor);
			expect(outOf).toBe(idr(exp.totals).outMinor);
			expect([w.inMinor, w.outMinor]).toEqual([into, outOf]);
		}
		expect(r.wallets.find((w) => w.walletId === l.bca)).toMatchObject({
			inMinor: 900_000_000,
			outMinor: 9_800_000 // the transfer out of BCA is no expense
		});
	});

	it('the month totals equal Laporan’s stat line; each category node equals categoryTotals', async () => {
		const { p, month, today } = await seeded();
		const r = await flowOf(p);
		const lap = await laporanReport(db, p.scope.spaceId, today, {
			mode: 'bulan',
			month,
			direction: 'keluar'
		});
		expect([r.inMinor, r.outMinor]).toEqual([lap.stats[0]!.inMinor, lap.stats[0]!.outMinor]);
		expect([r.inMinor, r.outMinor]).toEqual([950_000_000, 11_000_000]);
		for (const [type, nodes] of [
			['expense', r.expense],
			['income', r.income]
		] as const) {
			const cats = await categoryTotals(db, p.scope.spaceId, filterOf(month, { type }));
			for (const node of nodes) {
				const c = cats.find((x) => (x.category?.id ?? '') === node.categoryId)!;
				expect(node.minor).toBe(idr(c.totals)[type === 'income' ? 'inMinor' : 'outMinor']);
			}
		}
	});

	it('one currency drawn; the other is named and counted, never added in (AC 4)', async () => {
		const { p, l } = await seeded();
		const r = await flowOf(p);
		expect(r.currency).toBe('IDR');
		expect(r.otherCurrencies).toEqual(['USD']);
		expect(r.otherCount).toBe(1);
		expect(r.wallets.some((w) => w.walletId === l.wise)).toBe(false);
	});

	it('demo rows, transfers and nodes without flow are left out (AC 6, 11)', async () => {
		const { p, l } = await seeded();
		const r = await flowOf(p);
		expect(r.wallets.map((w) => w.walletId)).toEqual([l.bca, l.gopay]); // no Celengan, no Wise
		expect(r.expense.map((n) => n.categoryId)).toEqual([l.cat('makan'), l.cat('kopi')]); // no Belanja, no Hiburan (demo)
		expect(r.income.map((n) => n.categoryId)).toEqual([l.cat('gaji'), l.cat('bonus')]);
		expect(r.links.every((x) => x.amountMinor! > 0)).toBe(true);
		expect(r.links).toHaveLength(5);
	});

	it('the favourite wallet’s currency is the one drawn', async () => {
		const { p, l } = await seeded();
		await d1
			.prepare('update wallets set is_favourite = (id = ?) where space_id = ?')
			.bind(l.wise, p.scope.spaceId)
			.run();
		const r = await flowOf(p);
		expect(r.currency).toBe('USD');
		expect(r.outMinor).toBe(999);
		expect(r.otherCurrencies).toEqual(['IDR']);
		expect(r.otherCount).toBe(5);
	});
});

describe('only income and expense rows enter the flow (AC 12, coordination with FN-37)', () => {
	it('a row of any other type (a transfer, or a future balance adjustment) contributes to no link', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const month = monthOf(wibTodayString());
		await l.tx({ amountMinor: 1_000 });
		await l.tx({
			type: 'transfer',
			amountMinor: 7_000,
			categoryId: null,
			transferToWalletId: l.gopay
		});
		// FN-37 adds a type the schema here does not know yet: write one with the CHECK constraints off, as a
		// migration widening the type list would allow. A `type <> 'transfer'` filter would count it.
		await d1.prepare('PRAGMA ignore_check_constraints = ON').run();
		try {
			await d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
						title, occurred_on, occurred_at, created_at, updated_at, seq)
					values ('adj-1', ?, 'adjustment', 5000000, 'IDR', ?, ?, 'Penyesuaian', ?, 0, 0, 0, 1)`
				)
				.bind(p.scope.spaceId, l.cat('kopi'), l.bca, wibTodayString())
				.run();
		} finally {
			await d1.prepare('PRAGMA ignore_check_constraints = OFF').run();
		}
		const raw = await d1
			.prepare("select count(*) as n from transactions where id = 'adj-1'")
			.first<{ n: number }>();
		expect(raw?.n).toBe(1);

		const { rows } = await moneyFlowTotals(db, p.scope.spaceId, filterOf(month));
		expect(rows.map((r) => [r.type, r.amountMinor])).toEqual([['expense', 1_000]]);
		const r = await moneyFlowReport(db, p.scope.spaceId, month);
		expect(r.outMinor).toBe(1_000);
		expect(r.inMinor).toBe(0);
		expect(r.links).toEqual([
			{ from: `w:${l.bca}`, to: `out:${l.cat('kopi')}`, amountMinor: 1_000 }
		]);
	});
});

describe('bounded result (red team FN-35 L1)', () => {
	it('returns at most MONEY_FLOW_MAX_GROUPS groups, the largest, and says it left some out', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const month = monthOf(wibTodayString());
		const over = MONEY_FLOW_MAX_GROUPS + 1;
		// One expense in each of `over` categories (direct inserts: the app's caps stop far below this).
		await d1
			.prepare(
				`with recursive k(i) as (select 0 union all select i + 1 from k where i < ? - 1)
				insert into categories (id, space_id, kind, name, tile_key, is_preset, is_hidden, sort_order,
					created_at, updated_at, seq)
				select 'cap-c-' || i, ?, 'expense', 'Kategori ' || i, 'lain', 0, 0, 100 + i, 0, 0, 1 from k`
			)
			.bind(over, p.scope.spaceId)
			.run();
		await d1
			.prepare(
				`with recursive k(i) as (select 0 union all select i + 1 from k where i < ? - 1)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					title, occurred_on, occurred_at, created_at, updated_at, seq)
				select 'cap-t-' || i, ?, 'expense', 1000 + i, 'IDR', 'cap-c-' || i, ?, 'Uji', ?, 0, 0, 0, 1 from k`
			)
			.bind(over, p.scope.spaceId, l.bca, wibTodayString())
			.run();
		const { rows, truncated } = await moneyFlowTotals(db, p.scope.spaceId, filterOf(month));
		expect(truncated).toBe(true);
		expect(rows).toHaveLength(MONEY_FLOW_MAX_GROUPS);
		// The smallest group (1000) is the one left out; the largest is kept.
		expect(rows.some((r) => r.category?.id === 'cap-c-0')).toBe(false);
		expect(rows[0]?.amountMinor).toBe(1000 + over - 1);
		const report = await moneyFlowReport(db, p.scope.spaceId, month);
		expect(report.truncated).toBe(true);
	});

	it('a normal month is not truncated', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({});
		const report = await moneyFlowReport(db, p.scope.spaceId, monthOf(wibTodayString()));
		expect(report.truncated).toBe(false);
	});
});

describe('WIB month boundaries (pre-handoff probe)', () => {
	it('23:30 WIB on 31 October and 00:30 WIB on 1 November flow in their own month', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ occurredOn: '2026-10-31', occurredTime: '23:30', amountMinor: 300 });
		await l.tx({ occurredOn: '2026-11-01', occurredTime: '00:30', amountMinor: 500 });
		expect((await moneyFlowReport(db, p.scope.spaceId, '2026-10')).outMinor).toBe(300);
		expect((await moneyFlowReport(db, p.scope.spaceId, '2026-11')).outMinor).toBe(500);
	});
});

describe('one access rule across spaces (pre-handoff cross-space probe, AC 7)', () => {
	async function shared() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const l = await ledger({ spaceId, userId: owner.user.id });
		await l.tx({ amountMinor: 4_200_000, title: 'Belanja keluarga' });
		return { owner, member, spaceId };
	}

	it('a member sees the shared space’s flow', async () => {
		const { member, spaceId } = await shared();
		expect((await flowOf(member, '/alur-uang', spaceId)).outMinor).toBe(4_200_000);
	});

	it('a non-member naming the space (cookie or query) only ever sees their own space', async () => {
		const { spaceId } = await shared();
		const stranger = await person('Orang lain');
		for (const url of ['/alur-uang', `/alur-uang?space=${spaceId}&spaceId=${spaceId}`]) {
			const r = await flowOf(stranger, url, spaceId);
			expect(r.links).toEqual([]);
			expect(r.outMinor).toBe(0);
		}
	});

	it('a removed member loses the flow at once; a stale locals.space is 404 like every route', async () => {
		const { owner, member, spaceId } = await shared();
		const stale = await resolveCurrentSpace(db, member.user.id, spaceId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		expect((await flowOf(member, '/alur-uang', spaceId)).links).toEqual([]);
		const event = (url: string) =>
			fakeEvent({ url, routeId: '/(app)/alur-uang', db, user: member.user, space: stale })
				.event as never;
		const flow = await run(async () => page.load(event('http://localhost/alur-uang')));
		expect(flow).toMatchObject({ kind: 'error', status: 404 });
		// The same answer as Laporan gives for the same stale space: no existence oracle.
		const laporan = await import('../../src/routes/(app)/laporan/+page.server');
		const lap = await run(async () => laporan.load(event('http://localhost/laporan')));
		expect(flow).toEqual(lap);
	});
});

describe('load failure (AC 8)', () => {
	it('a failing query shows the error state with a fixed message, never a 500 or the SQL text', async () => {
		const p = await person();
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const space = await resolveCurrentSpace(db, p.user.id, undefined);
		const failing = new Proxy(db, {
			get: (target, prop) =>
				prop === 'all'
					? () => Promise.reject(new Error('D1_ERROR: boom at /src/lib/server/x.ts'))
					: Reflect.get(target, prop)
		});
		const event = fakeEvent({ url: 'http://localhost/alur-uang', db: failing, user: p.user, space })
			.event as never;
		expect(await run(async () => page.load(event))).toMatchObject({
			kind: 'ok',
			value: { report: null, loadError: 'Alur uang tidak bisa dimuat. Coba lagi sebentar lagi.' }
		});
		expect(JSON.stringify(spy.mock.calls)).not.toContain('D1_ERROR');
		spy.mockRestore();
	});
});
