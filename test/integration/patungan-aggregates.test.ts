import type { RequestHandler } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readStep, startFacts, summaryStep } from '#lib/server/agent/facts';
import { signUp } from '#lib/server/auth/accounts';
import { createApiToken } from '#lib/server/auth/api-tokens';
import { anggaranSummary } from '#lib/server/budgets/anggaran';
import { daysRemainingInclusive } from '#lib/server/budgets/math';
import { setBudget } from '#lib/server/budgets/repo';
import { snapshotBudgetDay } from '#lib/server/budgets/streak';
import { berandaSummary } from '#lib/server/budgets/summary';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { laporanReport } from '#lib/server/reports/laporan';
import { moneyFlowReport } from '#lib/server/reports/money-flow';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { FigureBook } from '#lib/server/tanya/figures';
import { makeTools } from '#lib/server/tanya/tools';
import {
	categoryMonthlyTotals,
	categoryTotals,
	dailyTotals,
	frequentManualTransactions,
	largestTransactions,
	listTransactionsByDay,
	listTransactionsForExport,
	merchantTotals,
	moneyFlowTotals,
	monthlyTotals,
	periodTotals,
	type TransactionFilter
} from '#lib/server/transactions/aggregate';
import { createTransaction } from '#lib/server/transactions/repo';
import { walletTransactionsSums } from '#lib/server/transactions/wallet-sum';
import { createWallet } from '#lib/server/wallets/repo';
import { monthOf, monthRange, wibTodayString } from '#lib/shared/dates';
import { formatMoney } from '#lib/shared/money-format';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-49 AC-6/7/19: a transaction of Rp 400.000 linked as the bill of a split whose payer's own share is
 * Rp 100.000 counts Rp 100.000 on every aggregate surface (one assertion per surface), while its stored
 * `amount_minor` stays Rp 400.000, the wallet balance still moves by the whole Rp 400.000 (the bank really paid
 * it), and the two named exceptions (CSV export, "Catat lagi") keep the raw amount. The link is written with
 * plain SQL here, so this file tests the aggregates only (patungan.test.ts drives the real create path).
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const transactionsRoute = await import('../../src/routes/api/v1/transactions/+server');
const laporanRoute = await import('../../src/routes/api/v1/laporan/ringkasan/+server');
const transactionRoute = await import('../../src/routes/api/v1/transactions/[id]/+server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.now();
const TODAY = wibTodayString(NOW);
const MONTH = monthOf(TODAY);
const BILL = 40_000_000; // Rp 400.000
const SHARE = 10_000_000; // Rp 100.000
const COFFEE = 15_000_000; // Rp 150.000

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function ledger(name: string) {
	const r = await signUp(
		db,
		{
			name,
			email: `agg49-${++n}@contoh.id`,
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const scope: SpaceScope = { spaceId, userId: r.userId };
	await ensurePresetCategories(db, spaceId, NOW);
	const cats = await listCategories(db, spaceId);
	const w = await createWallet(
		db,
		scope,
		{
			name: 'BCA',
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		NOW
	);
	if (!w.ok) throw new Error('wallet failed');
	const cat = (tile: string) => cats.find((c) => c.tileKey === tile)!.id;
	const tx = async (title: string, amountMinor: number, tile: string) => {
		const t = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor,
				currency: 'IDR',
				walletId: w.id,
				transferToWalletId: null,
				categoryId: cat(tile),
				title,
				note: null,
				occurredOn: TODAY,
				occurredTime: null
			},
			NOW
		);
		if (!t.ok) throw new Error('transaction failed');
		return t.id;
	};
	const bill = await tx('Makan bareng', BILL, 'makan');
	await tx('Kopi kantor', COFFEE, 'kopi');
	return { scope, walletId: w.id, bill, makan: cat('makan'), kopi: cat('kopi'), userId: r.userId };
}

/** Links `txId` as the bill of a new split of the same total whose payer's share is `share` (plain SQL). */
async function linkRaw(
	spaceId: string,
	userId: string,
	txId: string,
	total: number,
	share: number
) {
	const splitId = crypto.randomUUID();
	await d1.batch([
		d1
			.prepare(
				`insert into patungan_splits (id, space_id, created_by_user_id, payer_name, title,
					total_amount_minor, currency, occurred_on, mode, created_at, updated_at, seq)
				values (?, ?, ?, 'Uji', 'Makan bareng', ?, 'IDR', ?, 'exact', ?, ?, 1)`
			)
			.bind(splitId, spaceId, userId, total, TODAY, NOW, NOW),
		d1
			.prepare(
				`insert into patungan_participants (id, split_id, space_id, position, kind, member_user_id,
					display_name, is_payer, share_amount_minor, paid_amount_minor, paid_at, created_at, updated_at, seq)
				values (?, ?, ?, 0, 'member', ?, 'Uji', 1, ?, ?, ?, ?, ?, 1),
					(?, ?, ?, 1, 'guest', null, 'Tamu', 0, ?, 0, null, ?, ?, 1)`
			)
			.bind(
				crypto.randomUUID(),
				splitId,
				spaceId,
				userId,
				share,
				share,
				NOW,
				NOW,
				NOW,
				crypto.randomUUID(),
				splitId,
				spaceId,
				total - share,
				NOW,
				NOW
			),
		d1
			.prepare(
				`update transactions set patungan_split_id = ?, patungan_effective_amount_minor = ?
				where id = ? and space_id = ?`
			)
			.bind(splitId, share, txId, spaceId)
	]);
	return splitId;
}

const month: TransactionFilter = {
	...monthRange(MONTH),
	type: 'expense',
	categoryId: null,
	walletId: null,
	q: null
};
const out = (totals: readonly { currency: string; outMinor: number | null }[]) =>
	totals.find((t) => t.currency === 'IDR')?.outMinor;

let a: Awaited<ReturnType<typeof ledger>>;
let b: Awaited<ReturnType<typeof ledger>>;
let splitId: string;

beforeAll(async () => {
	a = await ledger('Ayu');
	// A second user and space with the very same rows, unlinked: never affected by space A's link.
	b = await ledger('Bima');
	splitId = await linkRaw(a.scope.spaceId, a.userId, a.bill, BILL, SHARE);
});

describe('FN-49 effective amount on every aggregate surface', () => {
	it('keeps the stored amount, currency, source and dedupe key of the linked row', async () => {
		const row = await db.get<{
			amount_minor: number;
			currency: string;
			source: string;
			dedupe_key: string | null;
		}>(
			sql`select amount_minor, currency, source, dedupe_key from transactions where id = ${a.bill}`
		);
		expect(row).toEqual({
			amount_minor: BILL,
			currency: 'IDR',
			source: 'manual',
			dedupe_key: null
		});
	});

	it('periodTotals (Riwayat header, Beranda month): only the payer share counts', async () => {
		expect(out((await periodTotals(db, a.scope.spaceId, month)).totals)).toBe(SHARE + COFFEE);
		expect(out((await periodTotals(db, b.scope.spaceId, month)).totals)).toBe(BILL + COFFEE);
	});

	it('listTransactionsByDay: the day header counts the share, the row keeps its amount and says so', async () => {
		const page = await listTransactionsByDay(db, a.scope.spaceId, month);
		const day = page.days.find((d) => d.date === TODAY)!;
		expect(out(day.totals)).toBe(SHARE + COFFEE);
		const row = day.rows.find((r) => r.id === a.bill)!;
		expect(row.amountMinor).toBe(BILL);
		expect(row.patungan).toEqual({ splitId, effectiveAmountMinor: SHARE });
		const other = (await listTransactionsByDay(db, b.scope.spaceId, month)).days[0]!.rows;
		expect(other.every((r) => r.patungan === null)).toBe(true);
	});

	it('dailyTotals, monthlyTotals, categoryTotals, categoryMonthlyTotals', async () => {
		const day = (await dailyTotals(db, a.scope.spaceId, month)).find((d) => d.date === TODAY)!;
		expect(out(day.totals)).toBe(SHARE + COFFEE);
		const m = (await monthlyTotals(db, a.scope.spaceId, month)).find((x) => x.month === MONTH)!;
		expect(out(m.totals)).toBe(SHARE + COFFEE);
		const cat = (await categoryTotals(db, a.scope.spaceId, month)).find(
			(c) => c.category?.id === a.makan
		)!;
		expect(out(cat.totals)).toBe(SHARE);
		const cm = (await categoryMonthlyTotals(db, a.scope.spaceId, month)).find(
			(c) => c.category?.id === a.makan && c.month === MONTH
		)!;
		expect(out(cm.totals)).toBe(SHARE);
	});

	it('merchantTotals and largestTransactions rank and sum by the share', async () => {
		const merchants = await merchantTotals(db, a.scope.spaceId, month, 'IDR');
		expect(merchants.map((m) => [m.title, m.amountMinor])).toEqual([
			['Kopi kantor', COFFEE],
			['Makan bareng', SHARE]
		]);
		const largest = await largestTransactions(db, a.scope.spaceId, month, 'IDR');
		expect(largest.map((r) => r.title)).toEqual(['Kopi kantor', 'Makan bareng']);
		// Listed with its real amount; ranked by what the payer actually spent.
		expect(largest[1]!.amountMinor).toBe(BILL);
	});

	it('moneyFlowTotals and the Alur uang report', async () => {
		const flow = await moneyFlowTotals(db, a.scope.spaceId, { ...month, type: null });
		const makan = flow.rows.find((r) => r.category?.id === a.makan)!;
		expect(makan.amountMinor).toBe(SHARE);
		expect(flow.rows[0]!.category?.id).toBe(a.kopi);
		const report = await moneyFlowReport(db, a.scope.spaceId, MONTH);
		expect(report.outMinor).toBe(SHARE + COFFEE);
	});

	it('Beranda: month spending and safe-to-spend', async () => {
		const beranda = await berandaSummary(db, a.scope.spaceId, TODAY);
		expect(beranda.spentMinor).toBe(SHARE + COFFEE);
		expect(beranda.categories.find((c) => c.key === a.makan)?.minor).toBe(SHARE);
		expect(
			await setBudget(db, a.scope, { amountMinor: 100_000_000, currency: 'IDR' }, null, NOW)
		).toBe('ok');
		const after = await berandaSummary(db, a.scope.spaceId, TODAY);
		const control = await berandaSummary(db, b.scope.spaceId, TODAY);
		expect(control.spentMinor).toBe(BILL + COFFEE);
		expect(after.safeToSpend).not.toBeNull();
		const anggaran = await anggaranSummary(db, a.scope.spaceId, TODAY);
		expect(anggaran.total?.spentMinor).toBe(SHARE + COFFEE);
		expect(anggaran.total?.remainingMinor).toBe(100_000_000 - SHARE - COFFEE);
		expect(anggaran.unbudgeted.find((c) => c.categoryId === a.makan)?.spentMinor).toBe(SHARE);
	});

	it('Laporan: totals, categories, merchants and biggest expenses', async () => {
		const r = await laporanReport(db, a.scope.spaceId, TODAY, {
			mode: 'bulan',
			month: MONTH,
			direction: 'keluar'
		});
		expect(r.stats[0]!.outMinor).toBe(SHARE + COFFEE);
		expect(r.directionMinor).toBe(SHARE + COFFEE);
		expect(r.categories.find((c) => c.key === a.makan)?.minor).toBe(SHARE);
		expect(r.merchants[0]!.title).toBe('Kopi kantor');
		expect(r.largest[0]!.title).toBe('Kopi kantor');
		const year = await laporanReport(db, a.scope.spaceId, TODAY, {
			mode: 'tahun',
			year: MONTH.slice(0, 4),
			direction: 'keluar'
		});
		expect(year.directionMinor).toBe(SHARE + COFFEE);
	});

	it('Tanya tools and the Agent facts answer the same figure', async () => {
		const tools = makeTools({
			db,
			spaceId: a.scope.spaceId,
			today: TODAY,
			locale: 'id',
			book: new FigureBook('id')
		});
		const summary = JSON.parse(
			(await tools.run('spending_summary', { period: 'this_month' })).content
		);
		expect(summary.currencies[0].expense.value).toBe(
			formatMoney(SHARE + COFFEE, 'IDR', 'auto', 'id')
		);
		const facts = startFacts('monthly', MONTH, NOW);
		const read = await readStep({ db, spaceId: a.scope.spaceId, now: NOW }, facts);
		if (read === 'empty') throw new Error('empty');
		const summed = await summaryStep({ db, spaceId: a.scope.spaceId, now: NOW }, read);
		expect(summed.summary?.currencies[0]?.outMinor).toBe(SHARE + COFFEE);
	});

	it('public API: list totals and Laporan summary count the share; the row keeps its amount', async () => {
		const hash = (await db.get<{ hash: string }>(
			sql`select hash from user_passwords where user_id = ${a.userId}`
		))!.hash;
		const t = await createApiToken(
			db,
			a.userId,
			{ name: 'Skrip', scope: 'read', restrictedSpaceId: null, lifetimeDays: 90 },
			hash,
			Date.now()
		);
		if (!t.ok) throw new Error('token failed');
		const call = async (handler: RequestHandler, path: string, params?: Record<string, string>) => {
			const url = new URL(`http://localhost${path}`);
			const { event } = fakeEvent({ url: url.href, routeId: '/api/v1/x', db, params });
			(event as { request: Request }).request = new Request(url, {
				headers: { authorization: `Bearer ${t.token}`, 'cf-connecting-ip': '10.4.9.1' }
			});
			const res = (await handler(event as never)) as Response;
			return { status: res.status, body: JSON.parse(await res.text()) };
		};
		const list = await call(
			transactionsRoute.GET,
			`/api/v1/transactions?space_id=${a.scope.spaceId}&type=expense`
		);
		expect(list.status).toBe(200);
		expect(list.body.totals.by_currency[0].out_minor).toBe(SHARE + COFFEE);
		const row = list.body.data.find((r: { id: string }) => r.id === a.bill);
		expect(row.amount_minor).toBe(BILL);
		expect(row.patungan).toEqual({ split_id: splitId, effective_amount_minor: SHARE });
		const plain = list.body.data.find((r: { id: string }) => r.id !== a.bill);
		expect(plain.patungan).toBeNull();
		const one = await call(
			transactionRoute.GET,
			`/api/v1/transactions/${a.bill}?space_id=${a.scope.spaceId}`,
			{ id: a.bill }
		);
		expect(one.status).toBe(200);
		expect(one.body.data.amount_minor).toBe(BILL);
		expect(one.body.data.patungan).toEqual({ split_id: splitId, effective_amount_minor: SHARE });
		const laporan = await call(
			laporanRoute.GET,
			`/api/v1/laporan/ringkasan?space_id=${a.scope.spaceId}&bulan=${MONTH}`
		);
		expect(laporan.status).toBe(200);
		expect(laporan.body.data.direction_total_minor).toBe(SHARE + COFFEE);
		expect(
			laporan.body.data.categories.find((c: { category_id: string }) => c.category_id === a.makan)
				.amount_minor
		).toBe(SHARE);
	});

	it('the wallet balance, the CSV export and "Catat lagi" keep the real amount', async () => {
		expect((await walletTransactionsSums(db, a.scope.spaceId)).get(a.walletId)).toBe(
			-(BILL + COFFEE)
		);
		const exported = await listTransactionsForExport(db, a.scope, month, null);
		expect(exported.rows.find((r) => r.id === a.bill)?.amountMinor).toBe(BILL);
		const frequent = await frequentManualTransactions(db, a.scope.spaceId, {
			limit: 5,
			today: TODAY
		});
		expect(frequent.find((f) => f.title === 'Makan bareng')?.amountMinor).toBe(BILL);
	});

	it('the budget streak (FN-34b) judges a day by the payer share, through dailyTotals', async () => {
		const c = await ledger('Dewi');
		await linkRaw(c.scope.spaceId, c.userId, c.bill, BILL, SHARE);
		// A day's allowance of exactly Rp 300.000: Rp 250.000 counted (share + coffee) is within it; the raw
		// Rp 550.000 would be over.
		const days = daysRemainingInclusive(TODAY);
		expect(
			await setBudget(db, c.scope, { amountMinor: 30_000_000 * days, currency: 'IDR' }, null, NOW)
		).toBe('ok');
		expect(await snapshotBudgetDay(db, c.scope.spaceId, TODAY, NOW)).toBe('within');
	});
});
