import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import {
	applyCleanup,
	countCleanupCandidates,
	latestCleanup,
	previewCleanup,
	undoCleanup
} from '#lib/server/categories/cleanup';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { saveDrafts, setDraftsCategory } from '#lib/server/drafts/repo';
import { importRows, type PreparedRows } from '#lib/server/imports/csv-import';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { getTransaction, updateTransaction } from '#lib/server/transactions/repo';
import { newId } from '#lib/server/util';
import { createWallet } from '#lib/server/wallets/repo';
import type { RawCsvTransaction } from '#lib/shared/csv';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-48 Part A on a local D1: the bank-narrative layer at import time (statement and spreadsheet paths), the
 * `category_source` marker, and "Rapikan kategori" preview → apply → undo, across two users and two spaces.
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const route = await import('../../src/routes/(app)/impor/rapikan-kategori/+page.server');
const edit = await import('../../src/routes/(app)/riwayat/[id]/edit/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = Date.parse('2026-10-11T03:00:00Z');

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function account() {
	const email = `rapikan${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	await ensurePresetCategories(db, space.id, NOW);
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
	return { user: { id: r.userId, email, name: 'Uji', createdAt: 0 }, scope, walletId: w.id };
}
type Account = Awaited<ReturnType<typeof account>>;

const rows = async <R>(sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all<R>()
	).results;

/** The space's category id by tile and kind ("Transfer" exists once per kind). */
async function cat(spaceId: string, tile: string, kind: 'expense' | 'income' = 'expense') {
	const all = await listCategories(db, spaceId, { includeHidden: true });
	return all.find((c) => c.tileKey === tile && c.kind === kind && c.isPreset)!.id;
}

/** The import fallback "Lainnya" (expense, `lain` tile) as an import creates it. */
async function lainnya(spaceId: string) {
	const id = newId();
	await d1
		.prepare(
			`insert into categories values (?, ?, 'expense', 'Lainnya', 'lain', 0, 0, 900, ?, ?, null, 1)`
		)
		.bind(id, spaceId, NOW, NOW)
		.run();
	return id;
}

interface Seed {
	title: string;
	type?: 'expense' | 'income';
	category: string;
	source?: string;
	categorySource?: 'auto' | 'user' | null;
	edited?: boolean;
	demo?: boolean;
	day?: string;
}

/** A transaction written straight into D1 (as an import before or after migration 0037 would leave it). */
async function seed(a: Account, s: Seed) {
	const id = newId();
	await d1
		.prepare(
			`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
				occurred_on, occurred_at, source, dedupe_key, is_demo, created_at, updated_at, seq, category_source)
			values (?, ?, ?, 1250000, 'IDR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
		)
		.bind(
			id,
			a.scope.spaceId,
			s.type ?? 'expense',
			s.category,
			a.walletId,
			s.title,
			s.day ?? '2026-10-01',
			NOW,
			s.source ?? 'statement',
			(s.source ?? 'statement') === 'manual' ? null : `statement:uji:${id}`,
			s.demo ? 1 : 0,
			NOW,
			s.edited ? NOW + 5 : NOW,
			s.categorySource === undefined ? null : s.categorySource
		)
		.run();
	return id;
}

const raw = (title: string, type: 'expense' | 'income', categoryName = ''): RawCsvTransaction => ({
	date: '2026-10-02',
	type,
	title,
	amountMinor: 1_000_000,
	currency: 'IDR',
	categoryName,
	walletName: '',
	paymentMethod: '',
	recurrence: '',
	tag: '',
	notes: '',
	reference: ''
});

/** The owner's sample narratives (masked), PRD AC-1 … AC-11, with the parser's DB/CR kind. */
const VECTORS: [string, 'expense' | 'income', string][] = [
	['BIAYA ADM', 'expense', 'Biaya Bank'],
	['BUNGA', 'income', 'Bunga'],
	['PAJAK BUNGA', 'expense', 'Pajak'],
	['TARIKAN ATM 19/••••0872', 'expense', 'Tarik Tunai'],
	['KARTU KREDIT/PL 0806 WSIDZX••••0100 BCA', 'expense', 'Kartu Kredit'],
	['KARTU DEBIT KACAMATAMOO ••••0872', 'expense', 'Lainnya'],
	['TRSF E-BANKING DB 10/01 ZQ181 ERWIN PRIA', 'expense', 'Transfer keluar'],
	['TRSF E-BANKING CR 1407/FTSCY/WS95031', 'income', 'Transfer masuk'],
	['BI-FAST CR BIF TRANSFER DR 009 BUDI SA', 'income', 'Transfer masuk'],
	['SWITCHING CR TRF CIPTA KREASI ABDI', 'income', 'Transfer masuk'],
	['SWITCHING DB BIAYA TXN KE 009 BANK', 'expense', 'Biaya Bank']
];

const prepared = (source: PreparedRows['source'], list: RawCsvTransaction[]): PreparedRows => ({
	source,
	format: null,
	rows: list.map((value, index) => ({ index, ok: true as const, value })),
	notProcessed: 0,
	keyPrefix: `${source}:${newId()}:`
});

async function importedRows(spaceId: string) {
	return rows<{ title: string; type: string; category: string | null; category_source: string }>(
		`select t.title, t.type, c.name as category, t.category_source from transactions t
		left join categories c on c.id = t.category_id where t.space_id = ? and t.deleted_at is null
		order by t.title, t.type`,
		spaceId
	);
}

describe('import-time categories (AC-1 … AC-13)', () => {
	it('a statement import puts every bank narrative in its category, type untouched, marked auto', async () => {
		const a = await account();
		const list = VECTORS.map(([title, type]) => raw(title, type));
		const r = await importRows(
			db,
			a.scope,
			prepared('statement', list),
			{
				filename: null,
				fallbackWallet: { id: a.walletId, currency: 'IDR' },
				skipPossibleDuplicates: false
			},
			NOW
		);
		expect(r).toMatchObject({ ok: true, counts: { imported: VECTORS.length } });
		const got = await importedRows(a.scope.spaceId);
		for (const [title, type, category] of VECTORS)
			expect(got, title).toContainEqual({ title, type, category, category_source: 'auto' });
	});

	it('the same rows read twice give the same categories (AC-13)', async () => {
		const a = await account();
		const b = await account();
		for (const who of [a, b])
			await importRows(
				db,
				who.scope,
				prepared(
					'statement',
					VECTORS.map(([title, type]) => raw(title, type))
				),
				{
					filename: null,
					fallbackWallet: { id: who.walletId, currency: 'IDR' },
					skipPossibleDuplicates: false
				},
				NOW
			);
		const names = async (who: Account) =>
			(await importedRows(who.scope.spaceId)).map((r) => [r.title, r.category]);
		expect(await names(a)).toEqual(await names(b));
	});

	it('a spreadsheet import (nothing created) uses the new layer too; a category cell stays the user’s', async () => {
		const a = await account();
		const r = await importRows(
			db,
			a.scope,
			prepared('spreadsheet', [
				raw('BIAYA ADM', 'expense'),
				raw('TRSF E-BANKING CR 1407/FTSCY', 'income'),
				raw('TARIKAN ATM 19/0872', 'expense', 'Kopi')
			]),
			{
				filename: null,
				fallbackWallet: { id: a.walletId, currency: 'IDR' },
				skipPossibleDuplicates: false,
				createMissing: false
			},
			NOW
		);
		expect(r).toMatchObject({ ok: true, counts: { imported: 3 } });
		expect(await importedRows(a.scope.spaceId)).toEqual([
			{ title: 'BIAYA ADM', type: 'expense', category: 'Biaya Bank', category_source: 'auto' },
			{ title: 'TARIKAN ATM 19/0872', type: 'expense', category: 'Kopi', category_source: 'user' },
			{
				title: 'TRSF E-BANKING CR 1407/FTSCY',
				type: 'income',
				category: 'Transfer masuk',
				category_source: 'auto'
			}
		]);
	});

	it('history that only remembers "Lainnya" for a narrative no longer keeps the next import there', async () => {
		const a = await account();
		const other = await lainnya(a.scope.spaceId);
		for (let i = 0; i < 3; i++)
			await seed(a, { title: 'BIAYA ADM', category: other, day: `2026-09-0${i + 1}` });
		await importRows(
			db,
			a.scope,
			prepared('statement', [raw('BIAYA ADM', 'expense')]),
			{
				filename: null,
				fallbackWallet: { id: a.walletId, currency: 'IDR' },
				skipPossibleDuplicates: false
			},
			NOW
		);
		const fresh = await rows<{ category: string }>(
			`select c.name as category from transactions t join categories c on c.id = t.category_id
			where t.space_id = ? and t.occurred_on = '2026-10-02'`,
			a.scope.spaceId
		);
		expect(fresh).toEqual([{ category: 'Biaya Bank' }]);
	});

	it('a space’s own rule still wins over the narrative (AC-12)', async () => {
		const a = await account();
		const kopi = await cat(a.scope.spaceId, 'kopi');
		await d1
			.prepare(
				`insert into merchant_rules (id, space_id, match_key, merchant_name, category_id, kind, hits, source,
					created_by, created_at, updated_at, deleted_at, seq)
				values (?, ?, 'biaya adm', 'Biaya Adm', ?, 'expense', 1, 'correction', ?, ?, ?, null, 1)`
			)
			.bind(newId(), a.scope.spaceId, kopi, a.scope.userId, NOW, NOW)
			.run();
		await importRows(
			db,
			a.scope,
			prepared('statement', [raw('BIAYA ADM', 'expense')]),
			{
				filename: null,
				fallbackWallet: { id: a.walletId, currency: 'IDR' },
				skipPossibleDuplicates: false
			},
			NOW
		);
		expect((await importedRows(a.scope.spaceId))[0]).toMatchObject({ category: 'Kopi' });
	});
});

describe('category_source marker', () => {
	it('the edit form marks a row user; a draft saved after "Atur kategori" is user, else auto', async () => {
		const a = await account();
		const other = await lainnya(a.scope.spaceId);
		const id = await seed(a, { title: 'BIAYA ADM', category: other, categorySource: 'auto' });
		const tx = (await getTransaction(db, a.scope.spaceId, id))!;
		expect(
			await updateTransaction(
				db,
				a.scope,
				id,
				{
					type: 'expense',
					amountMinor: tx.amountMinor,
					currency: tx.currency,
					walletId: tx.walletId,
					transferToWalletId: null,
					categoryId: other,
					title: tx.title,
					note: null,
					occurredOn: tx.occurredOn,
					occurredTime: ''
				},
				tx.updatedAt,
				NOW + 10
			)
		).toBe('ok');
		const [marked] = await rows<{ s: string }>(
			`select category_source as s from transactions where id = ?`,
			id
		);
		expect(marked).toEqual({ s: 'user' });

		const draft = (picked: boolean) => {
			const draftId = newId();
			return d1
				.prepare(
					`insert into drafts (id, space_id, type, amount_minor, currency, title, category_id, wallet_id,
						occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq)
					values (?, ?, 'expense', 500000, 'IDR', ?, ?, ?, '2026-10-03', ?, 'gmail', ?, ?, ?, 1)`
				)
				.bind(
					draftId,
					a.scope.spaceId,
					picked ? 'PICKED' : 'GUESSED',
					other,
					a.walletId,
					NOW,
					`gmail:${draftId}`,
					NOW,
					NOW
				)
				.run()
				.then(() => draftId);
		};
		const picked = await draft(true);
		const guessed = await draft(false);
		expect(
			await setDraftsCategory(db, a.scope, [{ id: picked, updatedAt: NOW }], other, NOW + 1)
		).toMatchObject({ ok: true });
		const [p] = await rows<{ updated_at: number }>(
			`select updated_at from drafts where id = ?`,
			picked
		);
		expect(
			await saveDrafts(
				db,
				a.scope,
				[
					{ id: picked, updatedAt: p!.updated_at },
					{ id: guessed, updatedAt: NOW }
				],
				NOW + 2
			)
		).toMatchObject({ ok: true, saved: 2 });
		expect(
			await rows(
				`select title, category_source from transactions where space_id = ? and source = 'gmail'
				order by title`,
				a.scope.spaceId
			)
		).toEqual([
			{ title: 'GUESSED', category_source: 'auto' },
			{ title: 'PICKED', category_source: 'user' }
		]);
	});
});

/** One space with every eligibility case (PRD AC-25, AC-26, AC-29, owner decisions 5, 6, 8). */
async function cleanupSpace() {
	const a = await account();
	const other = await lainnya(a.scope.spaceId);
	const otherIncome = await cat(a.scope.spaceId, 'lain', 'income');
	const ids = {
		fee: await seed(a, { title: 'BIAYA ADM', category: other, day: '2026-10-05' }),
		interest: await seed(a, {
			title: 'BUNGA',
			type: 'income',
			category: otherIncome,
			categorySource: 'auto',
			day: '2026-10-04'
		}),
		demo: await seed(a, {
			title: 'TARIKAN ATM 19/0872',
			category: other,
			demo: true,
			categorySource: 'auto',
			day: '2026-10-03'
		}),
		unknown: await seed(a, { title: 'KARTU DEBIT KACAMATAMOO 0872', category: other }),
		legacyEdited: await seed(a, { title: 'BIAYA ADM', category: other, edited: true }),
		handPicked: await seed(a, { title: 'BIAYA ADM', category: other, categorySource: 'user' }),
		manual: await seed(a, { title: 'BIAYA ADM', category: other, source: 'manual' }),
		realCategory: await seed(a, {
			title: 'BIAYA ADM',
			category: await cat(a.scope.spaceId, 'tagihan'),
			categorySource: 'auto'
		})
	};
	return { a, ids, other, otherIncome };
}

/** Every column of `ids`, for byte-for-byte comparisons. */
const full = (ids: string[]) =>
	rows<Record<string, unknown>>(
		`select * from transactions where id in (select value from json_each(?)) order by id`,
		JSON.stringify(ids)
	);

describe('previewCleanup (AC-17, AC-25, AC-26, AC-29, AC-30)', () => {
	it('lists only untouched captured fallback rows with a better category, demo rows badged', async () => {
		const { a, ids } = await cleanupSpace();
		// Eligible: fee, interest, demo, unknown (no better category, so not proposed).
		expect(await countCleanupCandidates(db, a.scope.spaceId)).toBe(4);
		const preview = await previewCleanup(db, a.scope, NOW);
		expect(preview.total).toBe(4);
		expect(preview.scanned).toBe(4);
		expect(
			preview.proposals.map((p) => [p.id, p.toCategoryId, p.reason, p.isDemo, p.title])
		).toEqual([
			[ids.fee, await cat(a.scope.spaceId, 'biaya-bank'), 'narrative', false, 'BIAYA ADM'],
			[ids.interest, await cat(a.scope.spaceId, 'bunga', 'income'), 'narrative', false, 'BUNGA'],
			[
				ids.demo,
				await cat(a.scope.spaceId, 'tarik-tunai'),
				'narrative',
				true,
				'TARIKAN ATM 19/0872'
			]
		]);
	});

	it('another space sees none of it (AC-27)', async () => {
		await cleanupSpace();
		const b = await account();
		expect(await countCleanupCandidates(db, b.scope.spaceId)).toBe(0);
		expect((await previewCleanup(db, b.scope, NOW)).proposals).toEqual([]);
	});

	it('reviews the newest 500 and still counts every eligible row (AC-30, AC-36)', async () => {
		const a = await account();
		const other = await lainnya(a.scope.spaceId);
		await d1
			.prepare(
				`with recursive k(i) as (select 1 union all select i + 1 from k where i < 505)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
					occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq, category_source)
				select 'bulk-' || ? || '-' || i, ?, 'expense', 650000, 'IDR', ?, ?, 'BIAYA ADM',
					date('2025-01-01', '+' || i || ' days'), ?, 'statement', 'statement:bulk:' || i, ?, ?, 1, 'auto'
				from k`
			)
			.bind(a.scope.spaceId, a.scope.spaceId, other, a.walletId, NOW, NOW, NOW)
			.run();
		const preview = await previewCleanup(db, a.scope, NOW);
		expect(preview).toMatchObject({ total: 505, scanned: 500 });
		expect(preview.proposals).toHaveLength(500);
		// Newest first: the five oldest days are left for the next run.
		expect(preview.proposals.map((p) => p.occurredOn)).not.toContain('2025-01-02');

		// Applying all 500 ids (bound once as JSON, two write chunks) changes exactly those rows; undo restores them.
		const batchId = newId();
		const applied = await applyCleanup(
			db,
			a.scope,
			batchId,
			preview.proposals.map((p) => p.id),
			NOW + 1
		);
		expect(applied).toEqual({ status: 'ok', applied: 500, changed: 0, updatedAt: NOW + 1 });
		expect(await countCleanupCandidates(db, a.scope.spaceId)).toBe(5);
		const latest = (await latestCleanup(db, a.scope.spaceId))!;
		expect(latest).toMatchObject({ id: batchId, rowCount: 500 });
		expect(await undoCleanup(db, a.scope, batchId, latest.updatedAt, NOW + 2)).toEqual({
			status: 'ok',
			reverted: 500,
			kept: 0
		});
		const [left] = await rows<{ n: number }>(
			`select count(*) as n from transactions where space_id = ? and category_id = ?`,
			a.scope.spaceId,
			other
		);
		expect(left).toEqual({ n: 505 });
	});
});

describe('applyCleanup and undoCleanup (AC-19 … AC-24, AC-34, AC-35, AC-39)', () => {
	it('changes only the ticked rows and only category_id, updated_at and seq; a resend changes nothing', async () => {
		const { a, ids, other, otherIncome } = await cleanupSpace();
		const all = Object.values(ids);
		const before = await full(all);
		const batchId = newId();
		// The interest row is unticked (AC-19); the hand-picked, manual and edited ids are sent anyway (forged).
		const sent = [ids.fee, ids.demo, ids.handPicked, ids.manual, ids.legacyEdited, ids.unknown];
		const result = await applyCleanup(db, a.scope, batchId, sent, NOW + 1);
		expect(result).toEqual({ status: 'ok', applied: 2, changed: 0, updatedAt: NOW + 1 });
		const after = await full(all);
		const [{ seq }] = (await rows<{ seq: number }>(
			`select seq from space_seq where space_id = ?`,
			a.scope.spaceId
		)) as [{ seq: number }];
		for (const [i, row] of after.entries()) {
			const old = before[i]!;
			if (row.id === ids.fee || row.id === ids.demo) {
				expect(row).toEqual({
					...old,
					category_id:
						row.id === ids.fee
							? await cat(a.scope.spaceId, 'biaya-bank')
							: await cat(a.scope.spaceId, 'tarik-tunai'),
					updated_at: NOW + 1,
					seq,
					category_source: 'auto'
				});
			} else expect(row).toEqual(old);
		}
		expect((after.find((r) => r.id === ids.interest) as { category_id: string }).category_id).toBe(
			otherIncome
		);
		// The demo row moved like a real one and stays demo (excluded from totals as before).
		expect(after.find((r) => r.id === ids.demo)).toMatchObject({ is_demo: 1 });

		// Resent (double click, replayed form): already, nothing more changes (AC-24).
		expect(await applyCleanup(db, a.scope, batchId, sent, NOW + 2)).toEqual({ status: 'already' });
		expect(await full(all)).toEqual(after);
		const batches = await rows(
			`select id, row_count from category_cleanup_batches where space_id = ?`,
			a.scope.spaceId
		);
		expect(batches).toEqual([{ id: batchId, row_count: 2 }]);
		expect(other).toBeTruthy();
	});

	it('20 concurrent applies of one review write one batch; the rest answer already', async () => {
		const { a, ids } = await cleanupSpace();
		const batchId = newId();
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				applyCleanup(db, a.scope, batchId, [ids.fee, ids.interest, ids.demo], NOW + 1)
			)
		);
		expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
		expect(results.filter((r) => r.status === 'already')).toHaveLength(19);
		const [count] = await rows<{ n: number }>(
			`select count(*) as n from category_cleanup_items where batch_id = ?`,
			batchId
		);
		expect(count).toEqual({ n: 3 });
	});

	it('a row edited by hand between review and apply is left alone (AC-39)', async () => {
		const { a, ids, other } = await cleanupSpace();
		const tx = (await getTransaction(db, a.scope.spaceId, ids.fee))!;
		const kopi = await cat(a.scope.spaceId, 'kopi');
		await updateTransaction(
			db,
			a.scope,
			ids.fee,
			{
				type: 'expense',
				amountMinor: tx.amountMinor,
				currency: tx.currency,
				walletId: tx.walletId,
				transferToWalletId: null,
				categoryId: kopi,
				title: tx.title,
				note: null,
				occurredOn: tx.occurredOn,
				occurredTime: ''
			},
			tx.updatedAt,
			NOW + 1
		);
		const r = await applyCleanup(db, a.scope, newId(), [ids.fee, ids.demo], NOW + 2);
		expect(r).toMatchObject({ status: 'ok', applied: 1 });
		expect((await getTransaction(db, a.scope.spaceId, ids.fee))!.categoryId).toBe(kopi);
		expect(other).toBeTruthy();
	});

	it('undo restores exactly the previous category, skips a row changed since, and runs once (AC-22 … AC-24)', async () => {
		const { a, ids, other, otherIncome } = await cleanupSpace();
		const batchId = newId();
		await applyCleanup(db, a.scope, batchId, [ids.fee, ids.interest, ids.demo], NOW + 1);
		const applied = await full([ids.fee, ids.interest, ids.demo]);
		// The demo row's category is changed by hand after the clean-up (AC-23).
		const demo = (await getTransaction(db, a.scope.spaceId, ids.demo))!;
		const kopi = await cat(a.scope.spaceId, 'kopi');
		expect(
			await updateTransaction(
				db,
				a.scope,
				ids.demo,
				{
					type: 'expense',
					amountMinor: demo.amountMinor,
					currency: demo.currency,
					walletId: demo.walletId,
					transferToWalletId: null,
					categoryId: kopi,
					title: demo.title,
					note: null,
					occurredOn: demo.occurredOn,
					occurredTime: ''
				},
				demo.updatedAt,
				NOW + 2
			)
		).toBe('ok');
		const latest = (await latestCleanup(db, a.scope.spaceId))!;
		// A stale form (old version) is refused before anything changes.
		expect(await undoCleanup(db, a.scope, batchId, latest.updatedAt - 1, NOW + 3)).toEqual({
			status: 'stale'
		});
		expect(await undoCleanup(db, a.scope, batchId, latest.updatedAt, NOW + 3)).toEqual({
			status: 'ok',
			reverted: 2,
			kept: 1
		});
		const undone = await full([ids.fee, ids.interest, ids.demo]);
		const [{ seq }] = (await rows<{ seq: number }>(
			`select seq from space_seq where space_id = ?`,
			a.scope.spaceId
		)) as [{ seq: number }];
		for (const row of undone) {
			const was = applied.find((r) => r.id === row.id)!;
			if (row.id === ids.demo) {
				expect(row.category_id).toBe(kopi);
				continue;
			}
			expect(row).toEqual({
				...was,
				category_id: row.id === ids.fee ? other : otherIncome,
				updated_at: NOW + 3,
				seq,
				category_source: 'auto'
			});
		}
		// Resent: already, nothing changes; the batch no longer offers an undo.
		expect(await undoCleanup(db, a.scope, batchId, latest.updatedAt, NOW + 4)).toEqual({
			status: 'already'
		});
		expect(await full([ids.fee, ids.interest, ids.demo])).toEqual(undone);
		expect(await latestCleanup(db, a.scope.spaceId)).toBeNull();
		// A row from before 0037 (no marker, now edited by the clean-up) can be proposed again after the undo.
		const again = (await previewCleanup(db, a.scope, NOW + 5)).proposals.map((p) => p.id);
		expect(again).toContain(ids.fee);
		expect(again).not.toContain(ids.demo);
	});

	it("space B cannot apply space A's rows nor undo space A's batch (AC-27)", async () => {
		const { a, ids } = await cleanupSpace();
		const b = await account();
		expect(await applyCleanup(db, b.scope, newId(), [ids.fee], NOW + 1)).toEqual({
			status: 'none'
		});
		const batchId = newId();
		await applyCleanup(db, a.scope, batchId, [ids.fee], NOW + 1);
		const latest = (await latestCleanup(db, a.scope.spaceId))!;
		expect(await undoCleanup(db, b.scope, batchId, latest.updatedAt, NOW + 2)).toEqual({
			status: 'missing'
		});
		// B reusing A's batch id as its own nonce writes nothing and learns nothing about A.
		const bRow = await seed(b, { title: 'BIAYA ADM', category: await lainnya(b.scope.spaceId) });
		expect(await applyCleanup(db, b.scope, batchId, [bRow], NOW + 3)).toEqual({ status: 'stale' });
		expect((await getTransaction(db, b.scope.spaceId, bRow))!.categoryId).not.toBe(
			await cat(b.scope.spaceId, 'biaya-bank')
		);
		expect((await latestCleanup(db, a.scope.spaceId))!.id).toBe(batchId);
	});
});

describe('routes (AC-17, AC-18, AC-20, AC-27, AC-28)', () => {
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
		opts: { form?: [string, string][]; spaceId?: string; params?: Record<string, string> } = {}
	) {
		const space = await resolveCurrentSpace(db, who.user.id, opts.spaceId);
		return fakeEvent({
			url: `http://localhost${url}`,
			routeId,
			db,
			user: who.user,
			space,
			form: opts.form,
			params: opts.params
		}).event as never;
	}
	const ROUTE = '/(app)/impor/rapikan-kategori';
	const load = (who: Account, spaceId?: string) =>
		run(async () => route.load(await ev(who, '/impor/rapikan-kategori', ROUTE, { spaceId })));
	const act = (who: Account, name: 'apply' | 'undo', form: [string, string][], spaceId?: string) =>
		run(async () =>
			(route.actions as Record<string, (e: never) => unknown>)[name]!(
				await ev(who, `/impor/rapikan-kategori?/${name}`, ROUTE, { form, spaceId })
			)
		);

	it('load, apply and undo for a member; the result is persisted for a second device', async () => {
		const { a, ids } = await cleanupSpace();
		const loaded = await load(a);
		expect(loaded.kind).toBe('ok');
		const value = (
			loaded as unknown as { value: { batchId: string; preview: { proposals: { id: string }[] } } }
		).value;
		expect(value.preview.proposals.map((p) => p.id)).toEqual([ids.fee, ids.interest, ids.demo]);
		const applied = await act(a, 'apply', [
			['batchId', value.batchId],
			['id', ids.fee],
			['id', ids.demo]
		]);
		expect(applied).toEqual({ kind: 'ok', value: { done: 'applied', applied: 2, changed: 0 } });
		// "Second device": a fresh load from D1 shows the change and offers the undo.
		const again = (await load(a)) as unknown as {
			value: {
				latest: { id: string; updatedAt: number };
				preview: { proposals: { id: string }[] };
			};
		};
		expect(again.value.preview.proposals.map((p) => p.id)).toEqual([ids.interest]);
		expect(again.value.latest.id).toBe(value.batchId);
		expect(
			await act(a, 'apply', [
				['batchId', value.batchId],
				['id', ids.fee]
			])
		).toMatchObject({ kind: 'ok', value: { done: 'already' } });
		expect(
			await act(a, 'undo', [
				['id', again.value.latest.id],
				['updatedAt', String(again.value.latest.updatedAt)]
			])
		).toEqual({ kind: 'ok', value: { done: 'undone', reverted: 2, kept: 0 } });
		expect(await act(a, 'apply', [['batchId', newId()]])).toMatchObject({
			kind: 'fail',
			status: 400
		});
	});

	it("another space's batch id answers 404 like any unknown id (AC-27)", async () => {
		const { a, ids } = await cleanupSpace();
		const b = await account();
		const batchId = newId();
		await applyCleanup(db, a.scope, batchId, [ids.fee], NOW + 1);
		const latest = (await latestCleanup(db, a.scope.spaceId))!;
		const cross = await act(b, 'undo', [
			['id', batchId],
			['updatedAt', String(latest.updatedAt)]
		]);
		const unknown = await act(b, 'undo', [
			['id', newId()],
			['updatedAt', String(latest.updatedAt)]
		]);
		expect(cross).toMatchObject({ kind: 'fail', status: 404 });
		expect(cross).toEqual(unknown);
	});

	it('a removed member gets 404 on load, apply and undo (AC-28)', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const shared = { ...owner, scope: { spaceId, userId: owner.user.id } };
		await ensurePresetCategories(db, spaceId, NOW);
		const w = await createWallet(
			db,
			shared.scope,
			{
				name: 'Bersama',
				type: 'bank',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: false,
				lastFour: null
			},
			NOW
		);
		if (!w.ok) throw new Error('wallet failed');
		const id = await seed(
			{ ...shared, walletId: w.id },
			{ title: 'BIAYA ADM', category: await lainnya(spaceId) }
		);
		expect((await load(member, spaceId)).kind).toBe('ok');
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW + 1);
		// The removed member's session now resolves to their own space: the shared one is gone for them.
		const space = await resolveCurrentSpace(db, member.user.id, spaceId);
		expect(space?.id).not.toBe(spaceId);
		const asRemoved = (fn: (e: never) => unknown, form?: [string, string][]) =>
			run(async () =>
				fn(
					fakeEvent({
						url: 'http://localhost/impor/rapikan-kategori',
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
		expect(
			await asRemoved(actions.apply!, [
				['batchId', newId()],
				['id', id]
			])
		).toEqual({ kind: 'error', status: 404 });
		expect(
			await asRemoved(actions.undo!, [
				['id', newId()],
				['updatedAt', '1']
			])
		).toEqual({ kind: 'error', status: 404 });
		expect((await getTransaction(db, spaceId, id))!.categoryId).not.toBe(
			await cat(spaceId, 'biaya-bank')
		);
	});

	it('the edit page shows the reason only while the stored category is the resolver’s pick (AC-31 … AC-33)', async () => {
		const a = await account();
		// Older than FN-20's 12-month history window, so the layer that answers is the narrative itself.
		const OLD = '2024-01-05';
		const fee = await cat(a.scope.spaceId, 'biaya-bank');
		const captured = await seed(a, {
			title: 'BIAYA ADM',
			category: fee,
			categorySource: 'auto',
			day: OLD
		});
		const moved = await seed(a, {
			title: 'BIAYA ADM',
			category: await cat(a.scope.spaceId, 'kopi'),
			categorySource: 'user',
			day: OLD
		});
		const manual = await seed(a, { title: 'BIAYA ADM', category: fee, source: 'manual', day: OLD });
		const reasonOf = async (id: string) => {
			const r = await run(async () =>
				edit.load(
					await ev(a, `/riwayat/${id}/edit`, '/(app)/riwayat/[id]/edit', { params: { id } })
				)
			);
			return (r as unknown as { value: { categoryReason: string | null } }).value.categoryReason;
		};
		expect(await reasonOf(captured)).toBe('narrative');
		expect(await reasonOf(moved)).toBeNull();
		expect(await reasonOf(manual)).toBeNull();
	});
});
