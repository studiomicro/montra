import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { FN48_TILES, TILE_KEYS } from '#lib/shared/transactions';
import { applyMigration, insertLegacyWallet, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0027 (FN-39) rebuilds `categories` (and, around it, `category_budgets` and `recurring_transactions`)
 * on a database that already holds data: applied to a local D1 migrated up to 0026 and filled through every
 * table that points at a category, then checked row by row. Applied twice, as a re-run must also hold.
 */

const MIGRATION = '0027_ride_food_categories.sql';
/** The 15 tile slots before FN-39 (migration 0004), the only ones the 0026 schema accepts. */
const OLD_TILES = TILE_KEYS.filter(
	(k) => k !== 'ojek-online' && k !== 'pesan-antar-makanan' && !FN48_TILES.has(k)
);
/** 0037 (FN-48) rebuilds `categories` again with more slots: this file checks 0027 up to it (0037 has its own). */
const NEXT_REBUILD = '0037_fn48_categories.sql';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const T = Date.parse('2026-10-08T03:00:00Z');

let n = 0;
async function space() {
	const email = `migrasi${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		T
	);
	if (!r.ok) throw new Error('setup failed');
	const s = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const w = await insertLegacyWallet(
		d1,
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
	return { spaceId: s.id, walletId: w.id };
}

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

/** Every row of the four tables that reference `categories`, with the columns the migration must keep. */
async function snapshot() {
	return {
		categories: await rows(
			`select id, space_id, kind, name, tile_key, is_preset, is_hidden, sort_order, created_at, updated_at,
				deleted_at, seq from categories order by id`
		),
		transactions: await rows(
			`select id, category_id, recurring_series_id, updated_at, seq from transactions order by id`
		),
		drafts: await rows(`select id, category_id, updated_at, seq from drafts order by id`),
		recurring: await rows(
			`select id, category_id, status, next_run_on, updated_at, seq from recurring_transactions order by id`
		),
		budgets: await rows(
			`select id, space_id, category_id, amount_minor, deleted_at, updated_at, seq from category_budgets
				order by id`
		)
	};
}

let a: Awaited<ReturnType<typeof space>>;
let b: Awaited<ReturnType<typeof space>>;
let before: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	db = getDb(d1);
	a = await space();
	b = await space();
	for (const [s, prefix] of [
		[a, 'a'],
		[b, 'b']
	] as const) {
		for (const [i, tile] of OLD_TILES.entries())
			await run(
				`insert into categories values (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, null, 1)`,
				`${prefix}-${tile}`,
				s.spaceId,
				['gaji', 'bonus', 'freelance', 'hadiah', 'lain'].includes(tile) ? 'income' : 'expense',
				tile,
				tile,
				i,
				T,
				T
			);
	}
	await run(
		`insert into categories values ('a-custom', ?, 'expense', 'Ngopi sore', 'kopi', 0, 1, 15, ?, ?, null, 2)`,
		a.spaceId,
		T,
		T + 5
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
	await run(
		`insert into recurring_transactions (id, space_id, type, status, created_at, updated_at, deleted_at, seq)
		values ('r-gone', ?, 'expense', 'stopped', ?, ?, ?, 4)`,
		a.spaceId,
		T,
		T + 1,
		T + 1
	);
	const tx = (id: string, s: typeof a, category: string | null, series: string | null) =>
		run(
			`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
				occurred_on, occurred_at, source, created_at, updated_at, seq, recurring_series_id)
			values (?, ?, 'expense', 2500000, 'IDR', ?, ?, 'Kopi', '2026-10-08', ?, 'manual', ?, ?, 5, ?)`,
			id,
			s.spaceId,
			category,
			s.walletId,
			T,
			T,
			T + 7,
			series
		);
	await tx('t-1', a, 'a-kopi', null);
	await tx('t-2', a, 'a-custom', null);
	await tx('t-3', a, 'a-tempat-tinggal', 'r-live');
	await tx('t-4', a, null, null);
	await tx('t-5', b, 'b-makan', null);
	await run(
		`insert into transactions (id, space_id, type, created_at, updated_at, deleted_at, seq)
		values ('t-gone', ?, 'expense', ?, ?, ?, 6)`,
		a.spaceId,
		T,
		T + 9,
		T + 9
	);
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
		`insert into drafts (id, space_id, type, amount_minor, currency, occurred_on, occurred_at, source,
			created_at, updated_at, seq)
		values ('d-2', ?, 'expense', 1000000, 'IDR', '2026-10-08', ?, 'voice', ?, ?, 8)`,
		a.spaceId,
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
		`insert into category_budgets values ('cb-2', ?, 'a-belanja', 0, 'IDR', ?, ?, ?, 10)`,
		a.spaceId,
		T,
		T + 2,
		T + 2
	);
	await run(
		`insert into category_budgets values ('cb-3', ?, 'b-belanja', 80000000, 'IDR', ?, ?, null, 11)`,
		b.spaceId,
		T,
		T
	);
	before = await snapshot();
	for (const file of readdirSync('migrations')
		.filter((f) => f.endsWith('.sql') && f >= MIGRATION && f < NEXT_REBUILD)
		.sort())
		await applyMigration(d1, file);
});
afterAll(() => dispose());

describe('migration 0027 on a database with data', () => {
	it('keeps every row and every category link, with no updated_at or seq change', async () => {
		expect(before.transactions).toHaveLength(6);
		expect(before.categories).toHaveLength(31);
		expect(await snapshot()).toEqual(before);
	});

	it('leaves no scratch table behind and no broken foreign key', async () => {
		const leftovers = await rows<{ name: string }>(
			`select name from sqlite_master where name like '\\_\\_%' escape '\\'`
		);
		expect(leftovers).toEqual([]);
		expect(await rows(`pragma foreign_key_check`)).toEqual([]);
	});

	it('accepts all 17 tile slots and refuses an 18th', async () => {
		for (const tile of ['ojek-online', 'pesan-antar-makanan'])
			await run(
				`insert into categories values (?, ?, 'expense', ?, ?, 1, 0, 40, ?, ?, null, 12)`,
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

	it('enforces every category foreign key again', async () => {
		// A budget may only name a category of its own space (composite foreign key).
		await expect(
			run(
				`insert into category_budgets values ('cb-x', ?, 'b-kopi', 100, 'IDR', ?, ?, null, 13)`,
				a.spaceId,
				T,
				T
			)
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
		await expect(
			run(`update transactions set category_id = 'nope' where id = 't-1'`)
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
		await expect(run(`update drafts set category_id = 'nope' where id = 'd-1'`)).rejects.toThrow(
			/FOREIGN KEY constraint failed/
		);
		await expect(
			run(`update recurring_transactions set category_id = 'nope' where id = 'r-live'`)
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
		await expect(
			run(`update transactions set recurring_series_id = 'nope' where id = 't-1'`)
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
	});

	it('still tombstones a budget together with its category (trigger recreated)', async () => {
		await run(`update categories set deleted_at = ? where id = 'b-belanja'`, T + 100);
		const [budget] = await rows<{ amount_minor: number; deleted_at: number | null }>(
			`select amount_minor, deleted_at from category_budgets where id = 'cb-3'`
		);
		expect(budget).toEqual({ amount_minor: 0, deleted_at: T + 100 });
	});

	it('runs again on the same database with the same end state', async () => {
		const once = await snapshot();
		const schema = await rows(
			`select type, name, tbl_name, sql from sqlite_master where name not like '_cf_%' order by type, name`
		);
		await applyMigration(d1, MIGRATION);
		expect(await snapshot()).toEqual(once);
		expect(
			await rows(
				`select type, name, tbl_name, sql from sqlite_master where name not like '_cf_%' order by type, name`
			)
		).toEqual(schema);
	});
});
