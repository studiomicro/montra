import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0048 (FN-48d) adds `transfer_links.source` with `ALTER TABLE … ADD` and a column CHECK, plus the
 * partial `transactions_space_amount_idx`: applied to a local D1 migrated up to 0047 holding a live and an undone
 * FN-48 Part C link, then checked (every row kept and read as `manual`, the CHECK refusing another value, the index
 * present), then applied again (the ALTER refuses a second run with "duplicate column" and nothing changes).
 */

const MIGRATION = '0048_transfer_auto_match.sql';
const T = Date.parse('2026-10-15T03:00:00Z');

let d1: D1Database;
let dispose: () => Promise<void>;
let spaceId = '';

const rows = async (sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all()
	).results;
const link = (id: string, undoneAt: number | null, source?: string) =>
	d1
		.prepare(
			`insert into transfer_links (id, space_id, debit_transaction_id, credit_transaction_id, debit_snapshot,
				credit_snapshot, created_at, updated_at, undone_at, seq${source === undefined ? '' : ', source'})
			values (?, ?, ?, ?, '{}', '{}', ?, ?, ?, 1${source === undefined ? '' : ', ?'})`
		)
		.bind(
			...[id, spaceId, `d-${id}`, `c-${id}`, T, T, undoneAt],
			...(source === undefined ? [] : [source])
		)
		.run();

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	const db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi48@contoh.id',
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	await link('l1', null);
	await link('l2', T);
	expect(
		(await rows(`pragma table_info(transfer_links)`)).some(
			(c) => (c as { name: string }).name === 'source'
		)
	).toBe(false);
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

describe('migration 0048', () => {
	it('every existing link is kept and reads as manual (the default; no other backfill)', async () => {
		expect(
			await rows(
				`select id, undone_at, source from transfer_links where space_id = ? order by id`,
				spaceId
			)
		).toEqual([
			{ id: 'l1', undone_at: null, source: 'manual' },
			{ id: 'l2', undone_at: T, source: 'manual' }
		]);
	});

	it('accepts manual and auto; refuses anything else and null', async () => {
		await link('l3', null, 'auto');
		await link('l4', null, 'manual');
		await expect(link('l5', null, 'otomatis')).rejects.toThrow(/CHECK/);
		await expect(link('l6', null, null as never)).rejects.toThrow(/NOT NULL/);
		expect(await rows(`pragma foreign_key_check`)).toEqual([]);
	});

	it('adds the partial amount index on live transactions', async () => {
		expect(
			await rows(
				`select name from sqlite_master where type = 'index' and name = 'transactions_space_amount_idx'
				and sql like '%WHERE deleted_at is null%'`
			)
		).toEqual([{ name: 'transactions_space_amount_idx' }]);
	});

	it('a re-run stops at the ALTER ("duplicate column") and changes nothing', async () => {
		const before = await rows(`select * from transfer_links order by id`);
		await expect(applyMigration(d1, MIGRATION)).rejects.toThrow(/duplicate column/);
		expect(await rows(`select * from transfer_links order by id`)).toEqual(before);
	});
});
