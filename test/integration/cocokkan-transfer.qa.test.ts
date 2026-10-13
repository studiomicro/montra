import { isHttpError } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import {
	listTransactionsByDay,
	monthlyTotals,
	periodTotals
} from '#lib/server/transactions/aggregate';
import { getTransaction } from '#lib/server/transactions/repo';
import { readWalletBalance } from '#lib/server/transactions/wallet-sum';
import {
	applyTransferMatch,
	countTransferMatches,
	proposeTransferMatches,
	undoTransferMatch,
	type TransferPair
} from '#lib/server/transfers/match';
import { newId } from '#lib/server/util';
import { createWallet } from '#lib/server/wallets/repo';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * QA additions for FN-48 Part C (do not duplicate cocokkan-transfer.test.ts): the ±1-day window on `occurred_on`
 * (WIB) when the UTC day of `occurred_at` differs (AC-19), Beranda/Laporan totals through the real aggregate
 * functions (AC-3), a non-member's load (AC-14), one-sided categorisation on the credit side (AC-12), an archived
 * wallet, a 2×2 ambiguous chain after one confirm (AC-5), and a USD/IDR mismatch in two IDR wallets (AC-9).
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const route = await import('../../src/routes/(app)/impor/cocokkan-transfer/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.parse('2026-08-12T03:00:00Z');
const FIVE_M = 500_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function account() {
	const email = `qa-cocok${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'QA', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	await ensurePresetCategories(db, space.id, NOW);
	const wallet = async (name: string) => {
		const w = await createWallet(
			db,
			scope,
			{
				name,
				type: 'bank',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: false,
				lastFour: null
			},
			NOW
		);
		if (!w.ok) throw new Error('wallet failed');
		return w.id;
	};
	return {
		user: { id: r.userId, email, name: 'QA', createdAt: 0 },
		scope,
		A: await wallet('BCA'),
		B: await wallet('OCBC'),
		C: await wallet('Jago')
	};
}
type Account = Awaited<ReturnType<typeof account>>;

async function cat(spaceId: string, tile: string, kind: 'expense' | 'income') {
	const all = await listCategories(db, spaceId, { includeHidden: true });
	return all.find((c) => c.tileKey === tile && c.kind === kind && c.isPreset)!.id;
}

interface Seed {
	wallet: string;
	type: 'expense' | 'income';
	title: string;
	day: string;
	/** UTC instant; default 05:00Z (12:00 WIB) of `day`. */
	at?: string;
	amount?: number;
	currency?: string;
	tile?: string;
}

async function seed(a: Account, s: Seed) {
	const id = newId();
	await d1
		.prepare(
			`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
				occurred_on, occurred_at, source, dedupe_key, is_demo, created_at, updated_at, seq, category_source)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'statement', ?, 0, ?, ?, 1, 'auto')`
		)
		.bind(
			id,
			a.scope.spaceId,
			s.type,
			s.amount ?? FIVE_M,
			s.currency ?? 'IDR',
			await cat(a.scope.spaceId, s.tile ?? 'transfer', s.type),
			s.wallet,
			s.title,
			s.day,
			Date.parse(s.at ?? `${s.day}T05:00:00Z`),
			`statement:qa:${id}`,
			NOW - 1000,
			NOW - 1000
		)
		.run();
	return id;
}

const pairsOf = async (a: Account) =>
	(await proposeTransferMatches(db, a.scope.spaceId)).groups.flatMap((g) => g.pairs);
const choice = (p: TransferPair) => ({
	debitId: p.debit.id,
	creditId: p.credit.id,
	debitUpdatedAt: p.debit.updatedAt,
	creditUpdatedAt: p.credit.updatedAt
});

describe('QA: WIB window (AC-19)', () => {
	it('23:30 WIB on 31 July and 00:30 WIB on 1 August are one day apart by occurred_on: paired', async () => {
		const a = await account();
		// 23:30 WIB 31 Jul = 16:30Z 31 Jul; 00:30 WIB 1 Aug = 17:30Z 31 Jul (same UTC day, different WIB days).
		await seed(a, {
			wallet: a.A,
			type: 'expense',
			title: 'OUT',
			day: '2026-07-31',
			at: '2026-07-31T16:30:00Z'
		});
		await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'IN',
			day: '2026-08-01',
			at: '2026-07-31T17:30:00Z'
		});
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(1);
		const [p] = await pairsOf(a);
		expect([p!.debit.occurredOn, p!.credit.occurredOn]).toEqual(['2026-07-31', '2026-08-01']);
	});

	it('two WIB days apart is never paired even when the UTC days of occurred_at are adjacent', async () => {
		const a = await account();
		// Debit 06:30 WIB 1 Aug = 23:30Z 31 Jul; credit 30 Jul 12:00 WIB. By occurred_on: 2 days. By UTC date: 1 day.
		await seed(a, {
			wallet: a.A,
			type: 'expense',
			title: 'OUT',
			day: '2026-08-01',
			at: '2026-07-31T23:30:00Z'
		});
		await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'IN',
			day: '2026-07-30',
			at: '2026-07-30T05:00:00Z'
		});
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
	});
});

describe('QA: eligibility (AC-5, AC-9, AC-12)', () => {
	it('a credit whose category is not the transfer tile is never a candidate (one-sided, credit side)', async () => {
		const a = await account();
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-07-10' });
		await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'IN LAIN',
			day: '2026-07-10',
			tile: 'lain'
		});
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
	});

	it('same integer amount in a different currency is never paired, even inside IDR wallets (AC-9)', async () => {
		const a = await account();
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-07-10' });
		await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'IN USD',
			day: '2026-07-10',
			currency: 'USD'
		});
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
	});

	it('a row in an archived wallet is never a candidate', async () => {
		const a = await account();
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-07-10' });
		await seed(a, { wallet: a.B, type: 'income', title: 'IN', day: '2026-07-10' });
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(1);
		await d1.prepare(`update wallets set deleted_at = ? where id = ?`).bind(NOW, a.B).run();
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
	});

	it('a 2×2 chain is one ambiguous group of four; after one confirm the other pair is a plain group', async () => {
		const a = await account();
		const d1Id = await seed(a, { wallet: a.A, type: 'expense', title: 'OUT 1', day: '2026-07-10' });
		const d2Id = await seed(a, { wallet: a.A, type: 'expense', title: 'OUT 2', day: '2026-07-11' });
		const c1 = await seed(a, { wallet: a.B, type: 'income', title: 'IN 1', day: '2026-07-10' });
		const c2 = await seed(a, { wallet: a.C, type: 'income', title: 'IN 2', day: '2026-07-11' });
		const preview = await proposeTransferMatches(db, a.scope.spaceId);
		expect(preview.total).toBe(4);
		expect(preview.groups).toHaveLength(1);
		expect(preview.groups[0]!.ambiguous).toBe(true);
		expect(preview.groups[0]!.pairs).toHaveLength(4);
		const pick = preview.groups[0]!.pairs.find((p) => p.debit.id === d1Id && p.credit.id === c1)!;
		expect(await applyTransferMatch(db, a.scope, choice(pick), NOW)).toMatchObject({
			status: 'ok'
		});
		const after = await proposeTransferMatches(db, a.scope.spaceId);
		expect(after.total).toBe(1);
		expect(after.groups).toEqual([
			expect.objectContaining({
				ambiguous: false,
				pairs: [
					expect.objectContaining({
						debit: expect.objectContaining({ id: d2Id }),
						credit: expect.objectContaining({ id: c2 })
					})
				]
			})
		]);
		expect(await getTransaction(db, a.scope.spaceId, d1Id)).toMatchObject({
			type: 'transfer',
			transferToWalletId: a.B
		});
		expect(
			(await d1.prepare(`select deleted_at from transactions where id = ?`).bind(c1).all()).results
		).toEqual([{ deleted_at: NOW }]);
	});
});

describe('QA: Beranda/Laporan totals through the real aggregates (AC-3)', () => {
	it('after the merge the real periodTotals/monthlyTotals count one transfer, no income and only the fee; undo restores', async () => {
		const a = await account();
		const debit = await seed(a, {
			wallet: a.A,
			type: 'expense',
			title: 'SWITCHING DB TRF 009',
			day: '2026-07-10'
		});
		await seed(a, { wallet: a.B, type: 'income', title: 'SWITCHING CR TRF', day: '2026-07-11' });
		await seed(a, {
			wallet: a.A,
			type: 'expense',
			title: 'BIAYA TXN',
			day: '2026-07-10',
			amount: 650_000,
			tile: 'biaya-bank'
		});
		const filter = {
			from: '2026-07-01',
			to: '2026-07-31',
			type: null,
			categoryId: null,
			walletId: null,
			q: null
		};
		const before = await periodTotals(db, a.scope.spaceId, filter);
		expect(before).toMatchObject({ count: 3, expenseCount: 2, incomeCount: 1, transferCount: 0 });
		expect(before.totals).toEqual([
			{ currency: 'IDR', inMinor: FIVE_M, outMinor: FIVE_M + 650_000 }
		]);

		const [p] = await pairsOf(a);
		const r = await applyTransferMatch(db, a.scope, choice(p!), NOW);
		expect(r).toMatchObject({ status: 'ok' });
		const after = await periodTotals(db, a.scope.spaceId, filter);
		expect(after).toMatchObject({ count: 2, expenseCount: 1, incomeCount: 0, transferCount: 1 });
		expect(after.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 650_000 }]);
		expect(await monthlyTotals(db, a.scope.spaceId, filter)).toEqual([
			{ month: '2026-07', totals: [{ currency: 'IDR', inMinor: 0, outMinor: 650_000 }] }
		]);
		// Wallet B's history shows the transfer once, linked (toWallet = B), not an income row.
		const pageB = await listTransactionsByDay(db, a.scope.spaceId, { ...filter, walletId: a.B });
		const rowsB = pageB.days.flatMap((d) => d.rows);
		expect(rowsB).toHaveLength(1);
		expect(rowsB[0]).toMatchObject({
			id: debit,
			type: 'transfer',
			amountMinor: FIVE_M,
			wallet: { id: a.A },
			toWallet: { id: a.B }
		});
		// Wallet A's history: the transfer and the fee, no separate expense of Rp 5.000.000.
		const pageA = await listTransactionsByDay(db, a.scope.spaceId, { ...filter, walletId: a.A });
		expect(
			pageA.days
				.flatMap((d) => d.rows)
				.map((x) => x.type)
				.sort()
		).toEqual(['expense', 'transfer']);
		expect(await readWalletBalance(db, a.scope.spaceId, a.A)).toBe(BigInt(-FIVE_M - 650_000));
		expect(await readWalletBalance(db, a.scope.spaceId, a.B)).toBe(BigInt(FIVE_M));

		expect(await undoTransferMatch(db, a.scope, (r as { linkId: string }).linkId, NOW + 1)).toBe(
			'ok'
		);
		expect(await periodTotals(db, a.scope.spaceId, filter)).toMatchObject({
			count: 3,
			totals: [{ currency: 'IDR', inMinor: FIVE_M, outMinor: FIVE_M + 650_000 }]
		});
	});
});

describe('QA: a user who was never a member (AC-14)', () => {
	it('load, merge and undo on another user’s space answer 404', async () => {
		const a = await account();
		const b = await account();
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-07-10' });
		await seed(a, { wallet: a.B, type: 'income', title: 'IN', day: '2026-07-10' });
		const [p] = await pairsOf(a);
		const asB = (fn: (e: never) => unknown, form?: [string, string][]) =>
			fn(
				fakeEvent({
					url: 'http://localhost/impor/cocokkan-transfer',
					routeId: '/(app)/impor/cocokkan-transfer',
					db,
					user: b.user,
					space: { id: a.scope.spaceId, name: 'Pribadi', kind: 'personal', role: 'owner' } as never,
					form
				}).event as never
			);
		const status = async (fn: () => unknown) => {
			try {
				await fn();
				return 'ok';
			} catch (e) {
				return isHttpError(e) ? e.status : 'thrown';
			}
		};
		const actions = route.actions as Record<string, (e: never) => unknown>;
		expect(await status(() => asB(route.load as never))).toBe(404);
		expect(
			await status(() =>
				asB(actions.merge!, [
					['debitId', p!.debit.id],
					['creditId', p!.credit.id],
					['debitUpdatedAt', String(p!.debit.updatedAt)],
					['creditUpdatedAt', String(p!.credit.updatedAt)]
				])
			)
		).toBe(404);
		expect(await status(() => asB(actions.undo!, [['id', newId()]]))).toBe(404);
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(1);
		expect(await getTransaction(db, a.scope.spaceId, p!.debit.id)).toMatchObject({
			type: 'expense'
		});
	});
});
