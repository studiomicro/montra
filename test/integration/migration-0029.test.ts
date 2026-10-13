import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createWallet } from '#lib/server/wallets/repo';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0029 (FN-15) rebuilds `transactions` to add `photo_key`/`photo_type`: applied to a local D1 migrated
 * up to 0028 and filled with live rows, a tombstone, a recurring link and the two tables that reference
 * transactions (a saved draft, a linked subscription), then checked row by row.
 */

const MIGRATION = '0029_receipt_photos.sql';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const T = Date.parse('2026-10-09T03:00:00Z');

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

const TX_COLUMNS = `id, space_id, type, amount_minor, currency, category_id, wallet_id, title, note, occurred_on,
	occurred_at, source, dedupe_key, is_demo, created_at, updated_at, deleted_at, seq, payment_method,
	adjustment_direction, recurring_series_id`;

async function snapshot() {
	return {
		transactions: await rows(`select ${TX_COLUMNS} from transactions order by id`),
		drafts: await rows(`select id, saved_transaction_id, updated_at, seq from drafts order by id`),
		subscriptions: await rows(
			`select id, linked_transaction_id, updated_at, seq from subscriptions order by id`
		)
	};
}

let spaceId: string;
let walletId: string;
let before: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi29@contoh.id',
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const w = await createWallet(
		db,
		{ spaceId, userId: r.userId },
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
	walletId = w.id;
	// One expense category by hand: today's presets include tiles (FN-48) the 0028 schema does not accept.
	await run(
		`insert into categories values ('c-kopi', ?, 'expense', 'Kopi', 'kopi', 1, 0, 0, ?, ?, null, 1)`,
		spaceId,
		T,
		T
	);
	await run(
		`insert into recurring_transactions (id, space_id, type, amount_minor, currency, wallet_id, category_id,
			title, frequency, interval_day, start_on, next_run_on, status, created_at, updated_at, seq)
		select 'r-1', ?, 'expense', 100000, 'IDR', ?, c.id, 'Sewa', 'monthly', 1, '2026-10-01', '2026-11-01',
			'active', ?, ?, 2 from categories c where c.space_id = ? and c.kind = 'expense' limit 1`,
		spaceId,
		walletId,
		T,
		T,
		spaceId
	);
	const tx = (id: string, source: string, dedupe: string | null, series: string | null) =>
		run(
			`insert into transactions (id, space_id, type, amount_minor, currency, wallet_id, title, note,
				occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq, payment_method,
				recurring_series_id)
			values (?, ?, 'expense', 2500000, 'IDR', ?, 'Kopi', 'catatan', '2026-10-08', ?, ?, ?, ?, ?, 3, 'QRIS', ?)`,
			id,
			spaceId,
			walletId,
			T,
			source,
			dedupe,
			T,
			T + 7,
			series
		);
	await tx('t-1', 'manual', null, null);
	await tx('t-2', 'receipt', 'receipt:00ff:0', null);
	await tx('t-3', 'manual', null, 'r-1');
	await run(
		`insert into transactions (id, space_id, type, source, dedupe_key, created_at, updated_at, deleted_at, seq)
		values ('t-gone', ?, 'expense', 'csv', 'csv:abcd:4', ?, ?, ?, 4)`,
		spaceId,
		T,
		T + 9,
		T + 9
	);
	await run(
		`insert into drafts (id, space_id, type, source, saved_transaction_id, created_at, updated_at, deleted_at, seq)
		values ('d-1', ?, 'expense', 'voice', 't-1', ?, ?, ?, 5)`,
		spaceId,
		T,
		T + 1,
		T + 1
	);
	await run(
		`insert into subscriptions (id, space_id, name, category, amount_minor, currency, billing_cycle, billing_day,
			next_charge_on, reminder_days_before, linked_transaction_id, created_at, updated_at, seq)
		values ('s-1', ?, 'Musik', 'hiburan', 5490000, 'IDR', 'monthly', 8, '2026-11-08', 3, 't-3', ?, ?, 6)`,
		spaceId,
		T,
		T
	);
	before = await snapshot();
	for (const file of readdirSync('migrations')
		.filter((f) => f.endsWith('.sql') && f >= MIGRATION)
		.sort())
		await applyMigration(d1, file);
});
afterAll(() => dispose());

describe('migration 0029 on a database with data', () => {
	it('keeps every row and every link (drafts, subscriptions, series), with no updated_at or seq change', async () => {
		expect(before.transactions).toHaveLength(4);
		expect(before.drafts).toEqual([
			{ id: 'd-1', saved_transaction_id: 't-1', updated_at: T + 1, seq: 5 }
		]);
		expect(await snapshot()).toEqual(before);
		expect(
			await rows(`select photo_key, photo_type from transactions where photo_key is not null`)
		).toEqual([]);
	});

	it('leaves no scratch table behind and no broken foreign key', async () => {
		expect(
			await rows(`select name from sqlite_master where name like '\\_\\_%' escape '\\'`)
		).toEqual([]);
		expect(await rows(`pragma foreign_key_check`)).toEqual([]);
	});

	it('keeps every index and adds the photo-key index', async () => {
		const names = (
			await rows<{ name: string }>(
				`select name from sqlite_master where type = 'index' and tbl_name = 'transactions'
					and name not like 'sqlite_%' order by name`
			)
		).map((r) => r.name);
		expect(names).toEqual([
			'transactions_dedupe_uq',
			'transactions_import_batch_idx',
			// FN-49 (migration 0041, applied after 0029 here): one live transaction per split.
			'transactions_patungan_split_uq',
			'transactions_photo_idx',
			'transactions_recurring_idx',
			'transactions_space_day_idx',
			'transactions_transfer_to_idx',
			'transactions_wallet_idx'
		]);
		await expect(
			run(
				`insert into transactions (id, space_id, type, source, dedupe_key, created_at, updated_at, deleted_at, seq)
				values ('t-dup', ?, 'expense', 'receipt', 'receipt:00ff:0', ?, ?, ?, 9)`,
				spaceId,
				T,
				T,
				T
			)
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it('a photo needs its type and one of the photo types; a tombstone keeps none', async () => {
		await run(
			`update transactions set photo_key = 'spaces/x/receipts/1', photo_type = 'image/webp' where id = 't-1'`
		);
		await expect(run(`update transactions set photo_type = null where id = 't-1'`)).rejects.toThrow(
			/CHECK constraint failed: transactions_photo_check/
		);
		await expect(
			run(`update transactions set photo_type = 'image/gif' where id = 't-1'`)
		).rejects.toThrow(/CHECK constraint failed/);
		await expect(
			run(
				`update transactions set deleted_at = ?, amount_minor = null, currency = null, wallet_id = null,
					category_id = null, occurred_on = null, occurred_at = null, title = null, note = null
				where id = 't-1'`,
				T + 20
			)
		).rejects.toThrow(/CHECK constraint failed: transactions_content_check/);
	});
});
