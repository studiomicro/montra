import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { listImportBatches } from '#lib/server/imports/repo';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createWallet } from '#lib/server/wallets/repo';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0040 (FN-48 Part B) adds five nullable columns to `import_batches` and one index: applied to a local
 * D1 migrated up to 0039 that already holds a CSV and a statement batch with their transactions, then checked row
 * by row. Run again, the five ALTERs refuse harmlessly ("duplicate column name", SQLite has no
 * `ADD COLUMN IF NOT EXISTS`) and the index statement is a no-op; nothing changes.
 */

const MIGRATION = '0040_fn48_continuity.sql';
const T = Date.parse('2026-10-11T03:00:00Z');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let spaceId = '';

const rows = async <R>(sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all<R>()
	).results;

async function snapshot() {
	return {
		batches: await rows(
			`select id, space_id, source, format, filename, row_count, imported_count, skipped_count,
				already_imported_count, created_by_user_id, created_at, updated_at, undone_at, deleted_at, seq
			from import_batches order by id`
		),
		transactions: await rows(
			`select id, import_batch_id, amount_minor, occurred_on, updated_at, seq from transactions order by id`
		)
	};
}
let before: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi40@contoh.id',
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
	// The 0039 shape, written directly (the app's insert already names the new columns).
	for (const [id, source, format] of [
		['b-csv', 'csv', 'template'],
		['b-st', 'statement', null]
	] as const) {
		await d1
			.prepare(
				`insert into import_batches (id, space_id, source, format, filename, row_count, imported_count,
					skipped_count, already_imported_count, created_by_user_id, created_at, updated_at, seq)
				values (?, ?, ?, ?, 'berkas', 2, 1, 1, 0, ?, ?, ?, 1)`
			)
			.bind(id, spaceId, source, format, r.userId, T, T)
			.run();
		await d1
			.prepare(
				`insert into transactions (id, space_id, type, amount_minor, currency, wallet_id, occurred_on,
					occurred_at, source, dedupe_key, created_at, updated_at, seq, import_batch_id, adjustment_direction)
				values (?, ?, 'adjustment', 100, 'IDR', ?, '2026-07-01', ?, ?, ?, ?, ?, 1, ?, 'increase')`
			)
			.bind(`t-${id}`, spaceId, w.id, T, source, `${source}:x:0`, T, T, id)
			.run();
	}
	before = await snapshot();
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

describe('migration 0040', () => {
	it('keeps every batch and transaction exactly; the new columns are null on existing batches', async () => {
		expect(await snapshot()).toEqual(before);
		expect(
			await rows(
				`select id, wallet_id, period_from, period_to, opening_balance_minor, closing_balance_minor
				from import_batches order by id`
			)
		).toEqual([
			{
				id: 'b-csv',
				wallet_id: null,
				period_from: null,
				period_to: null,
				opening_balance_minor: null,
				closing_balance_minor: null
			},
			{
				id: 'b-st',
				wallet_id: null,
				period_from: null,
				period_to: null,
				opening_balance_minor: null,
				closing_balance_minor: null
			}
		]);
		// The app reads the old batches as before.
		expect((await listImportBatches(db, spaceId)).map((b) => b.id).sort()).toEqual([
			'b-csv',
			'b-st'
		]);
	});

	it('adds the wallet/period index and leaves no broken foreign key', async () => {
		expect(
			await rows(
				`select name from sqlite_master where type = 'index' and name = 'import_batches_wallet_period_idx'`
			)
		).toHaveLength(1);
		expect(await rows('pragma foreign_key_check')).toEqual([]);
	});

	it('a second run refuses each ALTER harmlessly and changes nothing', async () => {
		const statements = readFileSync(`migrations/${MIGRATION}`, 'utf8')
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter(Boolean);
		for (const statement of statements) {
			if (/ALTER TABLE/.test(statement))
				await expect(d1.prepare(statement).run()).rejects.toThrow(/duplicate column/);
			else await d1.prepare(statement).run();
		}
		expect(await snapshot()).toEqual(before);
	});
});
