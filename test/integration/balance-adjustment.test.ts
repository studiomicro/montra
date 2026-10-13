import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { anggaranSummary } from '#lib/server/budgets/anggaran';
import { setBudget } from '#lib/server/budgets/repo';
import { berandaSummary } from '#lib/server/budgets/summary';
import { getDb, type Db } from '#lib/server/db';
import { exportTransactionsCsv } from '#lib/server/imports/csv-export';
import { importCsv } from '#lib/server/imports/csv-import';
import { evaluateDailyNudge } from '#lib/server/notifications/triggers';
import { laporanReport } from '#lib/server/reports/laporan';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { closeDay, streakSummary } from '#lib/server/streak/repo';
import {
	categoryMonthlyTotals,
	categoryTotals,
	dailyTotals,
	frequentManualTransactions,
	listTransactionsByDay,
	monthlyTotals,
	periodTotals,
	type TransactionFilter
} from '#lib/server/transactions/aggregate';
import {
	ADJUSTMENT_CHANGED,
	ADJUSTMENT_SAME,
	ADJUSTMENT_TOO_LARGE,
	BALANCE_INVALID,
	BALANCE_INVALID_CENTS,
	TRANSACTION_LIMIT,
	TYPE_INVALID,
	WALLET_NOT_FOUND
} from '#lib/server/transactions/messages';
import { createTransaction, getTransaction, MANUAL } from '#lib/server/transactions/repo';
import { recordAgain } from '#lib/server/transactions/voice';
import { readWalletBalance, walletTransactionsSums } from '#lib/server/transactions/wallet-sum';
import { walletBalanceMinor } from '#lib/server/wallets/balance';
import { getWallet } from '#lib/server/wallets/repo';
import { readCsv } from '#lib/shared/csv';
import { parseLaporanQuery } from '#lib/shared/laporan-query';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const riwayat = await import('../../src/routes/(app)/riwayat/+page.server');
const baru = await import('../../src/routes/(app)/riwayat/baru/+page.server');
const edit = await import('../../src/routes/(app)/riwayat/[id]/edit/+page.server');
const dompet = await import('../../src/routes/(app)/dompet/+page.server');

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
afterEach(() => vi.useRealTimers());

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
	const email = `penyesuaian${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name, createdAt: 0 } };
}
type Person = Awaited<ReturnType<typeof person>>;

async function ev(
	who: Person | null,
	opts: {
		url: string;
		routeId: string;
		form?: Record<string, string>;
		spaceCookie?: string;
		params?: Record<string, string>;
	}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	return fakeEvent({
		url: `http://localhost${opts.url}`,
		routeId: opts.routeId,
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		params: opts.params
	}).event as never;
}

const R = {
	list: '/(app)/riwayat',
	baru: '/(app)/riwayat/baru',
	edit: '/(app)/riwayat/[id]/edit',
	dompet: '/(app)/dompet'
};

const loadBaru = async (who: Person, query = '', space?: string) =>
	run(async () =>
		baru.load(await ev(who, { url: `/riwayat/baru${query}`, routeId: R.baru, spaceCookie: space }))
	);
const action = async (
	who: Person,
	name: 'create' | 'adjust',
	form: Record<string, string>,
	space?: string
) =>
	run(async () =>
		(baru.actions as Record<string, Handler>)[name]!(
			await ev(who, { url: '/riwayat/baru', routeId: R.baru, form, spaceCookie: space })
		)
	);
const loadList = async (who: Person, query = '', space?: string) =>
	run(async () =>
		riwayat.load(await ev(who, { url: `/riwayat${query}`, routeId: R.list, spaceCookie: space }))
	);
const loadEdit = async (who: Person, id: string, space?: string) =>
	run(async () =>
		edit.load(
			await ev(who, {
				url: `/riwayat/${id}/edit`,
				routeId: R.edit,
				params: { id },
				spaceCookie: space
			})
		)
	);
const editAction = async (
	who: Person,
	name: 'update' | 'delete',
	id: string,
	form: Record<string, string>,
	space?: string
) =>
	run(async () =>
		(edit.actions as Record<string, Handler>)[name]!(
			await ev(who, {
				url: `/riwayat/${id}/edit`,
				routeId: R.edit,
				params: { id },
				form,
				spaceCookie: space
			})
		)
	);
const walletAction = async (who: Person, form: Record<string, string>, space?: string) =>
	run(async () =>
		(dompet.actions as Record<string, Handler>).createWallet!(
			await ev(who, { url: '/dompet', routeId: R.dompet, form, spaceCookie: space })
		)
	);

/** A person whose current space has BCA (Rp1.200.000) and GoPay (Rp0), IDR, and the preset categories. */
async function setup(who?: Person, space?: string) {
	const p = who ?? (await person());
	await walletAction(
		p,
		{
			name: 'BCA',
			type: 'bank',
			currency: 'IDR',
			openingBalance: '1.200.000',
			lastFour: '',
			favourite: 'on'
		},
		space
	);
	await walletAction(
		p,
		{ name: 'GoPay', type: 'e_wallet', currency: 'IDR', openingBalance: '', lastFour: '' },
		space
	);
	const loaded = await loadBaru(p, '', space);
	if (loaded.kind !== 'ok') throw new Error('load failed');
	const wallets = loaded.value.wallets as { id: string; name: string }[];
	const cats = loaded.value.categories as { id: string; tileKey: string }[];
	const spaceId = (await resolveCurrentSpace(db, p.user.id, space))!.id;
	return {
		p,
		spaceId,
		scope: { spaceId, userId: p.user.id },
		bca: wallets.find((w) => w.name === 'BCA')!.id,
		gopay: wallets.find((w) => w.name === 'GoPay')!.id,
		kopi: cats.find((c) => c.tileKey === 'kopi')!.id,
		gaji: cats.find((c) => c.tileKey === 'gaji')!.id
	};
}
type Setup = Awaited<ReturnType<typeof setup>>;

const adjustForm = (s: Setup, over: Record<string, string> = {}) => ({
	walletId: s.bca,
	balance: '1.500.000',
	title: '',
	note: '',
	occurredOn: '2026-10-10',
	occurredTime: '',
	...over
});

async function balance(s: Setup, walletId = s.bca) {
	const w = (await getWallet(db, s.spaceId, walletId))!;
	return walletBalanceMinor(w, (await walletTransactionsSums(db, s.spaceId)).get(walletId) ?? 0);
}

async function rows(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select id, type, amount_minor, adjustment_direction, category_id, transfer_to_wallet_id, deleted_at,
				occurred_on, occurred_at, title
			from transactions where space_id = ? order by created_at, id`
		)
		.bind(spaceId)
		.all<Record<string, string | number | null>>();
	return results;
}

describe('creating a balance adjustment (criteria 1–3)', () => {
	it('1: Rp1.200.000 → Rp1.500.000 writes one +Rp300.000 adjustment; the wallet shows Rp1.500.000', async () => {
		const s = await setup();
		expect(await balance(s)).toBe(120_000_000);
		expect(await action(s.p, 'adjust', adjustForm(s))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/riwayat?saved=adjusted'
		});
		const all = await rows(s.spaceId);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			type: 'adjustment',
			adjustment_direction: 'increase',
			amount_minor: 30_000_000,
			category_id: null,
			transfer_to_wallet_id: null,
			title: null
		});
		expect(await balance(s)).toBe(150_000_000);
		// The read the action uses agrees with walletBalanceMinor + walletTransactionsSums.
		expect(await readWalletBalance(db, s.spaceId, s.bca)).toBe(150_000_000n);
	});

	it('2: Rp1.200.000 → Rp900.000 writes one −Rp300.000 adjustment', async () => {
		const s = await setup();
		await action(s.p, 'adjust', adjustForm(s, { balance: '900.000' }));
		const all = await rows(s.spaceId);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ adjustment_direction: 'decrease', amount_minor: 30_000_000 });
		expect(await balance(s)).toBe(90_000_000);
	});

	it('a negative new balance (credit card) and back; balance follows every transaction type', async () => {
		const s = await setup();
		await action(s.p, 'create', {
			type: 'expense',
			amount: '200.000',
			walletId: s.bca,
			categoryId: s.kopi,
			title: 'Belanja',
			note: '',
			occurredOn: '2026-10-09',
			occurredTime: ''
		});
		await action(s.p, 'create', {
			type: 'transfer',
			amount: '100.000',
			walletId: s.bca,
			transferToWalletId: s.gopay,
			title: '',
			note: '',
			occurredOn: '2026-10-09',
			occurredTime: ''
		});
		expect(await balance(s)).toBe(90_000_000);
		await action(s.p, 'adjust', adjustForm(s, { balance: '50.000', negative: 'on' }));
		expect(await balance(s)).toBe(-5_000_000);
		expect((await rows(s.spaceId)).at(-1)).toMatchObject({
			adjustment_direction: 'decrease',
			amount_minor: 95_000_000
		});
		// GoPay received the transfer: Rp100.000 → Rp0 is a decrease of exactly that.
		await action(s.p, 'adjust', adjustForm(s, { walletId: s.gopay, balance: '' }));
		expect(await balance(s, s.gopay)).toBe(0);
		expect(await readWalletBalance(db, s.spaceId, s.gopay)).toBe(0n);
	});

	it('3: the same balance writes nothing and says so (never a zero-amount row)', async () => {
		const s = await setup();
		expect(await action(s.p, 'adjust', adjustForm(s, { balance: '1.200.000' }))).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { adjustmentErrors: { amountMinor: ADJUSTMENT_SAME } }
		});
		// An empty field is 0, like "Saldo awal": an empty wallet stated empty is the same balance too.
		expect(
			await action(s.p, 'adjust', adjustForm(s, { walletId: s.gopay, balance: '' }))
		).toMatchObject({ status: 400, data: { adjustmentErrors: { amountMinor: ADJUSTMENT_SAME } } });
		expect(await rows(s.spaceId)).toEqual([]);
	});

	it('money vectors: whole units only, the 13-digit field and the row bound (overflow) are refused', async () => {
		const s = await setup();
		const refused = async (balanceText: string, message: string) =>
			expect(await action(s.p, 'adjust', adjustForm(s, { balance: balanceText }))).toMatchObject({
				status: 400,
				data: { adjustmentErrors: { amountMinor: message } }
			});
		for (const text of [
			'Rp 1.250.000',
			'1.250.000,50',
			'Rp 28.000,00',
			'IDR 1,250,000.00',
			'25rb',
			'25k',
			'1,5 jt',
			'goceng',
			'-50.000',
			'1.250.000 CR',
			'12.34',
			'10000000000000' // 14 digits
		])
			await refused(text, BALANCE_INVALID);
		// 13 digits parse, but Rp9,99 T − Rp1,2 jt is past the one-row bound of 10^13 minor units.
		await refused('9.999.999.999.999', ADJUSTMENT_TOO_LARGE);
		// Exactly at the bound is fine: Rp1.200.000 + Rp100.000.000.000 (10^13 minor).
		expect(
			await action(s.p, 'adjust', adjustForm(s, { balance: '100.001.200.000' }))
		).toMatchObject({ kind: 'redirect' });
		expect(await balance(s)).toBe(10_000_120_000_000);
		expect(await rows(s.spaceId)).toHaveLength(1);
	});

	it('the compose form only ever writes expense, income or transfer', async () => {
		const s = await setup();
		expect(
			await action(s.p, 'create', {
				type: 'adjustment',
				amount: '300.000',
				walletId: s.bca,
				title: '',
				note: '',
				occurredOn: '2026-10-10',
				occurredTime: ''
			})
		).toMatchObject({ status: 400, data: { errors: { type: TYPE_INVALID } } });
		expect(await rows(s.spaceId)).toEqual([]);
	});

	it('the load offers the adjustment form with each wallet’s balance; ?wallet= picks a live wallet', async () => {
		const s = await setup();
		const loaded = await loadBaru(s.p, `?type=adjustment&wallet=${s.gopay}`);
		expect(loaded).toMatchObject({
			kind: 'ok',
			value: { adjustmentValues: { walletId: s.gopay, balance: '', negative: false } }
		});
		const wallets = (
			loaded as unknown as { value: { wallets: { id: string; balanceMinor: number }[] } }
		).value.wallets;
		expect(wallets.find((w) => w.id === s.bca)?.balanceMinor).toBe(120_000_000);
		// Another space's wallet id is ignored (the favourite stays the default).
		const other = await setup();
		expect(await loadBaru(s.p, `?type=adjustment&wallet=${other.bca}`)).toMatchObject({
			value: { adjustmentValues: { walletId: s.bca } }
		});
		expect(await loadBaru(s.p)).toMatchObject({ value: { adjustmentValues: null } });
	});
});

const FILTER = (over: Partial<TransactionFilter> = {}): TransactionFilter => ({
	from: '2026-09-01',
	to: '2026-10-31',
	type: null,
	categoryId: null,
	walletId: null,
	q: null,
	...over
});

/** Every money figure MONTRA shows, without the row counts (an adjustment is a row; it is never money). */
async function figures(s: Setup) {
	const spaceId = s.spaceId;
	const today = '2026-10-15';
	const list = await listTransactionsByDay(db, spaceId, FILTER());
	const csv = await new Response(
		exportTransactionsCsv(db, s.scope, '2026-09-01', '2026-10-31')
	).text();
	const all = {
		periodAll: await periodTotals(db, spaceId, FILTER()),
		periodExpense: await periodTotals(db, spaceId, FILTER({ type: 'expense' })),
		periodIncome: await periodTotals(db, spaceId, FILTER({ type: 'income' })),
		periodWallet: await periodTotals(db, spaceId, FILTER({ walletId: s.bca })),
		// A day listing only adjustments has a header with no money (like a transfer-only day): left out here.
		dayTotals: list.days
			.filter((d) => d.totals.length > 0)
			.map((d) => ({ date: d.date, totals: d.totals })),
		daily: await dailyTotals(db, spaceId, FILTER()),
		categories: await categoryTotals(db, spaceId, FILTER()),
		monthly: await monthlyTotals(db, spaceId, FILTER()),
		categoryMonthly: await categoryMonthlyTotals(db, spaceId, FILTER()),
		beranda: await berandaSummary(db, spaceId, today),
		anggaran: await anggaranSummary(db, spaceId, today),
		laporanKeluar: await laporanReport(
			db,
			spaceId,
			today,
			parseLaporanQuery(new URLSearchParams(), today)
		),
		laporanMasuk: await laporanReport(
			db,
			spaceId,
			today,
			parseLaporanQuery(new URLSearchParams('arah=masuk'), today)
		),
		laporanTahun: await laporanReport(
			db,
			spaceId,
			today,
			parseLaporanQuery(new URLSearchParams('y=2026'), today)
		),
		catatLagi: await frequentManualTransactions(db, spaceId, { limit: 5, today }),
		csv
	};
	// Row counts and the listed rows themselves may grow by the adjustments; every amount must not.
	return JSON.parse(
		JSON.stringify(all, (key, value) =>
			/count$/i.test(key) || key === 'todayGroup' || key === 'recent' ? undefined : value
		)
	) as unknown;
}

describe('an adjustment is never spending, income, a budget or a report figure (criteria 4, 5, 7, 10)', () => {
	async function ledger() {
		const s = await setup();
		const add = (form: Record<string, string>) =>
			action(s.p, 'create', { note: '', occurredTime: '', walletId: s.bca, ...form });
		for (const day of ['2026-10-10', '2026-10-10', '2026-09-20'])
			await add({
				type: 'expense',
				amount: '25.000',
				categoryId: s.kopi,
				title: 'Kopi',
				occurredOn: day
			});
		await add({
			type: 'income',
			amount: '500.000',
			categoryId: s.gaji,
			title: 'Gaji',
			occurredOn: '2026-10-01'
		});
		await setBudget(db, s.scope, { amountMinor: 10_000_000, currency: 'IDR' }, null, Date.now());
		return s;
	}

	it('every aggregate, Beranda, Anggaran, Laporan, budget alerts, Catat lagi and the CSV export are unchanged', async () => {
		const s = await ledger();
		const before = await figures(s);
		const balanceBefore = await balance(s);
		// A large increase on a day that has spending, and a decrease in last month and on its own day.
		await action(s.p, 'adjust', adjustForm(s, { balance: '50.000.000', occurredOn: '2026-10-10' }));
		await action(s.p, 'adjust', adjustForm(s, { balance: '1.000', occurredOn: '2026-09-20' }));
		await action(s.p, 'adjust', adjustForm(s, { balance: '2.000', occurredOn: '2026-10-14' }));
		// Three identical manual adjustments would be a "Catat lagi" group if they counted (criterion 10).
		for (let i = 0; i < 3; i++)
			await createTransaction(
				db,
				s.scope,
				{
					type: 'adjustment',
					amountMinor: 100,
					currency: 'IDR',
					walletId: s.bca,
					transferToWalletId: null,
					categoryId: null,
					adjustmentDirection: 'increase',
					title: 'Sama',
					note: null,
					occurredOn: '2026-10-12',
					occurredTime: null
				},
				Date.now(),
				MANUAL
			);
		expect(await figures(s)).toEqual(before);
		// …while the wallet balance (criterion 5) moved exactly as stated.
		expect(balanceBefore).not.toBe(200_000);
		expect(await balance(s)).toBe(200_300);
		const counts = await periodTotals(db, s.spaceId, FILTER());
		expect(counts).toMatchObject({
			adjustmentCount: 6,
			expenseCount: 3,
			incomeCount: 1,
			count: 10
		});
	});

	it('4: Beranda total = Riwayat total for the same filter, with adjustments in the period', async () => {
		const s = await ledger();
		await action(s.p, 'adjust', adjustForm(s, { balance: '9.000.000', occurredOn: '2026-10-10' }));
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-15T05:00:00Z'));
		const beranda = await berandaSummary(db, s.spaceId, '2026-10-15');
		const header = (await loadList(s.p, '?type=expense&month=2026-10')) as unknown as {
			value: { totals: { count: number; totals: { outMinor: number }[] } };
		};
		const semua = (await loadList(s.p, '?month=2026-10')) as unknown as {
			value: { totals: { count: number; totals: { outMinor: number }[] } };
		};
		expect(beranda.spentMinor).toBe(5_000_000);
		expect(header.value.totals.totals[0]!.outMinor).toBe(beranda.spentMinor);
		expect(semua.value.totals.totals[0]!.outMinor).toBe(beranda.spentMinor);
		// "N transaksi" on Semua counts the adjustment row (2 kopi + gaji + adjustment).
		expect(semua.value.totals.count).toBe(4);
	});

	it('7: the adjustment is listed on its day, the day header excludes it', async () => {
		const s = await ledger();
		await action(s.p, 'adjust', adjustForm(s, { balance: '9.000.000', occurredOn: '2026-10-10' }));
		const page = await listTransactionsByDay(db, s.spaceId, FILTER());
		const day = page.days.find((d) => d.date === '2026-10-10')!;
		expect(day.rows.map((r) => r.type).sort()).toEqual(['adjustment', 'expense', 'expense']);
		expect(day.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 5_000_000 }]);
		expect(day.rows.find((r) => r.type === 'adjustment')).toMatchObject({
			adjustmentDirection: 'increase',
			category: null,
			toWallet: null
		});
	});

	it('10: "Catat lagi" never copies an adjustment (one answer: missing)', async () => {
		const s = await setup();
		await action(s.p, 'adjust', adjustForm(s));
		const id = (await rows(s.spaceId))[0]!.id as string;
		expect(await recordAgain(db, s.scope, id, 'tap-1', '2026-10-15', Date.now())).toEqual({
			ok: false,
			reason: 'missing'
		});
	});

	it('the daily "catat hari ini" nudge is not silenced by an adjustment', async () => {
		const s = await setup();
		await action(s.p, 'adjust', adjustForm(s, { occurredOn: '2026-10-15' }));
		const made = await evaluateDailyNudge(db, s.p.user.id, '2026-10-15', Date.now());
		expect(made).toEqual([{ id: expect.any(String), created: true }]);
	});
});

describe('Riwayat chip, edit and delete (criteria 6, 8, 9)', () => {
	it('6: the "Penyesuaian saldo" chip lists only adjustments and counts them, money-free', async () => {
		const s = await setup();
		await action(s.p, 'create', {
			type: 'expense',
			amount: '25.000',
			walletId: s.bca,
			categoryId: s.kopi,
			title: 'Kopi',
			note: '',
			occurredOn: '2026-10-10',
			occurredTime: ''
		});
		await action(s.p, 'adjust', adjustForm(s, { balance: '1.000.000' }));
		const r = (await loadList(s.p, '?type=adjustment&month=2026-10')) as unknown as {
			value: {
				view: { type: string };
				totals: { count: number; totals: unknown[] };
				chipTotals: { count: number; adjustmentCount: number };
				page: {
					days: { rows: { type: string; amountMinor: number; adjustmentDirection: string }[] }[];
				};
			};
		};
		expect(r.value.view.type).toBe('adjustment');
		const listed = r.value.page.days.flatMap((d) => d.rows);
		expect(listed).toEqual([
			expect.objectContaining({
				type: 'adjustment',
				amountMinor: 17_500_000,
				adjustmentDirection: 'decrease'
			})
		]);
		expect(r.value.totals).toEqual(expect.objectContaining({ count: 1, totals: [] }));
		expect(r.value.chipTotals).toMatchObject({ count: 2, adjustmentCount: 1 });
	});

	it('8: an adjustment’s edit keeps amount, direction and wallet, whatever the form sends', async () => {
		const s = await setup();
		await action(s.p, 'adjust', adjustForm(s));
		const id = (await rows(s.spaceId))[0]!.id as string;
		const loaded = await loadEdit(s.p, id);
		expect(loaded).toMatchObject({
			kind: 'ok',
			value: {
				adjustment: { walletName: 'BCA', signedMinor: 30_000_000, currency: 'IDR' },
				adjustmentValues: { title: '', occurredOn: '2026-10-10' }
			}
		});
		const updatedAt = String(
			(loaded as unknown as { value: { transaction: { updatedAt: number } } }).value.transaction
				.updatedAt
		);
		expect(
			await editAction(s.p, 'update', id, {
				updatedAt,
				type: 'expense',
				amount: '1',
				walletId: s.gopay,
				categoryId: s.kopi,
				balance: '5',
				title: 'Cocokkan dengan m-banking',
				note: 'mutasi',
				occurredOn: '2026-10-11',
				occurredTime: '08:30'
			})
		).toEqual({ kind: 'redirect', status: 303, location: '/riwayat?saved=updated' });
		expect((await rows(s.spaceId))[0]).toMatchObject({
			type: 'adjustment',
			adjustment_direction: 'increase',
			amount_minor: 30_000_000,
			category_id: null,
			title: 'Cocokkan dengan m-banking',
			occurred_on: '2026-10-11'
		});
		expect((await getTransaction(db, s.spaceId, id))!.walletId).toBe(s.bca);
		expect(await balance(s)).toBe(150_000_000);
		// A stale second tab changes nothing.
		expect(
			await editAction(s.p, 'update', id, { updatedAt, title: 'Lama', occurredOn: '2026-10-11' })
		).toMatchObject({
			status: 409
		});
		// A bad date is refused field-wise and echoed back.
		const fresh = String((await getTransaction(db, s.spaceId, id))!.updatedAt);
		expect(
			await editAction(s.p, 'update', id, {
				updatedAt: fresh,
				title: 'X',
				occurredOn: '2026-13-40'
			})
		).toMatchObject({ status: 400, data: { adjustmentValues: { title: 'X' } } });
	});

	it('an expense can never be edited into an adjustment', async () => {
		const s = await setup();
		await action(s.p, 'create', {
			type: 'expense',
			amount: '25.000',
			walletId: s.bca,
			categoryId: s.kopi,
			title: 'Kopi',
			note: '',
			occurredOn: '2026-10-10',
			occurredTime: ''
		});
		const id = (await rows(s.spaceId))[0]!.id as string;
		const { updatedAt } = (await getTransaction(db, s.spaceId, id))!;
		expect(
			await editAction(s.p, 'update', id, {
				updatedAt: String(updatedAt),
				type: 'adjustment',
				amount: '25.000',
				walletId: s.bca,
				title: 'Kopi',
				note: '',
				occurredOn: '2026-10-10',
				occurredTime: ''
			})
		).toMatchObject({ status: 400, data: { errors: { type: TYPE_INVALID } } });
		expect((await rows(s.spaceId))[0]).toMatchObject({ type: 'expense' });
	});

	it('9: deleting an adjustment tombstones it like any row; the balance recomputes without it', async () => {
		const s = await setup();
		await action(s.p, 'adjust', adjustForm(s, { balance: '700.000' }));
		expect(await balance(s)).toBe(70_000_000);
		const id = (await rows(s.spaceId))[0]!.id as string;
		const { updatedAt } = (await getTransaction(db, s.spaceId, id))!;
		expect(await editAction(s.p, 'delete', id, { updatedAt: String(updatedAt) })).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/riwayat?saved=deleted'
		});
		expect((await rows(s.spaceId))[0]).toMatchObject({
			type: 'adjustment',
			amount_minor: null,
			adjustment_direction: null,
			title: null
		});
		expect((await rows(s.spaceId))[0]!.deleted_at).not.toBeNull();
		expect(await balance(s)).toBe(120_000_000);
	});
});

describe('access, cap, WIB dates and concurrency (criteria 11, 12, 13, 16)', () => {
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
		const s = await setup(owner, spaceId);
		return { owner, member, spaceId, s };
	}

	it('11: a member adjusts a shared wallet; a stranger and a removed member get not-found and write nothing', async () => {
		const { owner, member, spaceId, s } = await shared();
		expect(await action(member, 'adjust', adjustForm(s), spaceId)).toMatchObject({
			kind: 'redirect'
		});
		const id = (await rows(spaceId))[0]!.id as string;
		const stranger = await person('Orang lain');
		await setup(stranger);
		for (const who of [stranger]) {
			expect(await action(who, 'adjust', adjustForm(s, { balance: '1' }), spaceId)).toMatchObject({
				status: 400,
				data: { adjustmentErrors: { walletId: WALLET_NOT_FOUND } }
			});
			expect(await loadEdit(who, id, spaceId)).toMatchObject({ kind: 'error', status: 404 });
			expect(await editAction(who, 'delete', id, { updatedAt: '1' }, spaceId)).toMatchObject({
				status: 404
			});
		}
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		expect(await action(member, 'adjust', adjustForm(s, { balance: '2' }), spaceId)).toMatchObject({
			status: 400,
			data: { adjustmentErrors: { walletId: WALLET_NOT_FOUND } }
		});
		expect(await loadEdit(member, id, spaceId)).toMatchObject({ kind: 'error', status: 404 });
		// The write path itself refuses a removed member even with a correct scope (guarded insert).
		const draft = {
			walletId: s.bca,
			balance: '3',
			negative: false,
			locale: 'id' as const,
			title: null,
			note: null,
			occurredOn: '2026-10-10',
			occurredTime: null
		};
		const { createBalanceAdjustment } = await import('#lib/server/transactions/adjustment');
		expect(
			await createBalanceAdjustment(db, { spaceId, userId: member.user.id }, draft, Date.now())
		).toMatchObject({ ok: false, status: 409 });
		expect(await rows(spaceId)).toHaveLength(1);
	});

	it('12: a full space refuses an adjustment with the same limit message', async () => {
		const s = await setup();
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < 100000)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					occurred_on, occurred_at, created_at, updated_at, seq)
				select lower(hex(randomblob(16))), ?, 'expense', 100, 'IDR', ?, ?, '2026-10-08', 0, 0, 0, 1 from n`
			)
			.bind(s.spaceId, s.kopi, s.gopay)
			.run();
		expect(await action(s.p, 'adjust', adjustForm(s))).toMatchObject({
			status: 409,
			data: { error: TRANSACTION_LIMIT }
		});
	});

	it('13: 23:30 WIB on the last day of a month and 00:30 WIB on the first keep their WIB dates', async () => {
		const s = await setup();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-31T16:30:00Z')); // 23:30 WIB, 31 Oct
		expect(await loadBaru(s.p, '?type=adjustment')).toMatchObject({
			value: { adjustmentValues: { occurredOn: '2026-10-31' } }
		});
		await action(s.p, 'adjust', adjustForm(s, { balance: '1.300.000', occurredOn: '2026-10-31' }));
		vi.setSystemTime(new Date('2026-10-31T17:30:00Z')); // 00:30 WIB, 1 Nov
		expect(await loadBaru(s.p, '?type=adjustment')).toMatchObject({
			value: { adjustmentValues: { occurredOn: '2026-11-01' } }
		});
		await action(
			s.p,
			'adjust',
			adjustForm(s, { balance: '1.400.000', occurredOn: '2026-11-01', occurredTime: '00:30' })
		);
		vi.useRealTimers();
		const all = await rows(s.spaceId);
		expect(all.map((r) => r.occurred_on)).toEqual(['2026-10-31', '2026-11-01']);
		expect(all[1]!.occurred_at).toBe(Date.parse('2026-10-31T17:30:00Z'));
		const oct = await periodTotals(db, s.spaceId, FILTER({ from: '2026-10-01', to: '2026-10-31' }));
		const nov = await periodTotals(db, s.spaceId, FILTER({ from: '2026-11-01', to: '2026-11-30' }));
		expect([oct.adjustmentCount, nov.adjustmentCount]).toEqual([1, 1]);
	});

	it('16: 20 concurrent submits of the same new balance write exactly one adjustment', async () => {
		const s = await setup();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => action(s.p, 'adjust', adjustForm(s)))
		);
		expect(results.filter((r) => r.kind === 'redirect')).toHaveLength(1);
		for (const r of results.filter((x) => x.kind === 'fail'))
			expect([ADJUSTMENT_SAME, ADJUSTMENT_CHANGED]).toContain(
				(r as { data: { adjustmentErrors?: { amountMinor?: string }; error?: string } }).data
					.adjustmentErrors?.amountMinor ?? (r as { data: { error?: string } }).data.error
			);
		expect(await rows(s.spaceId)).toHaveLength(1);
		expect(await balance(s)).toBe(150_000_000);
	});

	it('16: concurrent spending never makes the adjustment miss the stated balance', async () => {
		const s = await setup();
		const spend = () =>
			action(s.p, 'create', {
				type: 'expense',
				amount: '1.000',
				walletId: s.bca,
				categoryId: s.kopi,
				title: 'Parkir',
				note: '',
				occurredOn: '2026-10-10',
				occurredTime: ''
			});
		const [adjusted] = await Promise.all([
			action(s.p, 'adjust', adjustForm(s)),
			...Array.from({ length: 10 }, spend)
		]);
		// Whatever order D1 ran them in, the adjustment was computed against the balance at its own write: the
		// spends written after it explain the whole gap between the stated and the final balance.
		const all = await rows(s.spaceId);
		const adj = all.filter((r) => r.type === 'adjustment');
		expect(all.filter((r) => r.type === 'expense')).toHaveLength(10);
		if (adjusted.kind === 'redirect') {
			expect(adj).toHaveLength(1);
			const after = (150_000_000 - (await balance(s))) / 100_000;
			expect(Number.isInteger(after) && after >= 0 && after <= 10).toBe(true);
			expect(adj[0]!.amount_minor).toBe(30_000_000 + (10 - after) * 100_000);
		} else {
			expect(adjusted).toMatchObject({ data: { error: ADJUSTMENT_CHANGED } });
			expect(adj).toHaveLength(0);
		}
	});
});

describe('CSV export and import round trip (pre-handoff probe)', () => {
	it('an adjustment never leaves through the CSV export, and the export re-imports unchanged', async () => {
		const s = await setup();
		await action(s.p, 'create', {
			type: 'expense',
			amount: '25.000',
			walletId: s.bca,
			categoryId: s.kopi,
			title: 'Kopi',
			note: '',
			occurredOn: '2026-10-10',
			occurredTime: ''
		});
		await action(s.p, 'adjust', adjustForm(s, { title: 'Cocokkan saldo' }));
		const csv = await new Response(
			exportTransactionsCsv(db, s.scope, '2026-10-01', '2026-10-31')
		).text();
		expect(csv).not.toContain('Cocokkan saldo');
		expect(csv).not.toContain('adjustment');
		const read = readCsv(csv);
		expect(read.ok).toBe(true);
		const b = await setup();
		expect(
			await importCsv(
				db,
				b.scope,
				{
					fileText: csv,
					filename: 'x.csv',
					format: null,
					defaultWalletId: null,
					skipPossibleDuplicates: false
				},
				Date.now()
			)
		).toMatchObject({ ok: true, counts: { imported: 1, skipped: 0 } });
		expect((await rows(b.spaceId)).map((r) => [r.type, r.amount_minor])).toEqual([
			['expense', 2_500_000]
		]);
	});
});

describe('Beranda "Hari ini" card with FN-34 (cycle 2)', () => {
	it('today’s spend excludes an adjustment; the row count includes it; the streak is untouched', async () => {
		const s = await setup();
		const today = '2026-10-15';
		await action(s.p, 'adjust', adjustForm(s, { balance: '5.000.000', occurredOn: today }));
		// Only an adjustment today: listed and counted, no money (the card shows Rp 0 spent).
		let summary = await berandaSummary(db, s.spaceId, today);
		expect(summary.todayGroup?.rows.map((r) => r.type)).toEqual(['adjustment']);
		expect(summary.todayGroup?.totals).toEqual([]);
		await action(s.p, 'create', {
			type: 'expense',
			amount: '25.000',
			walletId: s.bca,
			categoryId: s.kopi,
			title: 'Kopi',
			note: '',
			occurredOn: today,
			occurredTime: ''
		});
		summary = await berandaSummary(db, s.spaceId, today);
		expect(summary.todayGroup?.rows).toHaveLength(2);
		expect(summary.todayGroup?.totals).toEqual([
			{ currency: 'IDR', inMinor: 0, outMinor: 2_500_000 }
		]);
		expect(summary.spentMinor).toBe(2_500_000);
		// The streak counts closed days only (no transaction query): an adjustment neither closes nor breaks one.
		expect(await streakSummary(db, s.p.user.id, today)).toEqual({ current: 0, closedToday: false });
		expect(await closeDay(db, s.p.user.id, today, Date.now())).toBe(true);
		expect(await streakSummary(db, s.p.user.id, today)).toEqual({ current: 1, closedToday: true });
	});
});

describe('FN-47: a USD wallet keeps cents through create, edit and adjustment (no-JS posts)', () => {
	async function usd() {
		const s = await setup();
		await walletAction(s.p, {
			name: 'Wise USD',
			type: 'bank',
			currency: 'USD',
			openingBalance: '12,50',
			lastFour: ''
		});
		const loaded = await loadBaru(s.p);
		if (loaded.kind !== 'ok') throw new Error('load failed');
		const id = (loaded.value.wallets as { id: string; name: string }[]).find(
			(w) => w.name === 'Wise USD'
		)!.id;
		return { ...s, usd: id };
	}
	const spend = (s: Awaited<ReturnType<typeof usd>>, amount: string) =>
		action(s.p, 'create', {
			type: 'expense',
			amount,
			walletId: s.usd,
			categoryId: s.kopi,
			title: 'Coffee',
			note: '',
			occurredOn: '2026-10-10',
			occurredTime: ''
		});

	it('an expense of 20,75 is 2075 minor units; 20,755 is refused and writes nothing', async () => {
		const s = await usd();
		expect(await spend(s, '20,755')).toMatchObject({ kind: 'fail', status: 400 });
		expect(await rows(s.spaceId)).toHaveLength(0);
		expect(await spend(s, '20,75')).toMatchObject({ kind: 'redirect', status: 303 });
		expect(await rows(s.spaceId)).toMatchObject([{ type: 'expense', amount_minor: 2075 }]);
		expect(await balance(s, s.usd)).toBe(1250 - 2075);
	});

	it('the edit form pre-fills 20,75 (not 20) and saving it unchanged keeps 2075', async () => {
		const s = await usd();
		await spend(s, '20,75');
		const [row] = await rows(s.spaceId);
		const id = String(row!.id);
		const loaded = await loadEdit(s.p, id);
		if (loaded.kind !== 'ok') throw new Error('load failed');
		const values = loaded.value.values as Record<string, string>;
		expect(values.amount).toBe('20,75');
		const updatedAt = String((await getTransaction(db, s.spaceId, id))!.updatedAt);
		expect(await editAction(s.p, 'update', id, { ...values, updatedAt })).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/riwayat?saved=updated'
		});
		expect((await getTransaction(db, s.spaceId, id))!.amountMinor).toBe(2075);
	});

	it('a stated balance of 100,25 records the exact cent difference in the wallet’s own currency', async () => {
		const s = await usd();
		await spend(s, '20,75');
		expect(await balance(s, s.usd)).toBe(-825);
		expect(
			await action(s.p, 'adjust', adjustForm(s, { walletId: s.usd, balance: '100,25' }))
		).toMatchObject({ kind: 'redirect', status: 303 });
		const adj = (await rows(s.spaceId)).find((r) => r.type === 'adjustment');
		expect(adj).toMatchObject({ amount_minor: 10_025 + 825, adjustment_direction: 'increase' });
		expect(await balance(s, s.usd)).toBe(10_025);
		// A third fraction digit is refused, never rounded; nothing more is written.
		expect(
			await action(s.p, 'adjust', adjustForm(s, { walletId: s.usd, balance: '100,255' }))
		).toMatchObject({
			kind: 'fail',
			status: 400,
			// QA FN-47 #2: the refusal names the two-digit rule of a currency with cents.
			data: { adjustmentErrors: { amountMinor: BALANCE_INVALID_CENTS } }
		});
		// The IDR wallet still takes whole rupiah only.
		expect(await action(s.p, 'adjust', adjustForm(s, { balance: '1.500.000,50' }))).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { adjustmentErrors: { amountMinor: BALANCE_INVALID } }
		});
	});
});
