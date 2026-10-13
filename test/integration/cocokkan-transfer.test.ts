import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { importRows, type PreparedRows } from '#lib/server/imports/csv-import';
import { importBatchMoveStates, moveImportBatch, undoImportBatch } from '#lib/server/imports/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { checkStatement, continuityBreaks } from '#lib/server/statements/continuity';
import {
	deleteTransaction,
	getTransaction,
	updateTransaction
} from '#lib/server/transactions/repo';
import { readWalletBalance } from '#lib/server/transactions/wallet-sum';
import {
	applyTransferMatch,
	countTransferMatches,
	listTransferLinks,
	proposeTransferMatches,
	undoTransferMatch,
	type TransferPair
} from '#lib/server/transfers/match';
import { newId } from '#lib/server/util';
import { archiveWallet, createWallet, restoreWallet } from '#lib/server/wallets/repo';
import type { RawCsvTransaction } from '#lib/shared/csv';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-48 Part C on a local D1: own-transfer pairs proposed deterministically, merged one at a time into one FN-05
 * transfer row, undone with both rows restored exactly — across two users and two spaces, with the owner's real
 * case (a BCA debit, an OCBC credit the next day, a separate Rp 6.500 fee) as the main vector.
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const route = await import('../../src/routes/(app)/impor/cocokkan-transfer/+page.server');
const impor = await import('../../src/routes/(app)/impor/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = Date.parse('2026-07-12T03:00:00Z');
/** The owner's real amount: Rp 5.000.000 in minor units. */
const FIVE_M = 500_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

const rows = async <R>(sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all<R>()
	).results;

let n = 0;
async function account(opts: { usd?: boolean } = {}) {
	const email = `cocok${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	await ensurePresetCategories(db, space.id, NOW);
	const wallet = async (name: string, currency: 'IDR' | 'USD' = 'IDR') => {
		const w = await createWallet(
			db,
			scope,
			{ name, type: 'bank', currency, openingBalanceMinor: 0, isFavourite: false, lastFour: null },
			NOW
		);
		if (!w.ok) throw new Error('wallet failed');
		return w.id;
	};
	return {
		user: { id: r.userId, email, name: 'Uji', createdAt: 0 },
		scope,
		A: await wallet('BCA'),
		B: await wallet('OCBC'),
		C: await wallet('Jago'),
		U: opts.usd ? await wallet('Wise', 'USD') : ''
	};
}
type Account = Awaited<ReturnType<typeof account>>;

/** The space's preset category id by tile and kind ("Transfer" exists once per kind). */
async function cat(spaceId: string, tile: string, kind: 'expense' | 'income') {
	const all = await listCategories(db, spaceId, { includeHidden: true });
	return all.find((c) => c.tileKey === tile && c.kind === kind && c.isPreset)!.id;
}

interface Seed {
	wallet: string;
	type: 'expense' | 'income';
	title: string;
	day: string;
	amount?: number;
	currency?: string;
	/** Tile of the category (default: the `transfer` tile of the row's kind). */
	tile?: string;
	demo?: boolean;
	batch?: string | null;
	photo?: boolean;
}

/** A transaction written straight into D1, as a statement import would leave it (category marked auto). */
async function seed(a: Account, s: Seed) {
	const id = newId();
	await d1
		.prepare(
			`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
				note, occurred_on, occurred_at, source, dedupe_key, is_demo, created_at, updated_at, seq,
				import_batch_id, category_source, reference, photo_key, photo_type)
			values (?, ?, ?, ?, ?, ?, ?, ?, 'catatan', ?, ?, 'statement', ?, ?, ?, ?, 1, ?, 'auto', 'REF-1', ?, ?)`
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
			Date.parse(`${s.day}T05:00:00Z`),
			`statement:uji:${id}`,
			s.demo ? 1 : 0,
			NOW - 1000,
			NOW - 1000,
			s.batch ?? null,
			s.photo ? `spaces/${a.scope.spaceId}/receipts/${id}` : null,
			s.photo ? 'image/jpeg' : null
		)
		.run();
	return id;
}

/** Every column of `ids`, for byte-for-byte comparisons. */
const full = (ids: string[]) =>
	rows<Record<string, unknown>>(
		`select * from transactions where id in (select value from json_each(?)) order by id`,
		JSON.stringify(ids)
	);

/** The space's live, real income and expense totals (what Beranda/Laporan double-count without a merge). */
async function inOut(spaceId: string) {
	const [r] = await rows<{ income: number; expense: number }>(
		`select coalesce(sum(case when type = 'income' then amount_minor end), 0) as income,
			coalesce(sum(case when type = 'expense' then amount_minor end), 0) as expense
		from transactions where space_id = ? and deleted_at is null and is_demo = 0`,
		spaceId
	);
	return r!;
}

const pairsOf = async (a: Account) =>
	(await proposeTransferMatches(db, a.scope.spaceId)).groups.flatMap((g) => g.pairs);
const choice = (p: TransferPair) => ({
	debitId: p.debit.id,
	creditId: p.credit.id,
	debitUpdatedAt: p.debit.updatedAt,
	creditUpdatedAt: p.credit.updatedAt
});

/** A stored FN-48B statement batch of wallet B: printed opening 0, printed closing Rp 5.000.000. */
async function statementBatch(a: Account, batchId: string, from: string, to: string) {
	await d1
		.prepare(
			`insert into import_batches (id, space_id, source, format, filename, row_count, imported_count,
				skipped_count, already_imported_count, created_by_user_id, created_at, updated_at, undone_at,
				deleted_at, seq, wallet_id, period_from, period_to, opening_balance_minor, closing_balance_minor)
			values (?, ?, 'statement', null, 'ocbc-juli.pdf', 1, 1, 0, 0, ?, ?, ?, null, null, 1, ?, ?, ?, 0, ?)`
		)
		.bind(batchId, a.scope.spaceId, a.scope.userId, NOW - 1000, NOW - 1000, a.B, from, to, FIVE_M)
		.run();
}

/** The owner's case: the BCA debit on 10 July, the OCBC credit on 11 July, the separate fee. */
async function ownerCase(a: Account) {
	const debit = await seed(a, {
		wallet: a.A,
		type: 'expense',
		title: 'SWITCHING DB TRF BUDI SANTOSO 009 BANK CENTRA 1234567890',
		day: '2026-07-10'
	});
	const credit = await seed(a, {
		wallet: a.B,
		type: 'income',
		title: 'SWITCHING CR TRF BUDI SANTOSO',
		day: '2026-07-11'
	});
	const fee = await seed(a, {
		wallet: a.A,
		type: 'expense',
		title: 'SWITCHING DB BIAYA TXN KE 009 BANK',
		day: '2026-07-10',
		amount: 650_000,
		tile: 'biaya-bank'
	});
	return { debit, credit, fee };
}

describe('proposeTransferMatches (AC-1, AC-7, AC-9, AC-11, AC-12, AC-19)', () => {
	it('proposes the owner’s BCA → OCBC pair once, titles masked, and never the fee or a non-transfer row', async () => {
		const a = await account({ usd: true });
		const { debit, credit } = await ownerCase(a);
		// Not candidates: a transfer-like narrative whose category is not "Transfer" yet (AC-12), a USD credit of the
		// same number (AC-9), a same-wallet income (never a transfer to itself), a credit two days later, a demo credit.
		await seed(a, {
			wallet: a.A,
			type: 'expense',
			title: 'TRSF E-BANKING DB BELUM DIRAPIKAN',
			day: '2026-07-10',
			tile: 'belanja'
		});
		await seed(a, {
			wallet: a.U,
			type: 'income',
			title: 'USD CREDIT',
			day: '2026-07-10',
			currency: 'USD'
		});
		await seed(a, { wallet: a.A, type: 'income', title: 'SAME WALLET', day: '2026-07-10' });
		await seed(a, { wallet: a.C, type: 'income', title: 'TOO LATE', day: '2026-07-12' });
		await seed(a, { wallet: a.C, type: 'income', title: 'DEMO', day: '2026-07-10', demo: true });

		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(1);
		const preview = await proposeTransferMatches(db, a.scope.spaceId);
		expect(preview).toMatchObject({ total: 1, shown: 1 });
		expect(preview.groups).toHaveLength(1);
		expect(preview.groups[0]).toMatchObject({
			ambiguous: false,
			amountMinor: FIVE_M,
			currency: 'IDR'
		});
		const [pair] = preview.groups[0]!.pairs;
		expect(pair).toEqual({
			debit: {
				id: debit,
				title: 'SWITCHING DB TRF BUDI SANTOSO 009 BANK CENTRA ••••7890',
				occurredOn: '2026-07-10',
				walletId: a.A,
				updatedAt: NOW - 1000
			},
			credit: {
				id: credit,
				title: 'SWITCHING CR TRF BUDI SANTOSO',
				occurredOn: '2026-07-11',
				walletId: a.B,
				updatedAt: NOW - 1000
			},
			amountMinor: FIVE_M,
			currency: 'IDR'
		});
	});

	it('a credit the day before the debit pairs too; the window is the WIB date, ±1 day', async () => {
		const a = await account();
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-08-01' });
		await seed(a, { wallet: a.B, type: 'income', title: 'IN', day: '2026-07-31' });
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(1);
	});

	it('another space sees none of it, and two spaces never pair with each other (AC-7)', async () => {
		const a = await account();
		const b = await account();
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT A', day: '2026-07-10' });
		await seed(b, { wallet: b.B, type: 'income', title: 'IN B', day: '2026-07-10' });
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
		expect(await countTransferMatches(db, b.scope.spaceId)).toBe(0);
		expect((await proposeTransferMatches(db, b.scope.spaceId)).groups).toEqual([]);
	});

	it('an ambiguous set (one debit, two same-amount credits) is one group of every candidate (AC-5)', async () => {
		const a = await account();
		const debit = await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-07-10' });
		const c1 = await seed(a, { wallet: a.B, type: 'income', title: 'IN 1', day: '2026-07-10' });
		const c2 = await seed(a, { wallet: a.C, type: 'income', title: 'IN 2', day: '2026-07-11' });
		const preview = await proposeTransferMatches(db, a.scope.spaceId);
		expect(preview.total).toBe(2);
		expect(preview.groups).toHaveLength(1);
		expect(preview.groups[0]!.ambiguous).toBe(true);
		expect(preview.groups[0]!.pairs.map((p) => [p.debit.id, p.credit.id])).toEqual([
			[debit, c2],
			[debit, c1]
		]);
		// Confirming one candidate merges that one only; the other credit stays an ordinary income.
		const [picked] = preview.groups[0]!.pairs;
		expect(await applyTransferMatch(db, a.scope, choice(picked!), NOW)).toMatchObject({
			status: 'ok'
		});
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
		expect(await getTransaction(db, a.scope.spaceId, c1)).toMatchObject({ type: 'income' });
	});

	it('lists the newest 200 pairs and still counts every pair (AC-13)', async () => {
		const a = await account();
		const [out, inn] = await Promise.all([
			cat(a.scope.spaceId, 'transfer', 'expense'),
			cat(a.scope.spaceId, 'transfer', 'income')
		]);
		for (const [wallet, type, category] of [
			[a.A, 'expense', out],
			[a.B, 'income', inn]
		] as const)
			await d1
				.prepare(
					`with recursive k(i) as (select 1 union all select i + 1 from k where i < 205)
					insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
						occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq, category_source)
					select 'bulk-' || ? || '-' || i, ?, ?, 100000 * i, 'IDR', ?, ?, 'TRF ' || i,
						date('2025-01-01', '+' || i || ' days'), ?, 'statement', 'statement:bulk-' || ? || ':' || i,
						?, ?, 1, 'auto'
					from k`
				)
				.bind(type, a.scope.spaceId, type, category, wallet, NOW, type, NOW, NOW)
				.run();
		const preview = await proposeTransferMatches(db, a.scope.spaceId);
		expect(preview).toMatchObject({ total: 205, shown: 200 });
		expect(preview.groups).toHaveLength(200);
		expect(preview.groups.every((g) => !g.ambiguous)).toBe(true);
		// Newest first: the five oldest days are left for the next run.
		const days = preview.groups.map((g) => g.pairs[0]!.debit.occurredOn);
		expect(days[0]).toBe('2025-07-25');
		expect(days).not.toContain('2025-01-02');
	});
});

describe('applyTransferMatch (AC-2, AC-3, AC-8, AC-10, AC-14 … AC-16)', () => {
	it('merges the pair into one transfer: amounts untouched, totals no longer double-counted, resend changes nothing', async () => {
		const a = await account();
		const { debit, credit, fee } = await ownerCase(a);
		const before = await full([debit, credit, fee]);
		expect(await inOut(a.scope.spaceId)).toEqual({ income: FIVE_M, expense: FIVE_M + 650_000 });
		expect(await readWalletBalance(db, a.scope.spaceId, a.A)).toBe(BigInt(-FIVE_M - 650_000));
		expect(await readWalletBalance(db, a.scope.spaceId, a.B)).toBe(BigInt(FIVE_M));

		const [pair] = await pairsOf(a);
		const r = await applyTransferMatch(db, a.scope, choice(pair!), NOW);
		expect(r).toMatchObject({ status: 'ok' });
		const linkId = (r as { linkId: string }).linkId;

		const after = await full([debit, credit, fee]);
		const [{ seq }] = (await rows<{ seq: number }>(
			`select seq from space_seq where space_id = ?`,
			a.scope.spaceId
		)) as [{ seq: number }];
		const was = (id: string) => before.find((r) => r.id === id)!;
		const is = (id: string) => after.find((r) => r.id === id)!;
		// Wallet A's row is the transfer to B, every other column (amount, title, date, dedupe key) as before.
		expect(is(debit)).toEqual({
			...was(debit),
			type: 'transfer',
			transfer_to_wallet_id: a.B,
			category_id: null,
			category_source: null,
			updated_at: NOW,
			seq
		});
		// Wallet B's row is a content-free tombstone that keeps its id, dedupe key, batch and created_at.
		expect(is(credit)).toMatchObject({
			id: credit,
			deleted_at: NOW,
			amount_minor: null,
			currency: null,
			wallet_id: null,
			category_id: null,
			title: null,
			note: null,
			occurred_on: null,
			reference: null,
			dedupe_key: was(credit).dedupe_key,
			source: 'statement',
			created_at: was(credit).created_at,
			updated_at: NOW,
			seq
		});
		// The fee is untouched (AC-11).
		expect(is(fee)).toEqual(was(fee));
		// No more double counting; each wallet's balance is exactly what it was (AC-3, AC-10).
		expect(await inOut(a.scope.spaceId)).toEqual({ income: 0, expense: 650_000 });
		expect(await readWalletBalance(db, a.scope.spaceId, a.A)).toBe(BigInt(-FIVE_M - 650_000));
		expect(await readWalletBalance(db, a.scope.spaceId, a.B)).toBe(BigInt(FIVE_M));
		// The link holds both snapshots.
		const [link] = await rows<Record<string, unknown>>(
			`select * from transfer_links where id = ?`,
			linkId
		);
		expect(link).toMatchObject({
			space_id: a.scope.spaceId,
			debit_transaction_id: debit,
			credit_transaction_id: credit,
			created_at: NOW,
			undone_at: null,
			seq
		});
		expect(JSON.parse(link!.debit_snapshot as string)).toEqual({
			type: 'expense',
			categoryId: was(debit).category_id,
			categorySource: 'auto',
			transferToWalletId: null,
			updatedAt: NOW - 1000
		});
		expect(JSON.parse(link!.credit_snapshot as string)).toMatchObject({
			amountMinor: FIVE_M,
			currency: 'IDR',
			walletId: a.B,
			title: 'SWITCHING CR TRF BUDI SANTOSO',
			occurredOn: '2026-07-11',
			reference: 'REF-1',
			updatedAt: NOW - 1000
		});
		// The merged debit is never offered again (AC-8); the resend answers already and changes nothing (AC-15).
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
		expect(await applyTransferMatch(db, a.scope, choice(pair!), NOW + 1)).toEqual({
			status: 'already'
		});
		expect(await full([debit, credit, fee])).toEqual(after);
		expect(await rows(`select id from transfer_links where space_id = ?`, a.scope.spaceId)).toEqual(
			[{ id: linkId }]
		);
		expect((await listTransferLinks(db, a.scope.spaceId)).links).toEqual([
			{
				id: linkId,
				createdAt: NOW,
				title: 'SWITCHING DB TRF BUDI SANTOSO 009 BANK CENTRA ••••7890',
				amountMinor: FIVE_M,
				currency: 'IDR',
				occurredOn: '2026-07-10',
				fromWalletId: a.A,
				toWalletId: a.B
			}
		]);
	});

	it('20 concurrent confirms of one pair write one link; the rest answer already', async () => {
		const a = await account();
		await ownerCase(a);
		const [pair] = await pairsOf(a);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => applyTransferMatch(db, a.scope, choice(pair!), NOW))
		);
		expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
		expect(results.filter((r) => r.status === 'already')).toHaveLength(19);
		expect(
			await rows(`select count(*) as n from transfer_links where space_id = ?`, a.scope.spaceId)
		).toEqual([{ n: 1 }]);
		expect(
			await rows(
				`select count(*) as n from transactions where space_id = ? and deleted_at is not null`,
				a.scope.spaceId
			)
		).toEqual([{ n: 1 }]);
	});

	it('a row edited between review and confirm is never merged: stale, nothing written (AC-16)', async () => {
		const a = await account();
		const { debit, credit } = await ownerCase(a);
		const [pair] = await pairsOf(a);
		const tx = (await getTransaction(db, a.scope.spaceId, debit))!;
		expect(
			await updateTransaction(
				db,
				a.scope,
				debit,
				{
					type: 'expense',
					amountMinor: tx.amountMinor,
					currency: tx.currency,
					walletId: tx.walletId,
					transferToWalletId: null,
					categoryId: tx.categoryId,
					title: 'Diubah tangan',
					note: null,
					occurredOn: tx.occurredOn,
					occurredTime: ''
				},
				tx.updatedAt,
				NOW
			)
		).toBe('ok');
		expect(await applyTransferMatch(db, a.scope, choice(pair!), NOW + 1)).toEqual({
			status: 'stale'
		});
		expect(await getTransaction(db, a.scope.spaceId, debit)).toMatchObject({ type: 'expense' });
		expect(await getTransaction(db, a.scope.spaceId, credit)).toMatchObject({ type: 'income' });
		expect(await rows(`select id from transfer_links where space_id = ?`, a.scope.spaceId)).toEqual(
			[]
		);
		// Forged ids (another space's rows, a non-candidate pair): missing, same as an unknown id.
		const b = await account();
		expect(await applyTransferMatch(db, b.scope, choice(pair!), NOW + 2)).toEqual({
			status: 'missing'
		});
		expect(
			await applyTransferMatch(db, a.scope, { ...choice(pair!), creditId: newId() }, NOW + 2)
		).toEqual({ status: 'missing' });
	});

	it('a debit that is a Patungan bill or a credit with a kept photo is not offered', async () => {
		const a = await account();
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-07-10' });
		await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'IN FOTO',
			day: '2026-07-10',
			photo: true
		});
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
	});

	it('FN-48B continuity still reconciles after a merge: the batch’s printed balances and wallet B’s balance are unchanged (AC-10)', async () => {
		const a = await account();
		const batchId = newId();
		// Wallet B's July statement (10–11 July): opening 0 (B's balance before 10 July), one credit, closing Rp 5.000.000.
		await statementBatch(a, batchId, '2026-07-10', '2026-07-11');
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-07-10' });
		const credit = await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'IN',
			day: '2026-07-11',
			batch: batchId
		});
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		expect(await readWalletBalance(db, a.scope.spaceId, a.B)).toBe(BigInt(FIVE_M));

		const [pair] = await pairsOf(a);
		expect(await applyTransferMatch(db, a.scope, choice(pair!), NOW)).toMatchObject({
			status: 'ok'
		});
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		expect(await readWalletBalance(db, a.scope.spaceId, a.B)).toBe(BigInt(FIVE_M));
		expect(
			await rows(
				`select opening_balance_minor, closing_balance_minor, undone_at from import_batches where id = ?`,
				batchId
			)
		).toEqual([{ opening_balance_minor: 0, closing_balance_minor: FIVE_M, undone_at: null }]);
		expect(
			await rows(`select import_batch_id, deleted_at from transactions where id = ?`, credit)
		).toEqual([{ import_batch_id: batchId, deleted_at: NOW }]);
	});

	it('a pair straddling wallet B’s first statement’s first day leaves no gap: the credit was in that statement (QA low)', async () => {
		// The merged transfer keeps the debit's date, the day before B's statement starts on the credit's day. Its
		// credit row was a row of that statement, so B's balance before the statement does not count it again.
		const a = await account();
		const batchId = newId();
		await statementBatch(a, batchId, '2026-07-11', '2026-07-11');
		await seed(a, { wallet: a.A, type: 'expense', title: 'OUT', day: '2026-07-10' });
		await seed(a, { wallet: a.B, type: 'income', title: 'IN', day: '2026-07-11', batch: batchId });
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		const [pair] = await pairsOf(a);
		const r = await applyTransferMatch(db, a.scope, choice(pair!), NOW);
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		expect(
			await checkStatement(db, a.scope.spaceId, a.B, {
				id: batchId,
				periodFrom: '2026-07-11',
				periodTo: '2026-07-11',
				openingBalanceMinor: 0,
				closingBalanceMinor: FIVE_M
			})
		).toEqual({ status: 'pass', against: 'wallet' });
		expect(await undoTransferMatch(db, a.scope, (r as { linkId: string }).linkId, NOW + 1)).toBe(
			'ok'
		);
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
	});

	it('re-importing wallet B’s file after the merge finds its credit row already imported, never recreated (AC-6)', async () => {
		const a = await account();
		const raw = (
			title: string,
			type: 'expense' | 'income',
			walletName: string,
			categoryName: string
		): RawCsvTransaction => ({
			date: '2026-07-10',
			type,
			title,
			amountMinor: FIVE_M,
			currency: 'IDR',
			categoryName,
			walletName,
			paymentMethod: '',
			recurrence: '',
			tag: '',
			notes: '',
			reference: ''
		});
		const fileB: PreparedRows = {
			source: 'csv',
			format: 'template',
			rows: [{ index: 0, ok: true, value: raw('TRSF MASUK', 'income', 'OCBC', 'Transfer masuk') }],
			notProcessed: 0,
			keyPrefix: 'csv:berkas-b:'
		};
		const fileA: PreparedRows = {
			...fileB,
			rows: [
				{ index: 0, ok: true, value: raw('TRSF KELUAR', 'expense', 'BCA', 'Transfer keluar') }
			],
			keyPrefix: 'csv:berkas-a:'
		};
		const opts = { filename: null, fallbackWallet: null, skipPossibleDuplicates: false };
		expect(await importRows(db, a.scope, fileA, opts, NOW)).toMatchObject({
			ok: true,
			counts: { imported: 1 }
		});
		expect(await importRows(db, a.scope, fileB, opts, NOW + 1)).toMatchObject({
			ok: true,
			counts: { imported: 1 }
		});
		const [pair] = await pairsOf(a);
		expect(pair).toBeDefined();
		expect(await applyTransferMatch(db, a.scope, choice(pair!), NOW + 2)).toMatchObject({
			status: 'ok'
		});
		expect(await importRows(db, a.scope, fileB, opts, NOW + 3)).toMatchObject({
			ok: true,
			counts: { imported: 0, already: 1 }
		});
		expect(
			await rows(
				`select count(*) as n from transactions where space_id = ? and dedupe_key = 'csv:berkas-b:0'`,
				a.scope.spaceId
			)
		).toEqual([{ n: 1 }]);
		expect(await inOut(a.scope.spaceId)).toEqual({ income: 0, expense: 0 });
	});
});

describe('undoTransferMatch (AC-4, AC-14, AC-15)', () => {
	it('restores both rows exactly (same id, same created_at), once; the pair is offered again', async () => {
		const a = await account();
		const { debit, credit } = await ownerCase(a);
		const before = await full([debit, credit]);
		const [pair] = await pairsOf(a);
		const r = await applyTransferMatch(db, a.scope, choice(pair!), NOW);
		const linkId = (r as { linkId: string }).linkId;
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 5)).toBe('ok');
		const after = await full([debit, credit]);
		const [{ seq }] = (await rows<{ seq: number }>(
			`select seq from space_seq where space_id = ?`,
			a.scope.spaceId
		)) as [{ seq: number }];
		for (const row of after) {
			const was = before.find((b) => b.id === row.id)!;
			expect(row).toEqual({ ...was, updated_at: NOW + 5, seq });
		}
		expect(
			await rows(`select count(*) as n from transactions where space_id = ?`, a.scope.spaceId)
		).toEqual([{ n: 3 }]);
		expect(await inOut(a.scope.spaceId)).toEqual({ income: FIVE_M, expense: FIVE_M + 650_000 });
		expect(await rows(`select undone_at from transfer_links where id = ?`, linkId)).toEqual([
			{ undone_at: NOW + 5 }
		]);
		expect((await listTransferLinks(db, a.scope.spaceId)).links).toEqual([]);
		// Resent: already, nothing changes.
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 6)).toBe('already');
		expect(await full([debit, credit])).toEqual(after);
		// Offered again, and mergeable again into a new link.
		const [again] = await pairsOf(a);
		expect(again).toMatchObject({ debit: { id: debit }, credit: { id: credit } });
		expect(await applyTransferMatch(db, a.scope, choice(again!), NOW + 7)).toMatchObject({
			status: 'ok'
		});
	});

	it('refuses (stale) when the merged transfer was edited or deleted since; another space’s link is missing', async () => {
		const a = await account();
		const { debit } = await ownerCase(a);
		const [pair] = await pairsOf(a);
		const r = await applyTransferMatch(db, a.scope, choice(pair!), NOW);
		const linkId = (r as { linkId: string }).linkId;
		const b = await account();
		expect(await undoTransferMatch(db, b.scope, linkId, NOW + 1)).toBe('missing');
		expect(await undoTransferMatch(db, a.scope, newId(), NOW + 1)).toBe('missing');

		const tx = (await getTransaction(db, a.scope.spaceId, debit))!;
		expect(
			await updateTransaction(
				db,
				a.scope,
				debit,
				{
					type: 'transfer',
					amountMinor: tx.amountMinor,
					currency: tx.currency,
					walletId: tx.walletId,
					transferToWalletId: a.B,
					categoryId: null,
					title: 'Diubah',
					note: null,
					occurredOn: tx.occurredOn,
					occurredTime: ''
				},
				tx.updatedAt,
				NOW + 2
			)
		).toBe('ok');
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 3)).toBe('stale');
		const edited = (await getTransaction(db, a.scope.spaceId, debit))!;
		expect(edited).toMatchObject({ type: 'transfer', title: 'Diubah' });
		expect(await deleteTransaction(db, a.scope, debit, edited.updatedAt, NOW + 4)).toBe('ok');
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 5)).toBe('stale');
		expect(await rows(`select undone_at from transfer_links where id = ?`, linkId)).toEqual([
			{ undone_at: null }
		]);
	});

	it('20 concurrent undos restore once; the rest answer already', async () => {
		const a = await account();
		const { debit, credit } = await ownerCase(a);
		const [pair] = await pairsOf(a);
		const r = await applyTransferMatch(db, a.scope, choice(pair!), NOW);
		const linkId = (r as { linkId: string }).linkId;
		const results = await Promise.all(
			Array.from({ length: 20 }, () => undoTransferMatch(db, a.scope, linkId, NOW + 1))
		);
		expect(results.filter((x) => x === 'ok')).toHaveLength(1);
		expect(results.filter((x) => x === 'already')).toHaveLength(19);
		expect(await getTransaction(db, a.scope.spaceId, debit)).toMatchObject({ type: 'expense' });
		expect(await getTransaction(db, a.scope.spaceId, credit)).toMatchObject({ type: 'income' });
	});
});

describe('"Urungkan impor" meets a live link (red team M1, M2) and FN-16j move', () => {
	/** A plain (CSV-shaped) import batch row of the space, as `undoImportBatch` reads it. */
	async function plainBatch(a: Account, batchId: string) {
		await d1
			.prepare(
				`insert into import_batches (id, space_id, source, format, filename, row_count, imported_count,
					skipped_count, already_imported_count, created_by_user_id, created_at, updated_at, undone_at,
					deleted_at, seq)
				values (?, ?, 'csv', 'template', 'berkas.csv', 1, 1, 0, 0, ?, ?, ?, null, null, 1)`
			)
			.bind(batchId, a.scope.spaceId, a.scope.userId, NOW - 1000, NOW - 1000)
			.run();
	}
	const state = (id: string) =>
		rows<{ deleted_at: number | null; type: string | null; wallet_id: string | null }>(
			`select deleted_at, type, wallet_id from transactions where id = ?`,
			id
		).then((r) => r[0]!);
	const linkState = (id: string) =>
		rows<{ undone_at: number | null }>(
			`select undone_at from transfer_links where id = ?`,
			id
		).then((r) => r[0]!.undone_at);
	/** The owner's pair with the debit in batch A (wallet A) and the credit in batch B (wallet B), merged. */
	async function mergedAcrossBatches(a: Account) {
		const bA = newId();
		const bB = newId();
		await plainBatch(a, bA);
		await statementBatch(a, bB, '2026-07-10', '2026-07-11');
		const debit = await seed(a, {
			wallet: a.A,
			type: 'expense',
			title: 'OUT',
			day: '2026-07-10',
			batch: bA
		});
		const credit = await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'IN',
			day: '2026-07-11',
			batch: bB
		});
		const before = await full([debit, credit]);
		const [pair] = await pairsOf(a);
		const r = await applyTransferMatch(db, a.scope, choice(pair!), NOW);
		expect(r.status).toBe('ok');
		return { bA, bB, debit, credit, before, linkId: (r as { linkId: string }).linkId };
	}

	it('M2: undoing the debit’s import restores the other import’s credit row exactly and settles the link', async () => {
		const a = await account();
		const { bA, bB, debit, credit, before, linkId } = await mergedAcrossBatches(a);
		// A stale page writes nothing: the link stays live, the credit a tombstone.
		expect(await undoImportBatch(db, a.scope, bA, NOW - 999, NOW + 10)).toBe('stale');
		expect(await linkState(linkId)).toBeNull();
		expect((await state(credit)).deleted_at).toBe(NOW);

		expect(await undoImportBatch(db, a.scope, bA, NOW - 1000, NOW + 10)).toBe('ok');
		const [{ seq }] = (await rows<{ seq: number }>(
			`select seq from space_seq where space_id = ?`,
			a.scope.spaceId
		)) as [{ seq: number }];
		// The credit (batch B, never undone) is back as it was: same id, created_at, dedupe key, wallet B.
		const [creditNow] = await full([credit]);
		expect(creditNow).toEqual({
			...before.find((r) => r.id === credit)!,
			updated_at: NOW + 10,
			seq
		});
		// The debit is batch A's content-free tombstone, as any undone import's row (`type` is not content).
		expect(await state(debit)).toMatchObject({ deleted_at: NOW + 10, wallet_id: null });
		expect(await linkState(linkId)).toBe(NOW + 10);
		expect((await listTransferLinks(db, a.scope.spaceId)).links).toEqual([]);
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 20)).toBe('already');
		expect(await inOut(a.scope.spaceId)).toEqual({ income: FIVE_M, expense: 0 });
		expect(await readWalletBalance(db, a.scope.spaceId, a.B)).toBe(BigInt(FIVE_M));
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		expect(
			await rows(
				`select undone_at from import_batches where id in (?, ?) order by undone_at`,
				bA,
				bB
			)
		).toEqual([{ undone_at: null }, { undone_at: NOW + 10 }]);
		// Repeat: already, nothing more changes.
		expect(await undoImportBatch(db, a.scope, bA, NOW + 10, NOW + 30)).toBe('already');
		expect(await full([credit])).toEqual([creditNow]);
	});

	it('M3: undoing the debit’s import restores the credit into its wallet archived since; restoring the wallet shows it', async () => {
		const a = await account();
		const { bA, credit, before, linkId } = await mergedAcrossBatches(a);
		const walletVersion = async () =>
			(await rows<{ updated_at: number }>(`select updated_at from wallets where id = ?`, a.B))[0]!
				.updated_at;
		expect(await archiveWallet(db, a.scope, a.B, await walletVersion(), NOW + 5)).toBe('ok');
		expect(await undoImportBatch(db, a.scope, bA, NOW - 1000, NOW + 10)).toBe('ok');
		// The credit is back in wallet B (archived wallets keep their rows), never lost behind a settled link.
		const [creditNow] = await full([credit]);
		expect(creditNow).toMatchObject({
			...before.find((r) => r.id === credit)!,
			updated_at: NOW + 10,
			seq: expect.any(Number)
		});
		expect(await linkState(linkId)).toBe(NOW + 10);
		expect(await restoreWallet(db, a.scope, a.B, await walletVersion(), NOW + 20)).toBe('ok');
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 30)).toBe('already');
		expect((await state(credit)).deleted_at).toBeNull();
		expect(await readWalletBalance(db, a.scope.spaceId, a.B)).toBe(BigInt(FIVE_M));
	});

	it('L3: undoing the debit’s import after the user deleted the merged transfer keeps the credit deleted and settles the link', async () => {
		const a = await account();
		const { bA, debit, credit, linkId } = await mergedAcrossBatches(a);
		const merged = (await getTransaction(db, a.scope.spaceId, debit))!;
		expect(await deleteTransaction(db, a.scope, debit, merged.updatedAt, NOW + 4)).toBe('ok');
		expect(await undoImportBatch(db, a.scope, bA, NOW - 1000, NOW + 10)).toBe('ok');
		// The user deleted the transfer: neither side comes back, and the link leaves the "Urungkan" list.
		expect((await state(credit)).deleted_at).toBe(NOW);
		expect((await state(debit)).deleted_at).not.toBeNull();
		expect(await linkState(linkId)).toBe(NOW + 10);
		expect((await listTransferLinks(db, a.scope.spaceId)).links).toEqual([]);
		expect(await inOut(a.scope.spaceId)).toEqual({ income: 0, expense: 0 });
	});

	it('M1: undoing the credit’s import settles the link and gives the debit its expense back; the credit stays a tombstone', async () => {
		const a = await account();
		const { bB, debit, credit, before, linkId } = await mergedAcrossBatches(a);
		expect(await undoImportBatch(db, a.scope, bB, NOW - 1000, NOW + 10)).toBe('ok');
		const [{ seq }] = (await rows<{ seq: number }>(
			`select seq from space_seq where space_id = ?`,
			a.scope.spaceId
		)) as [{ seq: number }];
		const [debitNow] = await full([debit]);
		expect(debitNow).toEqual({ ...before.find((r) => r.id === debit)!, updated_at: NOW + 10, seq });
		// Batch B's row stays exactly the tombstone it was; the link is settled, never offered to undo.
		expect((await state(credit)).deleted_at).toBe(NOW);
		expect(await linkState(linkId)).toBe(NOW + 10);
		expect((await listTransferLinks(db, a.scope.spaceId)).links).toEqual([]);
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 20)).toBe('already');
		expect((await state(credit)).deleted_at).toBe(NOW);
		expect(await inOut(a.scope.spaceId)).toEqual({ income: 0, expense: FIVE_M });
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
	});

	it('M1 guard: a link whose row’s import is undone can never revive that row (stale, nothing written)', async () => {
		// The settle above makes this unreachable through the UI; the guard still holds for any such state.
		const a = await account();
		const { bB, credit, linkId } = await mergedAcrossBatches(a);
		await d1
			.prepare(`update import_batches set undone_at = ? where id = ?`)
			.bind(NOW + 5, bB)
			.run();
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 20)).toBe('stale');
		expect((await state(credit)).deleted_at).toBe(NOW);
		expect(await linkState(linkId)).toBeNull();
	});

	it('both rows in one import: its undo tombstones both and settles the link without restoring either', async () => {
		const a = await account();
		const b = newId();
		await plainBatch(a, b);
		const debit = await seed(a, {
			wallet: a.A,
			type: 'expense',
			title: 'OUT',
			day: '2026-07-10',
			batch: b
		});
		const credit = await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'IN',
			day: '2026-07-10',
			batch: b
		});
		const [pair] = await pairsOf(a);
		const r = await applyTransferMatch(db, a.scope, choice(pair!), NOW);
		expect(await undoImportBatch(db, a.scope, b, NOW - 1000, NOW + 10)).toBe('ok');
		expect((await state(debit)).deleted_at).toBe(NOW + 10);
		expect((await state(credit)).deleted_at).toBe(NOW);
		expect(await linkState((r as { linkId: string }).linkId)).toBe(NOW + 10);
		expect(await inOut(a.scope.spaceId)).toEqual({ income: 0, expense: 0 });
	});

	it('a debit edited since the merge stays as edited when the credit’s import is undone; the link is still settled and the answer says so', async () => {
		const a = await account();
		const { bB, debit, linkId } = await mergedAcrossBatches(a);
		const tx = (await getTransaction(db, a.scope.spaceId, debit))!;
		expect(
			await updateTransaction(
				db,
				a.scope,
				debit,
				{
					type: 'transfer',
					amountMinor: tx.amountMinor,
					currency: tx.currency,
					walletId: tx.walletId,
					transferToWalletId: a.B,
					categoryId: null,
					title: 'Diubah',
					note: null,
					occurredOn: tx.occurredOn,
					occurredTime: ''
				},
				tx.updatedAt,
				NOW + 2
			)
		).toBe('ok');
		// The user is told (L2): the edited transfer is not silently left pointing at the undone import's wallet.
		expect(await undoImportBatch(db, a.scope, bB, NOW - 1000, NOW + 10)).toBe('ok_transfer_kept');
		expect(await getTransaction(db, a.scope.spaceId, debit)).toMatchObject({
			type: 'transfer',
			title: 'Diubah',
			updatedAt: NOW + 2
		});
		expect(await linkState(linkId)).toBe(NOW + 10);
	});

	it('FN-16j: an import with a row in a live link cannot move (either side) until the match is undone', async () => {
		const a = await account();
		const { bA, bB, linkId } = await mergedAcrossBatches(a);
		// Batch B keeps another live row, so only the link blocks it.
		await seed(a, {
			wallet: a.B,
			type: 'income',
			title: 'LAIN',
			day: '2026-07-11',
			batch: bB,
			amount: 1000
		});
		const states = await importBatchMoveStates(db, a.scope.spaceId, [bA, bB]);
		expect(states.get(bA)).toEqual({ fromWalletId: null, moveBlocked: 'transfer_linked' });
		expect(states.get(bB)).toEqual({ fromWalletId: a.B, moveBlocked: 'transfer_linked' });
		expect(await moveImportBatch(db, a.scope, bA, a.C, NOW - 1000, NOW + 10)).toEqual({
			ok: false,
			reason: 'transfer_linked'
		});
		expect(await moveImportBatch(db, a.scope, bB, a.C, NOW - 1000, NOW + 10)).toEqual({
			ok: false,
			reason: 'transfer_linked'
		});
		expect(
			await rows(
				`select count(*) as n from transactions where space_id = ? and wallet_id = ?`,
				a.scope.spaceId,
				a.C
			)
		).toEqual([{ n: 0 }]);
		expect(await undoTransferMatch(db, a.scope, linkId, NOW + 20)).toBe('ok');
		expect((await importBatchMoveStates(db, a.scope.spaceId, [bA])).get(bA)).toEqual({
			fromWalletId: a.A,
			moveBlocked: null
		});
		expect(await moveImportBatch(db, a.scope, bA, a.C, NOW - 1000, NOW + 30)).toMatchObject({
			ok: true,
			moved: 1
		});
	});
});

describe('routes (AC-14, AC-15, AC-17)', () => {
	async function run(fn: () => unknown) {
		try {
			const value = await fn();
			if (isActionFailure(value))
				return { kind: 'fail' as const, status: value.status, data: value.data };
			return { kind: 'ok' as const, value: value as Record<string, unknown> };
		} catch (e) {
			if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
			throw e;
		}
	}
	async function ev(
		who: Account,
		url: string,
		routeId: string,
		opts: { form?: [string, string][]; spaceId?: string } = {}
	) {
		const space = await resolveCurrentSpace(db, who.user.id, opts.spaceId);
		return fakeEvent({
			url: `http://localhost${url}`,
			routeId,
			db,
			user: who.user,
			space,
			form: opts.form
		}).event as never;
	}
	const ROUTE = '/(app)/impor/cocokkan-transfer';
	const load = (who: Account, spaceId?: string) =>
		run(async () => route.load(await ev(who, '/impor/cocokkan-transfer', ROUTE, { spaceId })));
	const act = (who: Account, name: 'merge' | 'undo', form: [string, string][], spaceId?: string) =>
		run(async () =>
			(route.actions as Record<string, (e: never) => unknown>)[name]!(
				await ev(who, `/impor/cocokkan-transfer?/${name}`, ROUTE, { form, spaceId })
			)
		);
	const mergeForm = (p: TransferPair): [string, string][] => [
		['debitId', p.debit.id],
		['creditId', p.credit.id],
		['debitUpdatedAt', String(p.debit.updatedAt)],
		['creditUpdatedAt', String(p.credit.updatedAt)]
	];
	type Loaded = {
		value: {
			preview: { total: number; groups: { pairs: TransferPair[] }[] };
			links: { id: string }[];
			wallets: { id: string; name: string }[];
		};
	};

	it('the /impor card count, then load, merge and undo for a member; the result is persisted for a second device', async () => {
		const a = await account();
		const { debit, credit } = await ownerCase(a);
		const card = (await run(async () =>
			impor.load(await ev(a, '/impor', '/(app)/impor'))
		)) as unknown as { value: { transferMatchCount: number } };
		expect(card.value.transferMatchCount).toBe(1);

		const loaded = (await load(a)) as unknown as Loaded;
		expect(loaded.value.preview.total).toBe(1);
		expect(loaded.value.wallets.map((w) => w.name).sort()).toEqual(['BCA', 'Jago', 'OCBC']);
		const [pair] = loaded.value.preview.groups[0]!.pairs;
		const merged = await act(a, 'merge', mergeForm(pair!));
		expect(merged).toMatchObject({ kind: 'ok', value: { done: 'merged' } });
		// "Second device": a fresh load from D1 shows the merge and offers the undo; the card is gone.
		const again = (await load(a)) as unknown as Loaded;
		expect(again.value.preview.groups).toEqual([]);
		expect(again.value.links).toHaveLength(1);
		expect(
			(
				(await run(async () => impor.load(await ev(a, '/impor', '/(app)/impor')))) as unknown as {
					value: { transferMatchCount: number };
				}
			).value.transferMatchCount
		).toBe(0);
		expect(await act(a, 'merge', mergeForm(pair!))).toMatchObject({
			kind: 'ok',
			value: { done: 'already' }
		});
		expect(await act(a, 'undo', [['id', again.value.links[0]!.id]])).toEqual({
			kind: 'ok',
			value: { done: 'undone' }
		});
		expect(await getTransaction(db, a.scope.spaceId, debit)).toMatchObject({ type: 'expense' });
		expect(await getTransaction(db, a.scope.spaceId, credit)).toMatchObject({ type: 'income' });
		expect(await act(a, 'undo', [['id', again.value.links[0]!.id]])).toMatchObject({
			kind: 'ok',
			value: { done: 'already' }
		});
		// Malformed forms: a missing id is 400; a bad version is a stale page (409), never a write.
		expect(await act(a, 'merge', [['debitId', debit]])).toMatchObject({
			kind: 'fail',
			status: 400
		});
		const [fresh] = await pairsOf(a);
		expect(
			await act(a, 'merge', [
				['debitId', fresh!.debit.id],
				['creditId', fresh!.credit.id],
				['debitUpdatedAt', 'abc'],
				['creditUpdatedAt', String(fresh!.credit.updatedAt)]
			])
		).toMatchObject({ kind: 'fail', status: 409 });
		expect(await getTransaction(db, a.scope.spaceId, debit)).toMatchObject({ type: 'expense' });
	});

	it('QA low: every live link stays reachable to undo, 50 per page, newest first, via ?sebelum', async () => {
		const a = await account();
		// 52 live links (fictional rows that no longer exist; the list shows them as deleted), one undone.
		await d1
			.prepare(
				`with recursive k(i) as (select 1 union all select i + 1 from k where i < 53)
				insert into transfer_links (id, space_id, debit_transaction_id, credit_transaction_id, debit_snapshot,
					credit_snapshot, created_at, updated_at, undone_at, seq)
				select printf('link-%03d', i), ?, 'd-' || i, 'c-' || i, '{}',
					json_object('amountMinor', 1000 * i, 'currency', 'IDR', 'occurredOn', '2026-07-10', 'walletId', ?),
					? + (i / 2), ? + i, case when i = 53 then ? else null end, 1
				from k`
			)
			.bind(a.scope.spaceId, a.B, NOW, NOW, NOW)
			.run();
		const first = (await load(a)) as unknown as {
			value: { links: { id: string }[]; linksOlder: string | null; linksPaged: boolean };
		};
		expect(first.value.links).toHaveLength(50);
		expect(first.value.links[0]!.id).toBe('link-052');
		expect(first.value.linksPaged).toBe(false);
		expect(first.value.linksOlder).not.toBeNull();
		const older = (await run(async () =>
			route.load(
				await ev(
					a,
					`/impor/cocokkan-transfer?sebelum=${encodeURIComponent(first.value.linksOlder!)}`,
					ROUTE
				)
			)
		)) as unknown as typeof first;
		expect(older.value.links.map((l) => l.id)).toEqual(['link-002', 'link-001']);
		expect(older.value).toMatchObject({ linksOlder: null, linksPaged: true });
		const all = [...first.value.links, ...older.value.links].map((l) => l.id);
		expect(new Set(all).size).toBe(52);
		expect(all).not.toContain('link-053');
		// A forged cursor reads as the first page; another space never shows up.
		const forged = (await run(async () =>
			route.load(await ev(a, `/impor/cocokkan-transfer?sebelum=x'or'1`, ROUTE))
		)) as unknown as typeof first;
		expect(forged.value.links[0]!.id).toBe('link-052');
		const b = await account();
		expect(((await load(b)) as unknown as typeof first).value.links).toEqual([]);
	});

	it("another space's pair or link id answers 404 like any unknown id (AC-14)", async () => {
		const a = await account();
		await ownerCase(a);
		const b = await account();
		const [pair] = await pairsOf(a);
		const crossPair = await act(b, 'merge', mergeForm(pair!));
		const unknownPair = await act(b, 'merge', [
			['debitId', newId()],
			['creditId', newId()],
			['debitUpdatedAt', '1'],
			['creditUpdatedAt', '1']
		]);
		expect(crossPair).toMatchObject({ kind: 'fail', status: 404 });
		expect(crossPair).toEqual(unknownPair);
		const r = await applyTransferMatch(db, a.scope, choice(pair!), NOW);
		const linkId = (r as { linkId: string }).linkId;
		const cross = await act(b, 'undo', [['id', linkId]]);
		const unknown = await act(b, 'undo', [['id', newId()]]);
		expect(cross).toMatchObject({ kind: 'fail', status: 404 });
		expect(cross).toEqual(unknown);
		expect(await rows(`select undone_at from transfer_links where id = ?`, linkId)).toEqual([
			{ undone_at: null }
		]);
	});

	it('a removed member gets 404 on load, merge and undo (AC-14)', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		await ensurePresetCategories(db, spaceId, NOW);
		const sharedScope = { spaceId, userId: owner.user.id };
		const wallet = async (name: string) => {
			const w = await createWallet(
				db,
				sharedScope,
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
		const shared: Account = {
			...owner,
			scope: sharedScope,
			A: await wallet('Bersama A'),
			B: await wallet('Bersama B')
		};
		const { debit, credit } = await ownerCase(shared);
		expect((await load(member, spaceId)).kind).toBe('ok');
		const [pair] = await pairsOf(shared);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW + 1);
		// The removed member's session now resolves to their own space: the shared one is gone for them.
		expect((await resolveCurrentSpace(db, member.user.id, spaceId))?.id).not.toBe(spaceId);
		const asRemoved = (fn: (e: never) => unknown, form?: [string, string][]) =>
			run(async () =>
				fn(
					fakeEvent({
						url: 'http://localhost/impor/cocokkan-transfer',
						routeId: ROUTE,
						db,
						user: member.user,
						space: { id: spaceId, name: 'Keluarga', kind: 'shared', role: 'member' } as never,
						form
					}).event as never
				)
			);
		const actions = route.actions as Record<string, (e: never) => unknown>;
		expect(await asRemoved(route.load as never)).toEqual({ kind: 'error', status: 404 });
		expect(await asRemoved(actions.merge!, mergeForm(pair!))).toEqual({
			kind: 'error',
			status: 404
		});
		expect(await asRemoved(actions.undo!, [['id', newId()]])).toEqual({
			kind: 'error',
			status: 404
		});
		// And the write statements themselves refuse a scope whose membership is gone.
		expect(
			await applyTransferMatch(db, { spaceId, userId: member.user.id }, choice(pair!), NOW + 2)
		).toEqual({ status: 'stale' });
		expect(await getTransaction(db, spaceId, debit)).toMatchObject({ type: 'expense' });
		expect(await getTransaction(db, spaceId, credit)).toMatchObject({ type: 'income' });
	});
});
