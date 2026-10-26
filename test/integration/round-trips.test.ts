import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { signInWithPassword } from '#lib/server/auth/password';
import { createPasswordSession } from '#lib/server/auth/session';
import { setBudget } from '#lib/server/budgets/repo';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { addContribution } from '#lib/server/goals/contributions';
import { createGoal } from '#lib/server/goals/repo';
import { createNetWorthItem } from '#lib/server/net-worth/repo';
import { evaluateBudget } from '#lib/server/notifications/triggers';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { createSubscription } from '#lib/server/subscriptions/repo';
import { createTransaction } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { addDays, wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { meteredD1 } from '../helpers/d1-meter';
import { fakeEvent } from '../helpers/event';
import { fakeKv } from '../helpers/kv';

// What one signed-in request costs against D1 on the hot paths: round trips, statements prepared and the longest
// chain of sequential round trips (each round trip waits LATENCY_MS, as the network hop of a deployed Worker
// would). The ceilings (CEILING) are the measured figures: a change that adds a round trip or a sequential await
// fails here.
const LATENCY_MS = 20;

const binding: { DB?: D1Database; CACHE?: KVNamespace; APP_VERSION?: string } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const layout = await import('../../src/routes/(app)/+layout.server');
const beranda = await import('../../src/routes/(app)/+page.server');
const riwayat = await import('../../src/routes/(app)/riwayat/+page.server');
const dompet = await import('../../src/routes/(app)/dompet/+page.server');
const laporan = await import('../../src/routes/(app)/laporan/+page.server');
const kekayaan = await import('../../src/routes/(app)/kekayaan/+page.server');
const anggaran = await import('../../src/routes/(app)/anggaran/+page.server');

let d1: D1Database;
let db: Db;
let meter: ReturnType<typeof meteredD1>;
let metered: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = Date.now();

const who = {} as {
	user: NonNullable<App.Locals['user']>;
	scope: SpaceScope;
	token: string;
};

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
	binding.CACHE = fakeKv().kv;
	binding.APP_VERSION = '0.0.0-test';
	const email = 'meter@contoh.id';
	const r = await signUp(
		db,
		{ name: 'Meter', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('sign-up failed');
	const spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const scope: SpaceScope = { spaceId, userId: r.userId };
	const proof = await signInWithPassword(db, email, PASSWORD, NOW);
	if (!proof.ok) throw new Error('sign-in failed');
	const session = await createPasswordSession(db, r.userId, proof.hash, NOW);
	if (!session) throw new Error('session failed');
	Object.assign(who, {
		user: { id: r.userId, email, name: 'Meter', createdAt: NOW },
		scope,
		token: session.token
	});

	// A lived-in space: presets, a bank wallet, a card, 120 rows over 60 days, a budget, a goal with a
	// contribution, a subscription and a manual net-worth item.
	await ensurePresetCategories(db, spaceId, NOW);
	const cats = await listCategories(db, spaceId);
	const expense = cats
		.filter((c) => c.kind === 'expense' && c.tileKey !== 'transfer')
		.map((c) => c.id);
	const income = cats.find((c) => c.kind === 'income' && c.tileKey !== 'transfer')!.id;
	const wallet = async (name: string, type: 'bank' | 'kartu_kredit') => {
		const w = await createWallet(
			db,
			scope,
			{
				name,
				type,
				currency: 'IDR',
				openingBalanceMinor: 1_000_000_00,
				isFavourite: type === 'bank',
				lastFour: null,
				creditLimitMinor: type === 'kartu_kredit' ? 20_000_000_00 : null,
				statementDay: type === 'kartu_kredit' ? 25 : null,
				dueDay: type === 'kartu_kredit' ? 12 : null
			},
			NOW
		);
		if (!w.ok) throw new Error('wallet failed');
		return w.id;
	};
	const bank = await wallet('BCA', 'bank');
	const card = await wallet('Kartu', 'kartu_kredit');
	const today = wibTodayString(NOW);
	for (let i = 0; i < 120; i++) {
		const t = await createTransaction(
			db,
			scope,
			{
				type: i % 10 === 0 ? 'income' : 'expense',
				amountMinor: 25_000_00 + i * 100,
				currency: 'IDR',
				walletId: i % 3 === 0 ? card : bank,
				transferToWalletId: null,
				categoryId: i % 10 === 0 ? income : expense[i % expense.length]!,
				title: `Toko ${i % 7}`,
				note: null,
				occurredOn: addDays(today, -(i % 60)),
				occurredTime: null
			},
			NOW
		);
		if (!t.ok) throw new Error(`transaction failed: ${JSON.stringify(t)}`);
	}
	await setBudget(db, scope, { amountMinor: 5_000_000_00, currency: 'IDR' }, null, NOW);
	const goal = await createGoal(
		db,
		scope,
		{ name: 'Liburan', targetAmountMinor: 10_000_000_00 },
		NOW
	);
	if (!goal.ok) throw new Error('goal failed');
	await addContribution(db, scope, goal.id, { amountMinor: 1_000_000_00, note: null }, NOW);
	await createSubscription(
		db,
		scope,
		{
			catalogueId: null,
			name: 'Musik',
			category: 'streaming',
			amountMinor: 5_499_000,
			currency: 'IDR',
			schedule: { cycle: 'monthly', day: 1, month: null },
			walletId: null,
			reminderDaysBefore: 1
		},
		today,
		NOW
	);
	await createNetWorthItem(
		db,
		scope,
		{
			kind: 'property',
			name: 'Rumah',
			currency: 'IDR',
			priceSource: 'manual',
			priceSymbol: null,
			quantityScaled: null,
			quantityScale: null,
			manualValueMinor: 500_000_000_00,
			acquiredOn: '2020-01-15',
			note: null
		},
		NOW
	);

	meter = meteredD1(d1, LATENCY_MS);
	metered = getDb(meter.d1);
});
afterAll(() => dispose());

async function pageEvent(path: string, routeId: string) {
	const space = await resolveCurrentSpace(db, who.user.id, undefined);
	return fakeEvent({
		url: `http://localhost${path}`,
		routeId,
		db: metered,
		user: who.user,
		space
	}).event as never;
}

type Load = (event: never) => unknown;

const cases: [name: string, path: string, routeId: string, load: Load][] = [
	['(app) layout', '/', '/(app)', layout.load as Load],
	['Beranda', '/', '/(app)', beranda.load as Load],
	['Riwayat', '/riwayat', '/(app)/riwayat', riwayat.load as Load],
	['Dompet', '/dompet', '/(app)/dompet', dompet.load as Load],
	['Laporan (bulan)', '/laporan', '/(app)/laporan', laporan.load as Load],
	['Laporan (tahun)', '/laporan?m=tahun', '/(app)/laporan', laporan.load as Load],
	['Kekayaan', '/kekayaan', '/(app)/kekayaan', kekayaan.load as Load],
	['Anggaran', '/anggaran', '/(app)/anggaran', anggaran.load as Load]
];

/**
 * The measured cost of each request on the seeded space: round trips, statements and the longest chain of
 * sequential round trips. A change may lower these (then lower the ceiling), never raise them unnoticed.
 */
const CEILING: Record<string, { trips: number; statements: number; depth: number }> = {
	'hooks.server.ts': { trips: 2, statements: 3, depth: 2 },
	'jobs budget_check': { trips: 2, statements: 2, depth: 1 },
	'(app) layout': { trips: 1, statements: 1, depth: 1 },
	Beranda: { trips: 10, statements: 10, depth: 2 },
	Riwayat: { trips: 6, statements: 7, depth: 2 },
	Dompet: { trips: 7, statements: 7, depth: 3 },
	'Laporan (bulan)': { trips: 7, statements: 7, depth: 3 },
	'Laporan (tahun)': { trips: 7, statements: 7, depth: 2 },
	Kekayaan: { trips: 11, statements: 11, depth: 3 },
	Anggaran: { trips: 7, statements: 8, depth: 2 }
};

function withinCeiling(request: string, m: { trips: number; statements: number; depth: number }) {
	const c = CEILING[request]!;
	expect(m.trips, `${request} round trips`).toBeLessThanOrEqual(c.trips);
	expect(m.statements, `${request} statements`).toBeLessThanOrEqual(c.statements);
	expect(m.depth, `${request} sequential round trips`).toBeLessThanOrEqual(c.depth);
}

describe('D1 round trips per signed-in request (local D1, metered)', () => {
	const rows: Record<string, unknown>[] = [];
	// `METER_OUT=<file>` writes the measured figures as JSON (before/after evidence for a change).
	afterAll(() => {
		if (process.env.METER_OUT) writeFileSync(process.env.METER_OUT, JSON.stringify(rows, null, 1));
	});

	it('hooks.server.ts: session, plan and current space of an (app) page', async () => {
		binding.DB = meter.d1;
		try {
			const { event } = fakeEvent({
				url: 'http://localhost/',
				routeId: '/(app)',
				db,
				cookies: { financer_session: who.token }
			});
			const m = await meter.measure(async () =>
				handle({ event, resolve: async () => new Response('ok') } as never)
			);
			rows.push({ request: 'hooks.server.ts', ...m });
			withinCeiling('hooks.server.ts', m);
			expect((event as { locals: App.Locals }).locals.space).not.toBeNull();
		} finally {
			binding.DB = d1;
		}
	});

	it('hooks.server.ts: a failed plan-and-space batch reads both again on their own', async () => {
		binding.DB = new Proxy(d1, {
			get: (target, prop) =>
				prop === 'batch'
					? () => Promise.reject(new Error('D1_ERROR: batch'))
					: (Reflect.get(target, prop) as (...a: unknown[]) => unknown).bind(target)
		});
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const { event, locals } = fakeEvent({
				url: 'http://localhost/',
				routeId: '/(app)',
				db,
				cookies: { financer_session: who.token }
			});
			await handle({ event, resolve: async () => new Response('ok') } as never);
			expect(locals.space).toEqual(await resolveCurrentSpace(db, who.user.id, undefined));
			expect(locals.plan).toBe('gratis');
			expect(spy).toHaveBeenCalledWith('hooks: plan and space batch failed', 'Error');
		} finally {
			spy.mockRestore();
			binding.DB = d1;
		}
	});

	it('jobs: budget_check of one space (evaluateBudget)', async () => {
		const m = await meter.measure(() => evaluateBudget(metered, who.scope.spaceId, NOW));
		rows.push({ request: 'jobs budget_check', ...m });
		withinCeiling('jobs budget_check', m);
	});

	for (const [name, path, routeId, load] of cases)
		it(name, async () => {
			const event = await pageEvent(path, routeId);
			let out: unknown;
			const m = await meter.measure(async () => {
				out = await load(event);
			});
			rows.push({ request: name, ...m });
			withinCeiling(name, m);
			const data = out as Record<string, unknown>;
			expect(data.loadError ?? null).toBeNull();
		});
});
