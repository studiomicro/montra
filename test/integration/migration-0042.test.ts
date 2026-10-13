import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0042 (FN-16j) rebuilds `audit_events` to widen its action CHECK with 'import_batch_moved': applied to a
 * local D1 migrated up to 0041 that already holds audit rows, then checked row by row, then applied again (a
 * re-run drops the leftover copy and rebuilds the same table; nothing changes).
 */

const MIGRATION = '0042_import_batch_moved.sql';
const T = Date.parse('2026-10-11T03:00:00Z');

let d1: D1Database;
let dispose: () => Promise<void>;
let spaceId = '';
let userId = '';

const rows = async (sql: string) => (await d1.prepare(sql).all()).results;
const auditRows = () =>
	rows(
		`select id, space_id, actor_user_id, action, target_user_id, created_at from audit_events order by id`
	);
const insert = (id: string, action: string) =>
	d1
		.prepare(
			`insert into audit_events (id, space_id, actor_user_id, action, target_user_id, created_at)
			values (?, ?, ?, ?, null, ?)`
		)
		.bind(id, spaceId, userId, action, T)
		.run();
let before: unknown[];

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	const db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi42@contoh.id',
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	userId = r.userId;
	spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	await insert('a-1', 'space_created');
	await insert('a-2', 'app_auto_disconnected');
	// Refused before 0042.
	await expect(insert('a-3', 'import_batch_moved')).rejects.toThrow(/CHECK/);
	before = await auditRows();
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

describe('migration 0042', () => {
	it('keeps every audit row, then accepts import_batch_moved and still refuses unknown actions', async () => {
		expect(await auditRows()).toEqual(before);
		await insert('a-3', 'import_batch_moved');
		await expect(insert('a-4', 'bukan_aksi')).rejects.toThrow(/CHECK/);
		expect(
			await rows(`select name from sqlite_master where type = 'index' and tbl_name = 'audit_events'
				and name = 'audit_events_space_idx'`)
		).toHaveLength(1);
		expect(await rows(`pragma foreign_key_check`)).toEqual([]);
	});

	it('re-runs without losing or changing a row', async () => {
		const now = await auditRows();
		await applyMigration(d1, MIGRATION);
		expect(await auditRows()).toEqual(now);
	});
});
