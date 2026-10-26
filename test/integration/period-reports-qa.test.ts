import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { type NetWorthPeriodReport } from '#lib/server/net-worth/period';
import { upsertSnapshot } from '#lib/server/net-worth/summary';
import { type MoneyFlowReport } from '#lib/server/reports/money-flow';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { createTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { FOLDED_ID } from '#lib/shared/money-flow';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { fakeKv } from '../helpers/kv';

/**
 * FN-53 QA probes (independent of the engineer's file): a quarter equals the sum of its three month views, the leap
 * day, the 7/8-day opening carry, and the 100-category / 30-wallet fold bound.
 */
const kv = fakeKv();
const binding: { DB?: D1Database; CACHE?: KVNamespace } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const flowPage = await import('../../src/routes/(app)/alur-uang/+page.server');
const nwPage = await import('../../src/routes/(app)/kekayaan/laporan/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.now();

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
	binding.CACHE = kv.kv;
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
	const email = `periode${++n}@contoh.id`;
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

async function event(
	who: Person | null,
	route: 'alur-uang' | 'kekayaan/laporan',
	url: string,
	space?: string,
	d = db
) {
	const current = who ? await resolveCurrentSpace(db, who.user.id, space) : null;
	return fakeEvent({
		url: `http://localhost${url}`,
		routeId: `/(app)/${route}`,
		db: d,
		user: who?.user ?? null,
		space: current
	}).event as never;
}
async function flowOf(who: Person, url: string, space?: string): Promise<MoneyFlowReport> {
	const r = await run(async () => flowPage.load(await event(who, 'alur-uang', url, space)));
	if (r.kind !== 'ok' || r.value.loadError) throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.report as MoneyFlowReport;
}
async function nwOf(who: Person, url: string, space?: string): Promise<NetWorthPeriodReport> {
	const r = await run(async () => nwPage.load(await event(who, 'kekayaan/laporan', url, space)));
	if (r.kind !== 'ok' || r.value.loadError) throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.report as NetWorthPeriodReport;
}

/** Presets, BCA and GoPay (IDR) and Wise (USD); `tx` records through the app's own repo. */
async function ledger(scope: SpaceScope) {
	await ensurePresetCategories(db, scope.spaceId, NOW);
	const cats = await listCategories(db, scope.spaceId);
	const wallet = async (name: string, currency: 'IDR' | 'USD' = 'IDR') => {
		const r = await createWallet(
			db,
			scope,
			{ name, type: 'bank', currency, openingBalanceMinor: 0, isFavourite: false, lastFour: null },
			NOW
		);
		if (!r.ok) throw new Error('wallet failed');
		return r.id;
	};
	const bca = await wallet('BCA');
	const gopay = await wallet('GoPay');
	const wise = await wallet('Wise', 'USD');
	const cat = (tile: string) => cats.find((c) => c.tileKey === tile)!.id;
	const expenseCats = cats.filter((c) => c.kind === 'expense').map((c) => c.id);
	const tx = async (over: Partial<TransactionInput>) => {
		const r = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor: 1_000,
				currency: 'IDR',
				walletId: bca,
				transferToWalletId: null,
				categoryId: cat('kopi'),
				title: 'Kopi',
				note: null,
				occurredOn: '2025-08-15',
				occurredTime: null,
				...over
			},
			NOW
		);
		if (!r.ok) throw new Error(`tx failed: ${JSON.stringify(r)}`);
		return r.id;
	};
	return { bca, gopay, wise, cat, expenseCats, tx };
}

const sum = (xs: (number | null)[]) => xs.reduce((a: number, b) => a + (b ?? 0), 0);

describe('QA probes', () => {
	it('a quarter and a year equal the sum of their Bulan views, per node', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({
			type: 'income',
			amountMinor: 9_000_001,
			categoryId: l.cat('gaji'),
			occurredOn: '2025-07-01'
		});
		await l.tx({
			type: 'income',
			amountMinor: 333,
			categoryId: l.cat('gaji'),
			occurredOn: '2025-09-30',
			occurredTime: '23:30'
		});
		for (const [i, d] of [
			'2025-07-31',
			'2025-08-01',
			'2025-08-31',
			'2025-09-01',
			'2025-09-30'
		].entries())
			await l.tx({ amountMinor: 101 + i * 7, occurredOn: d, occurredTime: '23:59' });
		const q = await flowOf(p, '/alur-uang?k=2025-Q3');
		const months = await Promise.all(
			['2025-07', '2025-08', '2025-09'].map((m) => flowOf(p, `/alur-uang?p=${m}`))
		);
		expect(sum(months.map((m) => m.inMinor))).toBe(q.inMinor);
		expect(sum(months.map((m) => m.outMinor))).toBe(q.outMinor);
		expect(q.months!.map((m) => [m.inMinor, m.outMinor])).toEqual(
			months.map((m) => [m.inMinor, m.outMinor])
		);
		const y = await flowOf(p, '/alur-uang?y=2025');
		expect([y.inMinor, y.outMinor]).toEqual([q.inMinor, q.outMinor]);
		expect(sum(y.months!.map((m) => m.outMinor))).toBe(y.outMinor);
	});

	it('leap day 29 Feb 2024 23:30 and 1 Mar 00:30; the 366-day year does not throw; previous year is compared', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ occurredOn: '2024-02-29', occurredTime: '23:30', amountMinor: 3 });
		await l.tx({ occurredOn: '2024-03-01', occurredTime: '00:30', amountMinor: 5 });
		await l.tx({ occurredOn: '2023-12-31', occurredTime: '23:30', amountMinor: 7 });
		await l.tx({ occurredOn: '2024-12-31', occurredTime: '23:30', amountMinor: 11 });
		const out = async (u: string) => (await flowOf(p, u)).outMinor;
		expect(await out('/alur-uang?p=2024-02')).toBe(3);
		expect(await out('/alur-uang?p=2024-03')).toBe(5);
		expect(await out('/alur-uang?k=2024-Q1')).toBe(8);
		expect(await out('/alur-uang?y=2024')).toBe(8 + 11);
		expect(await out('/alur-uang?y=2023')).toBe(7);
		const y = await flowOf(p, '/alur-uang?y=2024');
		expect([y.from, y.to]).toEqual(['2024-01-01', '2024-12-31']);
		expect(y.comparison!.previousTotals.outMinor).toBe(7);
		expect(y.comparison!.diff.outMinor).toBe(19 - 7);
		expect(y.average).toEqual({ inMinor: 0, outMinor: Math.floor(19 / 12), months: 12 });
	});

	it('opening carry: 7 days back is `earlier`, 8 days back is not used (falls to since_start)', async () => {
		const p = await person();
		const id = p.scope.spaceId;
		// Q3 2025 starts 2025-07-01; day before = 06-30. 7 days before that = 06-23; 8 = 06-22.
		await upsertSnapshot(db, id, '2025-06-23', 1_000, NOW);
		await upsertSnapshot(db, id, '2025-08-10', 1_500, NOW);
		await upsertSnapshot(db, id, '2025-09-30', 2_000, NOW);
		const a = await nwOf(p, '/kekayaan/laporan?k=2025-Q3');
		expect(a.opening).toEqual({ minor: 1_000, date: '2025-06-23', basis: 'earlier' });
		expect(a.changeMinor).toBe(1_000);
		const p2 = await person();
		const id2 = p2.scope.spaceId;
		await upsertSnapshot(db, id2, '2025-06-22', 1_000, NOW);
		await upsertSnapshot(db, id2, '2025-08-10', 1_500, NOW);
		await upsertSnapshot(db, id2, '2025-09-30', 2_000, NOW);
		const b = await nwOf(p2, '/kekayaan/laporan?k=2025-Q3');
		expect(b.opening).toEqual({ minor: 1_500, date: '2025-08-10', basis: 'since_start' });
		expect(b.changeMinor).toBe(500);
		// July is a gap: its point has no value.
		expect(b.points.map((x) => [x.key, x.minor])).toEqual([
			['awal', 1_500],
			['2025-07', null],
			['2025-08', 1_500],
			['2025-09', 2_000]
		]);
	});

	it('a snapshot dated after today is never read; a past year lists at most its own snapshots', async () => {
		const p = await person();
		const id = p.scope.spaceId;
		await upsertSnapshot(db, id, '2024-12-31', 100, NOW);
		await upsertSnapshot(db, id, '2025-12-31', 250, NOW);
		await upsertSnapshot(db, id, '2026-01-01', 999, NOW);
		const y = await nwOf(p, '/kekayaan/laporan?y=2025');
		expect(y.opening).toEqual({ minor: 100, date: '2024-12-31', basis: 'exact' });
		expect(y.closing).toMatchObject({ minor: 250, date: '2025-12-31' });
		expect(y.points.at(-1)).toMatchObject({ key: '2025-12', minor: 250 });
		const y26 = await nwOf(p, '/kekayaan/laporan?k=2026-Q1');
		expect(y26.opening).toEqual({ minor: 250, date: '2025-12-31', basis: 'exact' });
	});

	it('100 categories, 30 wallets: fold bounds hold and sums stay exact', async () => {
		const { shapeMoneyFlow, foldMoneyFlow, linkList } =
			await import('#lib/server/reports/money-flow');
		const rows = [];
		for (let c = 0; c < 100; c++)
			for (const type of ['income', 'expense'] as const)
				rows.push({
					type,
					category: { id: `c${c}`, name: `Kat ${c}`, isPreset: false, tileKey: 'lain' as const },
					wallet: { id: `w${c % 30}`, name: `W${c % 30}` },
					currency: 'IDR',
					count: 1,
					amountMinor: 1_000_003 + c * 17 + (type === 'income' ? 5 : 0)
				});
		const flow = shapeMoneyFlow(rows as never, 'IDR');
		const folded = foldMoneyFlow(flow);
		expect(folded.income.length).toBeLessThanOrEqual(8);
		expect(folded.expense.length).toBeLessThanOrEqual(8);
		expect(folded.wallets.length).toBeLessThanOrEqual(7);
		expect([folded.inMinor, folded.outMinor]).toEqual([flow.inMinor, flow.outMinor]);
		expect(sum(folded.income.map((n) => n.minor))).toBe(flow.inMinor);
		expect(sum(folded.expense.map((n) => n.minor))).toBe(flow.outMinor);
		expect(sum(folded.wallets.map((n) => n.outMinor))).toBe(flow.outMinor);
		expect(sum(folded.wallets.map((n) => n.inMinor))).toBe(flow.inMinor);
		const exp = folded.links.filter((l) => l.from.startsWith('w:'));
		expect(sum(exp.map((l) => l.amountMinor))).toBe(flow.outMinor);
		for (const l of folded.links) {
			const keys = new Set(
				[...folded.income, ...folded.wallets, ...folded.expense].map((n) => n.key)
			);
			expect(keys.has(l.from) && keys.has(l.to)).toBe(true);
		}
		const list = linkList(exp, 12);
		expect(list.links).toHaveLength(12);
		expect(sum(list.links.map((l) => l.amountMinor)) + (list.rest?.minor ?? 0)).toBe(flow.outMinor);
		// exactly 8 categories / 7 wallets: no fold.
		const small = shapeMoneyFlow(
			rows
				.filter((r) => Number(r.category.id.slice(1)) < 8 && r.wallet.id <= 'w6')
				.slice(0, 16) as never,
			'IDR'
		);
		expect(foldMoneyFlow(small).expense.some((n) => n.categoryId === FOLDED_ID)).toBe(false);
	});
});
