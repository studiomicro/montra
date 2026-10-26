import { readFileSync } from 'node:fs';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { countStatements, D1_STATEMENTS_PER_INVOCATION } from '#lib/server/db/statement-count';
import { setFeatureFlag } from '#lib/server/feature-flags/repo';
import {
	liveNetWorth,
	netWorthPeriodReport,
	type NetWorthPeriodReport
} from '#lib/server/net-worth/period';
import { emptyPriceBook } from '#lib/server/net-worth/prices';
import { createNetWorthItem } from '#lib/server/net-worth/repo';
import { upsertSnapshot, writeSnapshots } from '#lib/server/net-worth/summary';
import { laporanReport } from '#lib/server/reports/laporan';
import { moneyFlowReport, type MoneyFlowReport } from '#lib/server/reports/money-flow';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { periodTotals, type TransactionFilter } from '#lib/server/transactions/aggregate';
import { createTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { addDays, monthOf, wibTodayString } from '#lib/shared/dates';
import { parseDecimal } from '#lib/shared/net-worth';
import { FOLDED_ID, flowRiwayatHref } from '#lib/shared/money-flow';
import { periodDates, type ReportPeriod } from '#lib/shared/report-period';
import { parseRiwayatQuery } from '#lib/shared/riwayat-query';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { fakeKv } from '../helpers/kv';

/**
 * FN-53 period reports end to end on local D1: /alur-uang for Bulan, Kuartal and Tahun (exact sums that reconcile
 * with Riwayat and Laporan, WIB boundaries, folding, averages, the comparison, bounded statements) and
 * /kekayaan/laporan from stored snapshots, across two users, two spaces and a removed member.
 */
const kv = fakeKv();
const binding: { DB?: D1Database; CACHE?: KVNamespace } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const flowPage = await import('../../src/routes/(app)/alur-uang/+page.server');
const nwPage = await import('../../src/routes/(app)/kekayaan/laporan/+page.server');
const kekayaanPage = await import('../../src/routes/(app)/kekayaan/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.now();
const TODAY = wibTodayString(NOW);

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

const filterOf = (
	from: string,
	to: string,
	over: Partial<TransactionFilter> = {}
): TransactionFilter => ({
	from,
	to,
	type: null,
	categoryId: null,
	walletId: null,
	q: null,
	...over
});
const idr = (totals: { currency: string; inMinor: number | null; outMinor: number | null }[]) =>
	totals.find((t) => t.currency === 'IDR') ?? { currency: 'IDR', inMinor: 0, outMinor: 0 };
const sum = (xs: (number | null)[]) => xs.reduce((a: number, b) => a + (b ?? 0), 0);

/** A quarter of 2025 with income and spending spread over July–September, plus last quarter's rows. */
async function q3(): Promise<{ p: Person; l: Awaited<ReturnType<typeof ledger>> }> {
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
		amountMinor: 500_003,
		walletId: l.gopay,
		categoryId: l.cat('bonus'),
		occurredOn: '2025-08-20'
	});
	await l.tx({ amountMinor: 2_507, occurredOn: '2025-07-02' });
	await l.tx({ amountMinor: 7_301, categoryId: l.cat('makan'), occurredOn: '2025-08-31' });
	await l.tx({ amountMinor: 1_201, walletId: l.gopay, occurredOn: '2025-09-30' });
	await l.tx({ amountMinor: 4_000, occurredOn: '2025-06-30' }); // Q2
	await l.tx({ amountMinor: 3_000, occurredOn: '2025-10-01' }); // Q4
	return { p, l };
}

describe('Kuartal and Tahun money flow reconcile (AC 8, 9)', () => {
	it('a quarter: totals equal periodTotals, and every node equals the Riwayat range it links to', async () => {
		const { p } = await q3();
		const r = await flowOf(p, '/alur-uang?k=2025-Q3');
		expect(r.period).toEqual({ kind: 'kuartal', year: '2025', quarter: 3 });
		expect([r.from, r.to, r.partial]).toEqual(['2025-07-01', '2025-09-30', false]);
		const t = idr((await periodTotals(db, p.scope.spaceId, filterOf(r.from, r.to))).totals);
		expect([r.inMinor, r.outMinor]).toEqual([t.inMinor, t.outMinor]);
		expect([r.inMinor, r.outMinor]).toEqual([9_500_004, 11_009]);
		const range = { from: r.from, to: r.to };
		const listed = async (href: string) => {
			const { view } = parseRiwayatQuery(new URL(`http://x${href}`).searchParams, TODAY);
			return idr((await periodTotals(db, p.scope.spaceId, view)).totals);
		};
		for (const node of r.expense) {
			const href = flowRiwayatHref(range, { type: 'expense', categoryId: node.categoryId })!;
			expect((await listed(href)).outMinor).toBe(node.minor);
		}
		for (const node of r.income) {
			const href = flowRiwayatHref(range, { type: 'income', categoryId: node.categoryId })!;
			expect((await listed(href)).inMinor).toBe(node.minor);
		}
		for (const w of r.wallets) {
			const t2 = await listed(flowRiwayatHref(range, { type: null, walletId: w.walletId })!);
			expect([t2.inMinor, t2.outMinor]).toEqual([w.inMinor, w.outMinor]);
		}
		for (const l of r.links) expect(l.amountMinor).toBeGreaterThan(0);
		expect(sum(r.lists.expense.links.map((l) => l.amountMinor))).toBe(r.outMinor);
		expect(r.lists.expense.rest).toBeNull();
	});

	it('a year: the Per bulan rows add up to the totals and to Laporan’s Tahun stat line', async () => {
		const { p } = await q3();
		const r = await flowOf(p, '/alur-uang?y=2025');
		expect(r.months).toHaveLength(12);
		expect(sum(r.months!.map((m) => m.inMinor))).toBe(r.inMinor);
		expect(sum(r.months!.map((m) => m.outMinor))).toBe(r.outMinor);
		const lap = await laporanReport(db, p.scope.spaceId, TODAY, {
			mode: 'tahun',
			year: '2025',
			direction: 'keluar'
		});
		expect([r.inMinor, r.outMinor]).toEqual([lap.stats[0]!.inMinor, lap.stats[0]!.outMinor]);
		expect(r.months!.find((m) => m.month === '2025-06')).toEqual({
			month: '2025-06',
			inMinor: 0,
			outMinor: 4_000
		});
	});

	it('the current year runs through today and equals Laporan’s current Tahun', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ amountMinor: 900, occurredOn: `${TODAY.slice(0, 4)}-01-01` });
		await l.tx({ amountMinor: 70, occurredOn: TODAY });
		const r = await flowOf(p, `/alur-uang?y=${TODAY.slice(0, 4)}`);
		expect([r.to, r.partial]).toEqual([TODAY, true]);
		const lap = await laporanReport(db, p.scope.spaceId, TODAY, {
			mode: 'tahun',
			year: TODAY.slice(0, 4),
			direction: 'keluar'
		});
		expect(r.outMinor).toBe(lap.stats[0]!.outMinor);
		expect(r.outMinor).toBe(970);
	});
});

describe('WIB boundaries (AC 10, pre-handoff month-boundary probe)', () => {
	it('23:30 WIB on 31 Dec and 00:30 WIB on 1 Jan fall in their own year, quarter and month; so do the quarter edges', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const pairs: [string, string, number, number][] = [
			['2024-12-31', '2025-01-01', 1, 2],
			['2025-03-31', '2025-04-01', 4, 8],
			['2025-06-30', '2025-07-01', 16, 32],
			['2025-09-30', '2025-10-01', 64, 128],
			['2025-12-31', '2026-01-01', 256, 512]
		];
		for (const [last, first, a, b] of pairs) {
			await l.tx({ occurredOn: last, occurredTime: '23:30', amountMinor: a });
			await l.tx({ occurredOn: first, occurredTime: '00:30', amountMinor: b });
		}
		// The 00:30 WIB row is stored at 17:30 UTC of the day before: a UTC bucketing would move it back.
		const raw = await d1
			.prepare(
				`select occurred_at as at from transactions where space_id = ? and occurred_on = '2026-01-01'`
			)
			.bind(p.scope.spaceId)
			.first<{ at: number }>();
		expect(new Date(raw!.at).toISOString()).toBe('2025-12-31T17:30:00.000Z');

		const out = async (url: string) => (await flowOf(p, url)).outMinor;
		expect(await out('/alur-uang?y=2025')).toBe(2 + 4 + 8 + 16 + 32 + 64 + 128 + 256);
		expect(await out('/alur-uang?y=2026')).toBe(512);
		expect(await out('/alur-uang?k=2025-Q1')).toBe(2 + 4);
		expect(await out('/alur-uang?k=2025-Q2')).toBe(8 + 16);
		expect(await out('/alur-uang?k=2025-Q3')).toBe(32 + 64);
		expect(await out('/alur-uang?k=2025-Q4')).toBe(128 + 256);
		expect(await out('/alur-uang?k=2026-Q1')).toBe(512);
		expect(await out('/alur-uang?p=2025-12')).toBe(256);
		expect(await out('/alur-uang?p=2026-01')).toBe(512);
		const year = await flowOf(p, '/alur-uang?y=2025');
		expect(year.months!.find((m) => m.month === '2025-12')?.outMinor).toBe(256);
		expect(year.months!.find((m) => m.month === '2025-01')?.outMinor).toBe(2);
	});
});

describe('folding, averages, comparison and currencies (AC 11–14)', () => {
	it('9 expense categories in a quarter: 7 + "Lainnya" with the exact rest; the month shows all 9', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const nine = l.expenseCats.slice(0, 9);
		expect(nine).toHaveLength(9);
		for (const [i, categoryId] of nine.entries())
			await l.tx({ categoryId, amountMinor: 1_000 + i * 11, occurredOn: '2025-08-15' });
		const q = await flowOf(p, '/alur-uang?k=2025-Q3');
		expect(q.expense).toHaveLength(8);
		const folded = q.expense.find((n) => n.categoryId === FOLDED_ID)!;
		expect(folded.minor).toBe(1_000 + 1_011);
		expect(sum(q.expense.map((n) => n.minor))).toBe(q.outMinor);
		const month = await flowOf(p, '/alur-uang?p=2025-08');
		expect(month.expense).toHaveLength(9);
		expect(month.outMinor).toBe(q.outMinor);
	});

	it('average per month is floor(total / months so far)', async () => {
		const { p } = await q3();
		const r = await flowOf(p, '/alur-uang?k=2025-Q3');
		expect(r.average).toEqual({
			inMinor: Math.floor(9_500_004 / 3),
			outMinor: Math.floor(11_009 / 3),
			months: 3
		});
		const current = await flowOf(
			p,
			'/alur-uang?k=' +
				TODAY.slice(0, 4) +
				'-Q' +
				(Math.floor((Number(TODAY.slice(5, 7)) - 1) / 3) + 1)
		);
		expect(current.average?.months).toBe(periodDates(current.period, TODAY).elapsedMonths);
		expect((await flowOf(p, '/alur-uang?p=2025-08')).average).toBeNull();
	});

	it('a total past Number.MAX_SAFE_INTEGER: null total, average and comparison, never rounded', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const big = 2 ** 52;
		await d1.prepare('PRAGMA ignore_check_constraints = ON').run();
		try {
			for (const [i, on] of ['2025-07-10', '2025-08-10'].entries())
				await d1
					.prepare(
						`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
							title, occurred_on, occurred_at, created_at, updated_at, seq)
						values (?, ?, 'expense', ?, 'IDR', ?, ?, 'Besar', ?, 0, 0, 0, 1)`
					)
					.bind(`big-${p.scope.spaceId}-${i}`, p.scope.spaceId, big, l.cat('kopi'), l.bca, on)
					.run();
		} finally {
			await d1.prepare('PRAGMA ignore_check_constraints = OFF').run();
		}
		const r = await flowOf(p, '/alur-uang?k=2025-Q3');
		expect(r.outMinor).toBeNull();
		expect(r.average?.outMinor).toBeNull();
		expect(r.comparison!.diff.outMinor).toBeNull();
		expect(r.months!.map((m) => m.outMinor)).toEqual([big, big, 0]);
	});

	it('the comparison is the rupiah difference with the previous period; no rows there says so', async () => {
		const { p } = await q3();
		const r = await flowOf(p, '/alur-uang?k=2025-Q3');
		expect(r.comparison).toMatchObject({
			previous: { kind: 'kuartal', year: '2025', quarter: 2 },
			from: '2025-04-01',
			to: '2025-06-30',
			cut: false,
			hasRows: true,
			previousTotals: { inMinor: 0, outMinor: 4_000, netMinor: -4_000 },
			diff: { inMinor: 9_500_004, outMinor: 11_009 - 4_000, netMinor: 9_500_004 - 11_009 + 4_000 }
		});
		const first = await flowOf(p, '/alur-uang?k=2025-Q2');
		expect(first.comparison!.hasRows).toBe(false);
		const running = await flowOf(p, `/alur-uang?y=${TODAY.slice(0, 4)}`);
		expect(running.comparison!.cut).toBe(TODAY.slice(5) !== '12-31');
	});

	it('two currencies: one is drawn; the other is named and never added into a total, average or comparison', async () => {
		const { p, l } = await q3();
		await l.tx({ walletId: l.wise, currency: 'USD', amountMinor: 999, occurredOn: '2025-08-01' });
		await l.tx({ walletId: l.wise, currency: 'USD', amountMinor: 5, occurredOn: '2025-05-01' });
		const r = await flowOf(p, '/alur-uang?k=2025-Q3');
		expect(r.currency).toBe('IDR');
		expect([r.otherCurrencies, r.otherCount]).toEqual([['USD'], 1]);
		expect(r.outMinor).toBe(11_009);
		expect(r.comparison!.previousTotals.outMinor).toBe(4_000);
		expect(r.average?.outMinor).toBe(Math.floor(11_009 / 3));
	});
});

describe('only income and expense count (AC 15, 16)', () => {
	it('transfers, adjustments, a merged transfer pair, deleted and demo rows add nothing anywhere', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ amountMinor: 100, occurredOn: '2025-08-01' });
		await l.tx({
			type: 'transfer',
			amountMinor: 7_000,
			categoryId: null,
			transferToWalletId: l.gopay,
			occurredOn: '2025-08-02'
		});
		const insert = (id: string, type: string, deleted: boolean, demo: boolean, amount: number) =>
			d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
						title, occurred_on, occurred_at, created_at, updated_at, deleted_at, is_demo, seq,
						adjustment_direction, transfer_to_wallet_id)
					values (?, ?, ?, ?, 'IDR', ?, ?, ?, '2025-08-03', 0, 0, 0, ?, ?, 1, ?, ?)`
				)
				.bind(
					`${id}-${p.scope.spaceId}`,
					p.scope.spaceId,
					type,
					deleted ? null : amount,
					type === 'expense' || type === 'income' ? (deleted ? null : l.cat('kopi')) : null,
					l.bca,
					deleted ? null : 'x',
					deleted ? 1 : null,
					demo ? 1 : 0,
					type === 'adjustment' ? 'up' : null,
					type === 'transfer' ? l.gopay : null
				);
		await d1.prepare('PRAGMA ignore_check_constraints = ON').run();
		try {
			await insert('adj', 'adjustment', false, false, 50_000).run();
			// FN-48c merged pair: the debit row became a transfer, the credit row is a tombstone.
			await insert('merged-debit', 'transfer', false, false, 20_000).run();
			await insert('merged-credit', 'income', true, false, 20_000).run();
			await insert('deleted', 'expense', true, false, 30_000).run();
			await insert('demo', 'expense', false, true, 40_000).run();
		} finally {
			await d1.prepare('PRAGMA ignore_check_constraints = OFF').run();
		}
		for (const url of ['/alur-uang?k=2025-Q3', '/alur-uang?y=2025', '/alur-uang?p=2025-08']) {
			const r = await flowOf(p, url);
			expect([r.inMinor, r.outMinor]).toEqual([0, 100]);
			expect(r.comparison!.current).toMatchObject({ inMinor: 0, outMinor: 100 });
			if (r.months) expect(sum(r.months.map((m) => m.outMinor))).toBe(100);
		}
		const next = await flowOf(p, '/alur-uang?k=2025-Q4');
		expect(next.comparison!.previousTotals.outMinor).toBe(100);
	});

	it('a future-dated row is in its month view, not in the running quarter or year', async () => {
		const tomorrow = addDays(TODAY, 1);
		if (monthOf(tomorrow) !== monthOf(TODAY)) return; // the last day of a month: nothing to show
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ amountMinor: 10, occurredOn: TODAY });
		await l.tx({ amountMinor: 5, occurredOn: tomorrow });
		const quarter = await flowOf(
			p,
			`/alur-uang?k=${TODAY.slice(0, 4)}-Q${Math.floor((Number(TODAY.slice(5, 7)) - 1) / 3) + 1}`
		);
		const year = await flowOf(p, `/alur-uang?y=${TODAY.slice(0, 4)}`);
		const month = await flowOf(p, '/alur-uang');
		expect([quarter.outMinor, year.outMinor, month.outMinor]).toEqual([10, 10, 15]);
		// The month's comparison stops at today, like with like.
		expect(month.comparison!.current.outMinor).toBe(10);
	});
});

describe('bounded work (AC 18, 39)', () => {
	it('20,000 rows in a year: /alur-uang?y= runs 4 statements, all aggregates', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await d1
			.prepare(
				`with recursive k(i) as (select 0 union all select i + 1 from k where i < 19999)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					title, occurred_on, occurred_at, created_at, updated_at, seq)
				select 'bulk-' || ? || '-' || i, ?, case when i % 10 = 0 then 'income' else 'expense' end, 100 + i % 7,
					'IDR', ?, ?, 'Bulk', date('2025-01-01', '+' || (i % 365) || ' days'), 0, 0, 0, 1 from k`
			)
			.bind(p.scope.spaceId, p.scope.spaceId, l.cat('kopi'), l.bca)
			.run();
		const sqls: string[] = [];
		const counted = countStatements(
			new Proxy(d1, {
				get(target, prop) {
					if (prop === 'prepare')
						return (q: string) => {
							sqls.push(q);
							return target.prepare(q);
						};
					const v = Reflect.get(target, prop) as unknown;
					return typeof v === 'function' ? v.bind(target) : v;
				}
			})
		);
		const r = await moneyFlowReport(
			getDb(counted.d1),
			p.scope.spaceId,
			{ kind: 'tahun', year: '2025' },
			TODAY
		);
		expect(counted.statements()).toBe(4);
		expect(r.months).toHaveLength(12);
		expect(sum(r.months!.map((m) => m.outMinor))).toBe(r.outMinor);
		// Every statement over transactions aggregates in SQL (no raw row load).
		for (const q of sqls.filter((s) => s.includes('from transactions')))
			expect(q).toMatch(/group by/);
	});

	it('more groups than MONEY_FLOW_MAX_GROUPS in a quarter: truncated is said', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await d1
			.prepare(
				`with recursive k(i) as (select 0 union all select i + 1 from k where i < 1000)
				insert into categories (id, space_id, kind, name, tile_key, is_preset, is_hidden, sort_order,
					created_at, updated_at, seq)
				select 'qc-' || ? || '-' || i, ?, 'expense', 'Kategori ' || i, 'lain', 0, 0, 100 + i, 0, 0, 1 from k`
			)
			.bind(p.scope.spaceId, p.scope.spaceId)
			.run();
		await d1
			.prepare(
				`with recursive k(i) as (select 0 union all select i + 1 from k where i < 1000)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					title, occurred_on, occurred_at, created_at, updated_at, seq)
				select 'qt-' || ? || '-' || i, ?, 'expense', 1000 + i, 'IDR', 'qc-' || ? || '-' || i, ?, 'Uji',
					'2025-08-01', 0, 0, 0, 1 from k`
			)
			.bind(p.scope.spaceId, p.scope.spaceId, p.scope.spaceId, l.bca)
			.run();
		const r = await flowOf(p, '/alur-uang?k=2025-Q3');
		expect(r.truncated).toBe(true);
		expect(r.expense).toHaveLength(8);
		expect(r.lists.expense.links).toHaveLength(8); // one wallet: one link per (folded) category
	});

	it('a past year of the net-worth report runs 2 statements and reads no price cache or wallet sum', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		void l;
		for (let i = 0; i < 366; i++)
			await upsertSnapshot(db, p.scope.spaceId, addDays('2024-01-01', i), 1_000 + i, NOW);
		const counted = countStatements(d1);
		const r = await netWorthPeriodReport(
			getDb(counted.d1),
			p.scope.spaceId,
			{ kind: 'tahun', year: '2024' },
			TODAY,
			null
		);
		expect(counted.statements()).toBe(2);
		expect(r.points).toHaveLength(13);
		expect(r.closing).toMatchObject({ date: '2024-12-31', minor: 1_365 });
		// Through the route: the access check plus those 2, and no KV read.
		const gets = vi.spyOn(kv.kv, 'get');
		const access = countStatements(d1);
		const ev = await event(
			p,
			'kekayaan/laporan',
			'/kekayaan/laporan?y=2024',
			undefined,
			getDb(access.d1)
		);
		await currentSpaceScope((ev as { locals: App.Locals }).locals);
		const accessOnly = access.statements();
		const all = countStatements(d1);
		const res = await run(async () =>
			nwPage.load(
				await event(p, 'kekayaan/laporan', '/kekayaan/laporan?y=2024', undefined, getDb(all.d1))
			)
		);
		expect(res.kind).toBe('ok');
		expect(all.statements()).toBe(accessOnly + 2);
		expect(gets).not.toHaveBeenCalled();
		gets.mockRestore();
		expect(D1_STATEMENTS_PER_INVOCATION).toBeGreaterThan(accessOnly + 2);
	});
});

describe('/kekayaan/laporan from stored snapshots (AC 19, 24, 26, 27, 29, 30, 38)', () => {
	it('Q3 from 30 Jun … 30 Sep snapshots; the group split needs classes at both ends', async () => {
		const p = await person();
		const JT = 100_000_000;
		await upsertSnapshot(db, p.scope.spaceId, '2025-06-30', 100 * JT, NOW);
		await upsertSnapshot(
			db,
			p.scope.spaceId,
			'2025-07-31',
			110 * JT,
			NOW,
			false,
			'{"wallets":11000000000}'
		);
		await upsertSnapshot(db, p.scope.spaceId, '2025-08-31', 120 * JT, NOW);
		await upsertSnapshot(
			db,
			p.scope.spaceId,
			'2025-09-30',
			130 * JT,
			NOW,
			false,
			JSON.stringify({ wallets: 100 * JT, gold: 40 * JT, debt: -10 * JT })
		);
		const r = await nwOf(p, '/kekayaan/laporan?k=2025-Q3');
		expect(r.opening).toEqual({ minor: 100 * JT, date: '2025-06-30', basis: 'exact' });
		expect(r.closing).toMatchObject({ minor: 130 * JT, date: '2025-09-30', live: false });
		expect(r.changeMinor).toBe(30 * JT);
		expect(r.points.map((x) => x.minor)).toEqual([100 * JT, 110 * JT, 120 * JT, 130 * JT]);
		expect(r.groups).toBeNull();
		expect(r.groupsSince).toBe('2025-07-31');
		// Opened on 31 Jul (with classes) the split exists and adds up.
		const aug = await nwOf(p, '/kekayaan/laporan?p=2025-08');
		expect(aug.opening?.date).toBe('2025-07-31');
		expect(aug.groups).toBeNull(); // the 31 Aug closing has no classes
		const sep = await nwOf(p, '/kekayaan/laporan?p=2025-09');
		expect(sep.opening).toMatchObject({ date: '2025-08-31' });
		expect(sep.groups).toBeNull();
	});

	it('the default is the current quarter; it closes with the live total, equal to the Kekayaan hero', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({
			type: 'income',
			amountMinor: 5_000_000,
			categoryId: l.cat('gaji'),
			occurredOn: TODAY
		});
		await createNetWorthItem(
			db,
			p.scope,
			{
				kind: 'property',
				name: 'Rumah',
				currency: 'IDR',
				priceSource: 'manual',
				priceSymbol: null,
				quantityScaled: null,
				quantityScale: null,
				manualValueMinor: 1_000_000_00,
				acquiredOn: '2020-01-15',
				note: null
			},
			NOW
		);
		const r = await nwOf(p, '/kekayaan/laporan');
		expect(r.period.kind).toBe('kuartal');
		expect(r.partial).toBe(true);
		const k = await run(async () =>
			kekayaanPage.load(
				fakeEvent({
					url: 'http://localhost/kekayaan',
					routeId: '/(app)/kekayaan',
					db,
					user: p.user,
					space: await resolveCurrentSpace(db, p.user.id, undefined)
				}).event as never
			)
		);
		const hero = (k.value as { netWorth: { summary: { totalMinor: number } } }).netWorth.summary
			.totalMinor;
		expect(r.closing).toMatchObject({ minor: hero, date: TODAY, live: true });
		expect(hero).toBe(5_000_000 + 1_000_000_00);
		// A KV outage still renders, with manual values.
		kv.state.failing = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect((await nwOf(p, '/kekayaan/laporan')).closing?.minor).toBe(hero);
		} finally {
			kv.state.failing = false;
			warn.mockRestore();
		}
	});

	it('the jobs tick stores summary.classes; a later partial run never overwrites a complete day', async () => {
		const p = await person();
		await ensurePresetCategories(db, p.scope.spaceId, NOW);
		const w = await createWallet(
			db,
			p.scope,
			{
				name: 'BCA',
				type: 'bank',
				currency: 'IDR',
				openingBalanceMinor: 6_000,
				isFavourite: false,
				lastFour: null
			},
			NOW
		);
		if (!w.ok) throw new Error('wallet failed');
		const at = Date.UTC(2026, 0, 5, 3, 0);
		const statementsLeft = () => D1_STATEMENTS_PER_INVOCATION;
		for (let i = 0; i < 3; i++) await writeSnapshots(db, emptyPriceBook(), at + i, statementsLeft);
		const row = await d1
			.prepare(
				`select total_minor as t, partial, classes from net_worth_snapshots where space_id = ? and date = '2026-01-05'`
			)
			.bind(p.scope.spaceId)
			.first<{ t: number; partial: number; classes: string }>();
		expect(row).toEqual({ t: 6_000, partial: 0, classes: '{"wallets":6000}' });
		await upsertSnapshot(db, p.scope.spaceId, '2026-01-05', 1, at + 10, true, '{"wallets":1}');
		const after = await d1
			.prepare(
				`select total_minor as t, classes from net_worth_snapshots where space_id = ? and date = '2026-01-05'`
			)
			.bind(p.scope.spaceId)
			.first();
		expect(after).toEqual({ t: 6_000, classes: '{"wallets":6000}' });
		// The check refuses a non-object and a tombstone with classes.
		await expect(
			upsertSnapshot(db, p.scope.spaceId, '2026-01-06', 1, at, false, '[1]')
		).rejects.toThrow(/CHECK/);
	});

	it('foreign holdings: the caption’s rate dates come from the live total; none without them', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({
			type: 'income',
			walletId: l.wise,
			currency: 'USD',
			amountMinor: 1_000,
			categoryId: l.cat('gaji'),
			occurredOn: TODAY
		});
		const book = emptyPriceBook();
		book.fx.set('USD', {
			rate: parseDecimal('16000', 8)!,
			text: '16000',
			date: '2026-10-12',
			at: NOW
		});
		const q: ReportPeriod = { kind: 'tahun', year: TODAY.slice(0, 4) };
		const live = await liveNetWorth(db, p.scope.spaceId, book, NOW);
		const r = await netWorthPeriodReport(db, p.scope.spaceId, q, TODAY, live);
		expect(r.rates).toEqual([{ currency: 'USD', rate: '16000', date: '2026-10-12' }]);
		// The stored IDR figure: $10.00 at Rp 16.000 is Rp 160.000; nothing else is converted here.
		expect(r.closing?.minor).toBe(160_000_00);
		// Without a rate the USD wallet is left out (partial), and no caption is shown.
		const none = await liveNetWorth(db, p.scope.spaceId, emptyPriceBook(), NOW);
		expect(none.rates).toEqual([]);
		expect((await netWorthPeriodReport(db, p.scope.spaceId, q, TODAY, none)).rates).toBeNull();
		// A past period never shows the caption (no live value).
		expect(
			(
				await netWorthPeriodReport(
					db,
					p.scope.spaceId,
					{ kind: 'tahun', year: '2025' },
					TODAY,
					null
				)
			).rates
		).toBeNull();
	});

	it('only Data demo items: the empty state with the badge, no demo figure', async () => {
		const p = await person();
		const r = await createNetWorthItem(
			db,
			p.scope,
			{
				kind: 'property',
				name: 'Rumah demo',
				currency: 'IDR',
				priceSource: 'manual',
				priceSymbol: null,
				quantityScaled: null,
				quantityScale: null,
				manualValueMinor: 9_999_00,
				acquiredOn: '2020-01-15',
				note: null
			},
			NOW
		);
		if (!r.ok) throw new Error('item failed');
		await d1
			.prepare('update net_worth_items set is_demo = 1 where space_id = ?')
			.bind(p.scope.spaceId)
			.run();
		const report = await nwOf(p, '/kekayaan/laporan');
		expect(report).toMatchObject({ empty: true, hasDemo: true, closing: { minor: 0 } });
		expect(JSON.stringify(report)).not.toContain('999900');
	});

	it('a hidden Kekayaan module still answers (FN-12)', async () => {
		const p = await person();
		await setFeatureFlag(db, p.user.id, 'kekayaan', false, NOW);
		const r = await run(async () =>
			nwPage.load(await event(p, 'kekayaan/laporan', '/kekayaan/laporan'))
		);
		expect(r.kind).toBe('ok');
	});
});

describe('access across users, spaces and a removed member (AC 31, 32; cross-space probe)', () => {
	async function shared() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const l = await ledger({ spaceId, userId: owner.user.id });
		await l.tx({ amountMinor: 4_242, title: 'Belanja keluarga', occurredOn: '2025-08-15' });
		await upsertSnapshot(db, spaceId, '2025-09-30', 777_777, NOW, false, '{"wallets":777777}');
		return { owner, member, spaceId };
	}
	const urls = (route: 'alur-uang' | 'kekayaan/laporan') => [
		`/${route}?p=2025-08`,
		`/${route}?k=2025-Q3`,
		`/${route}?y=2025`
	];

	it('a member sees the same figures as the owner in every period kind', async () => {
		const { owner, member, spaceId } = await shared();
		for (const url of urls('alur-uang'))
			expect(await flowOf(member, url, spaceId)).toEqual(await flowOf(owner, url, spaceId));
		for (const url of urls('kekayaan/laporan'))
			expect(await nwOf(member, url, spaceId)).toEqual(await nwOf(owner, url, spaceId));
		expect((await flowOf(member, '/alur-uang?k=2025-Q3', spaceId)).outMinor).toBe(4_242);
	});

	it('another user (their own space; naming the shared one in the URL) never sees its rows or snapshots', async () => {
		const { spaceId } = await shared();
		const stranger = await person('Orang lain');
		const sl = await ledger(stranger.scope);
		await sl.tx({ amountMinor: 13, title: 'Milik sendiri', occurredOn: '2025-08-15' });
		for (const url of urls('alur-uang')) {
			const r = await flowOf(stranger, `${url}&space=${spaceId}&spaceId=${spaceId}`, spaceId);
			expect(r.outMinor).toBe(13);
			expect(JSON.stringify(r)).not.toContain('4242');
		}
		for (const url of urls('kekayaan/laporan')) {
			const r = await nwOf(stranger, `${url}&space=${spaceId}`, spaceId);
			expect(JSON.stringify(r)).not.toContain('777777');
			expect(r.closing).toBeNull();
		}
	});

	it('a removed member: a stale locals.space is 404 like every route; signed out is /masuk', async () => {
		const { owner, member, spaceId } = await shared();
		const stale = await resolveCurrentSpace(db, member.user.id, spaceId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const ev = (route: string, url: string) =>
			fakeEvent({
				url: `http://localhost${url}`,
				routeId: `/(app)/${route}`,
				db,
				user: member.user,
				space: stale
			}).event as never;
		const laporan = await import('../../src/routes/(app)/laporan/+page.server');
		const reference = await run(async () => laporan.load(ev('laporan', '/laporan')));
		expect(reference).toMatchObject({ kind: 'error', status: 404 });
		for (const url of urls('alur-uang'))
			expect(await run(async () => flowPage.load(ev('alur-uang', url)))).toEqual(reference);
		for (const url of urls('kekayaan/laporan'))
			expect(await run(async () => nwPage.load(ev('kekayaan/laporan', url)))).toEqual(reference);
		// Back on their own space, nothing of the shared one.
		expect(
			JSON.stringify(await nwOf(member, '/kekayaan/laporan?k=2025-Q3', spaceId))
		).not.toContain('777777');
		for (const page of [flowPage, nwPage])
			expect(
				await run(async () => page.load(await event(null, 'alur-uang', '/alur-uang')))
			).toMatchObject({
				kind: 'redirect',
				status: 303,
				location: '/masuk'
			});
	});
});

describe('states and copy (AC 17, 33, 37)', () => {
	it('a failing query shows the fixed error text, never SQL, a path or an id', async () => {
		const p = await person();
		const space = await resolveCurrentSpace(db, p.user.id, undefined);
		const failing = new Proxy(db, {
			get: (target, prop) =>
				prop === 'all'
					? () =>
							Promise.reject(new Error(`D1_ERROR: boom at /src/lib/server/x.ts ${p.scope.spaceId}`))
					: Reflect.get(target, prop)
		});
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const [page, route, text] of [
			[flowPage, 'alur-uang', 'Alur uang tidak bisa dimuat. Coba lagi sebentar lagi.'],
			[nwPage, 'kekayaan/laporan', 'Laporan kekayaan tidak bisa dimuat. Coba lagi sebentar lagi.']
		] as const) {
			const r = await run(async () =>
				page.load(
					fakeEvent({ url: `http://localhost/${route}?y=2025`, db: failing, user: p.user, space })
						.event as never
				)
			);
			expect(r).toMatchObject({ kind: 'ok', value: { report: null, loadError: text } });
			expect(JSON.stringify(r)).not.toMatch(/D1_ERROR|\/src\/|select /);
		}
		expect(JSON.stringify(spy.mock.calls)).not.toContain('D1_ERROR');
		expect(JSON.stringify(spy.mock.calls)).not.toContain(p.scope.spaceId);
		spy.mockRestore();
	});

	it('an empty quarter: zeros, no node, no NaN', async () => {
		const p = await person();
		const r = await flowOf(p, '/alur-uang?k=2025-Q3');
		expect([r.inMinor, r.outMinor, r.links.length]).toEqual([0, 0, 0]);
		expect(r.average).toEqual({ inMinor: 0, outMinor: 0, months: 3 });
		expect(JSON.stringify(r)).not.toContain('NaN');
		expect((await nwOf(p, '/kekayaan/laporan?k=2025-Q3')).empty).toBe(true);
	});

	it('both pages mask amounts from the first server render (applyAmountsHiddenAtLoad)', () => {
		for (const file of [
			'src/routes/(app)/alur-uang/+page.svelte',
			'src/routes/(app)/kekayaan/laporan/+page.svelte'
		])
			expect(readFileSync(file, 'utf8'), file).toContain('applyAmountsHiddenAtLoad();');
	});
});

describe('the 2000 floor (red team L1)', () => {
	it('every kind at the floor loads, with no previous period instead of the error state', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ amountMinor: 321, occurredOn: '2000-01-15' });
		for (const url of [
			'/alur-uang?y=2000',
			'/alur-uang?k=2000-Q1',
			'/alur-uang?p=2000-01',
			'/alur-uang?y=0000',
			'/alur-uang?k=1999-Q4',
			'/alur-uang?k=2000-Q1&m=tahun'
		]) {
			const r = await flowOf(p, url);
			expect(r.outMinor, url).toBe(321);
			expect(r.comparison, url).toBeNull();
		}
		expect((await flowOf(p, '/alur-uang?k=2000-Q2')).comparison).toMatchObject({
			hasRows: true,
			previousTotals: { outMinor: 321 }
		});
	});
});
