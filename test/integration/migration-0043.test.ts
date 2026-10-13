import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0043 (FN-48 Part C) creates `transfer_links`: applied to a local D1 migrated up to 0042 and filled,
 * then checked (table, indexes, the one-live-link-per-row rule, the space cascade), then applied again (every
 * statement is IF NOT EXISTS: nothing changes, nothing is lost).
 */

const MIGRATION = '0043_transfer_links.sql';
const T = Date.parse('2026-10-12T03:00:00Z');

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
const insertLink = (id: string, debit: string, credit: string, undoneAt: number | null) =>
	d1
		.prepare(
			`insert into transfer_links (id, space_id, debit_transaction_id, credit_transaction_id, debit_snapshot,
				credit_snapshot, created_at, updated_at, undone_at, seq) values (?, ?, ?, ?, '{}', '{}', ?, ?, ?, 1)`
		)
		.bind(id, spaceId, debit, credit, T, T, undoneAt)
		.run();

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	const db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi43@contoh.id',
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	expect(await rows(`select name from sqlite_master where name = 'transfer_links'`)).toEqual([]);
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

describe('migration 0043', () => {
	it('creates transfer_links with its indexes; one live link per debit or credit row, an undone one frees it', async () => {
		expect(
			(
				await rows(`select name from sqlite_master where type = 'index' and tbl_name = 'transfer_links'
					and name like 'transfer_links_%' order by name`)
			).map((r) => (r as { name: string }).name)
		).toEqual([
			'transfer_links_credit_live_uq',
			'transfer_links_debit_live_uq',
			'transfer_links_space_idx'
		]);
		await insertLink('l-1', 'd-1', 'c-1', null);
		await expect(insertLink('l-2', 'd-1', 'c-2', null)).rejects.toThrow(/UNIQUE/);
		await expect(insertLink('l-3', 'd-2', 'c-1', null)).rejects.toThrow(/UNIQUE/);
		// An undone link does not block a new one for the same rows.
		await insertLink('l-4', 'd-1', 'c-1', T + 1);
		await insertLink('l-5', 'd-9', 'c-9', T + 1);
		await insertLink('l-6', 'd-9', 'c-9', null);
		await expect(insertLink('l-7', 'x', 'y', null).then(() => {})).resolves.toBeUndefined();
		expect(await rows(`pragma foreign_key_check`)).toEqual([]);
		await expect(
			d1
				.prepare(
					`insert into transfer_links (id, space_id, debit_transaction_id, credit_transaction_id, debit_snapshot,
						credit_snapshot, created_at, updated_at, undone_at, seq) values ('l-8', 'no-space', 'a', 'b', '{}', '{}', ?, ?, null, 1)`
				)
				.bind(T, T)
				.run()
		).rejects.toThrow(/FOREIGN KEY/);
	});

	it('re-runs without losing or changing a row', async () => {
		const before = await rows(`select * from transfer_links order by id`);
		expect(before.length).toBeGreaterThan(0);
		await applyMigration(d1, MIGRATION);
		expect(await rows(`select * from transfer_links order by id`)).toEqual(before);
	});
});
