import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createWallet } from '#lib/server/wallets/repo';
import { FN48_TILES, TILE_KEYS } from '#lib/shared/transactions';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0037 (FN-48) rebuilds `categories` (and around it `category_budgets`, `recurring_transactions` and
 * `merchant_rules`, with `merchant_cache.category_id` set aside), adds the two clean-up tables and the two
 * `category_source` columns: applied to a local D1 migrated up to 0036 and filled through every table that points
 * at a category, then checked row by row. The rebuild part is run again (a re-run must hold); the two trailing
 * ALTERs refuse a second run harmlessly.
 */

const MIGRATION = '0037_fn48_categories.sql';
/** The 17 tile slots of the 0036 schema (0027's CHECK). */
const OLD_TILES = TILE_KEYS.filter((k) => !FN48_TILES.has(k));
const INCOME = new Set(['gaji', 'bonus', 'freelance', 'hadiah', 'lain']);

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const T = Date.parse('2026-10-11T03:00:00Z');

const run = (sql: string, ...params: unknown[]) =>
	d1
		.prepare(sql)
		.bind(...params)
		.run();
const rows = async <R>(sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all<R>()
	).results;

let n = 0;
async function space() {
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: `migrasi37-${++n}@contoh.id`,
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	const s = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const w = await createWallet(
		db,
		{ spaceId: s.id, userId: r.userId },
		{
			name: 'BCA',
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		T
	);
	if (!w.ok) throw new Error('wallet failed');
	return { spaceId: s.id, walletId: w.id, userId: r.userId };
}

/** Every row of the tables that reference `categories`, with the columns the migration must keep. */
async function snapshot() {
	return {
		categories: await rows(`select * from categories order by id`),
		transactions: await rows(
			`select id, category_id, recurring_series_id, updated_at, seq from transactions order by id`
		),
		drafts: await rows(`select id, category_id, updated_at, seq from drafts order by id`),
		recurring: await rows(`select * from recurring_transactions order by id`),
		budgets: await rows(`select * from category_budgets order by id`),
		rules: await rows(`select * from merchant_rules order by id`),
		cache: await rows(`select * from merchant_cache order by space_id, match_key, kind`)
	};
}
const schema = () =>
	rows(
		`select type, name, tbl_name, sql from sqlite_master where name not like '_cf_%' order by type, name`
	);

let a: Awaited<ReturnType<typeof space>>;
let before: Awaited<ReturnType<typeof snapshot>>;
const statements = readFileSync(`migrations/${MIGRATION}`, 'utf8')
	.split('--> statement-breakpoint')
	.map((s) => s.trim())
	.filter(Boolean);

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	db = getDb(d1);
	a = await space();
	const b = await space();
	for (const [s, prefix] of [
		[a, 'a'],
		[b, 'b']
	] as const)
		for (const [i, tile] of OLD_TILES.entries())
			await run(
				`insert into categories values (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, null, 1)`,
				`${prefix}-${tile}`,
				s.spaceId,
				INCOME.has(tile) ? 'income' : 'expense',
				tile,
				tile,
				i,
				T,
				T
			);
	await run(
		`insert into categories values ('a-lainnya', ?, 'expense', 'Lainnya', 'lain', 0, 0, 40, ?, ?, null, 2)`,
		a.spaceId,
		T,
		T + 3
	);
	await run(
		`insert into recurring_transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
			title, frequency, interval_day, start_on, next_run_on, status, created_at, updated_at, seq)
		values ('r-live', ?, 'expense', 150000000, 'IDR', 'a-tempat-tinggal', ?, 'Sewa', 'monthly', 12,
			'2026-10-01', '2026-10-12', 'active', ?, ?, 3)`,
		a.spaceId,
		a.walletId,
		T,
		T
	);
	const tx = (id: string, category: string | null, series: string | null, title = 'BIAYA ADM') =>
		run(
			`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
				occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq, recurring_series_id)
			values (?, ?, 'expense', 650000, 'IDR', ?, ?, ?, '2026-10-08', ?, 'statement', ?, ?, ?, 5, ?)`,
			id,
			a.spaceId,
			category,
			a.walletId,
			title,
			T,
			`statement:x:${id}`,
			T,
			T,
			series
		);
	await tx('t-1', 'a-lainnya', null);
	await tx('t-2', 'a-kopi', null, 'KOPI');
	await tx('t-3', 'a-tempat-tinggal', 'r-live', 'Sewa');
	await tx('t-4', null, null);
	await run(
		`insert into drafts (id, space_id, type, amount_minor, currency, category_id, wallet_id, occurred_on,
			occurred_at, source, created_at, updated_at, seq)
		values ('d-1', ?, 'expense', 4500000, 'IDR', 'a-makan', ?, '2026-10-08', ?, 'voice', ?, ?, 7)`,
		a.spaceId,
		a.walletId,
		T,
		T,
		T
	);
	await run(
		`insert into category_budgets values ('cb-1', ?, 'a-kopi', 50000000, 'IDR', ?, ?, null, 9)`,
		a.spaceId,
		T,
		T
	);
	await run(
		`insert into merchant_rules (id, space_id, match_key, merchant_name, category_id, kind, hits, source,
			created_by, created_at, updated_at, deleted_at, seq)
		values ('mr-1', ?, 'kopi', 'Kopi', 'a-kopi', 'expense', 2, 'correction', ?, ?, ?, null, 10)`,
		a.spaceId,
		a.userId,
		T,
		T
	);
	await run(
		`insert into merchant_rules (id, space_id, match_key, kind, hits, source, created_at, updated_at,
			deleted_at, seq)
		values ('mr-gone', ?, 'lama', 'expense', 1, 'correction', ?, ?, ?, 11)`,
		a.spaceId,
		T,
		T + 1,
		T + 1
	);
	await run(
		`insert into merchant_cache values (?, 'toko senja', 'expense', 'Toko Senja', 'a-belanja', 'ai', ?, ?)`,
		a.spaceId,
		T,
		T + 1e9
	);
	await run(
		`insert into merchant_cache values (?, 'toko aneh', 'expense', null, null, 'ai', ?, ?)`,
		a.spaceId,
		T,
		T + 1e9
	);
	before = await snapshot();
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

describe('migration 0037 on a database with data', () => {
	it('keeps every row and every category link (merchant rules and cache included), nothing synced as edited', async () => {
		expect(before.categories).toHaveLength(35);
		expect(before.rules).toHaveLength(2);
		expect(before.cache).toHaveLength(2);
		expect(await snapshot()).toEqual(before);
	});

	it('adds category_source as null on every existing transaction and draft, and the two empty tables', async () => {
		expect(await rows(`select distinct category_source from transactions`)).toEqual([
			{ category_source: null }
		]);
		expect(await rows(`select distinct category_source from drafts`)).toEqual([
			{ category_source: null }
		]);
		expect(await rows(`select count(*) as n from category_cleanup_batches`)).toEqual([{ n: 0 }]);
		expect(await rows(`select count(*) as n from category_cleanup_items`)).toEqual([{ n: 0 }]);
		await expect(
			run(`update transactions set category_source = 'robot' where id = 't-1'`)
		).rejects.toThrow(/CHECK constraint failed/);
		await expect(
			run(`update drafts set category_source = 'robot' where id = 'd-1'`)
		).rejects.toThrow(/CHECK constraint failed/);
	});

	it('leaves no scratch table behind and no broken foreign key', async () => {
		expect(
			await rows<{ name: string }>(
				`select name from sqlite_master where name like '\\_\\_%' escape '\\'`
			)
		).toEqual([]);
		expect(await rows(`pragma foreign_key_check`)).toEqual([]);
	});

	it('accepts all 23 tile slots (AC-16) and still refuses an unknown one', async () => {
		for (const tile of FN48_TILES)
			await run(
				`insert into categories values (?, ?, 'expense', ?, ?, 1, 0, 50, ?, ?, null, 12)`,
				`a-${tile}`,
				a.spaceId,
				tile,
				tile,
				T,
				T
			);
		await expect(
			run(
				`insert into categories values ('a-pizza', ?, 'expense', 'Pizza', 'pizza', 0, 0, 41, ?, ?, null, 12)`,
				a.spaceId,
				T,
				T
			)
		).rejects.toThrow(/CHECK constraint failed: categories_tile_key_check/);
	});

	it('enforces every category foreign key again, merchant rules included', async () => {
		for (const statement of [
			`update transactions set category_id = 'nope' where id = 't-1'`,
			`update drafts set category_id = 'nope' where id = 'd-1'`,
			`update recurring_transactions set category_id = 'nope' where id = 'r-live'`,
			`update merchant_rules set category_id = 'nope' where id = 'mr-1'`,
			`update merchant_cache set category_id = 'nope' where match_key = 'toko senja'`
		])
			await expect(run(statement)).rejects.toThrow(/FOREIGN KEY constraint failed/);
	});

	it('runs the rebuild again with the same end state; the trailing ALTERs refuse harmlessly', async () => {
		const once = await snapshot();
		const shape = await schema();
		const alters = statements.filter(
			(s) =>
				s.startsWith('ALTER TABLE `transactions` ADD') || s.startsWith('ALTER TABLE `drafts` ADD')
		);
		expect(alters).toHaveLength(2);
		expect(statements.slice(-2)).toEqual(alters);
		for (const statement of statements.slice(0, -2)) await d1.prepare(statement).run();
		for (const statement of alters)
			await expect(d1.prepare(statement).run()).rejects.toThrow(/duplicate column/);
		expect(await snapshot()).toEqual(once);
		expect(await schema()).toEqual(shape);
	});
});
