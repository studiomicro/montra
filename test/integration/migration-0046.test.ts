import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0046 (FN-53) adds `net_worth_snapshots.classes` with `ALTER TABLE … ADD` and a column CHECK: applied
 * to a local D1 migrated up to 0045 holding live and tombstoned snapshots, then checked (every row kept, the new
 * column null, the CHECK refusing malformed JSON, a non-object and classes on a tombstone), then applied again
 * (the ALTER refuses a second run harmlessly with "duplicate column" and nothing changes).
 */

const MIGRATION = '0046_net_worth_snapshot_classes.sql';
const T = Date.parse('2026-10-13T03:00:00Z');

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
const insert = (
	date: string,
	total: number | null,
	deletedAt: number | null,
	classes?: string | null
) =>
	d1
		.prepare(
			classes === undefined
				? `insert into net_worth_snapshots (space_id, date, total_minor, currency, partial, created_at,
					updated_at, deleted_at, seq) values (?, ?, ?, 'IDR', 0, ?, ?, ?, 1)`
				: `insert into net_worth_snapshots (space_id, date, total_minor, currency, partial, created_at,
					updated_at, deleted_at, seq, classes) values (?, ?, ?, 'IDR', 0, ?, ?, ?, 1, ?)`
		)
		.bind(
			...(classes === undefined
				? [spaceId, date, total, T, T, deletedAt]
				: [spaceId, date, total, T, T, deletedAt, classes])
		)
		.run();

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	const db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi46@contoh.id',
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	await insert('2026-10-01', 1_000, null);
	await insert('2026-10-02', null, T);
	expect(
		(await rows(`pragma table_info(net_worth_snapshots)`)).some(
			(c) => (c as { name: string }).name === 'classes'
		)
	).toBe(false);
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

describe('migration 0046', () => {
	it('adds a nullable classes column; old rows keep everything and read null (no backfill)', async () => {
		expect(
			await rows(
				`select date, total_minor, deleted_at, classes from net_worth_snapshots where space_id = ? order by date`,
				spaceId
			)
		).toEqual([
			{ date: '2026-10-01', total_minor: 1_000, deleted_at: null, classes: null },
			{ date: '2026-10-02', total_minor: null, deleted_at: T, classes: null }
		]);
	});

	it('accepts a JSON object; refuses invalid JSON, a non-object, and classes on a tombstone', async () => {
		await insert('2026-10-03', 2_000, null, '{"wallets":1500,"debt":-500}');
		await expect(insert('2026-10-04', 1, null, '{"wallets":')).rejects.toThrow(/CHECK/);
		await expect(insert('2026-10-05', 1, null, '[1,2]')).rejects.toThrow(/CHECK/);
		await expect(insert('2026-10-06', 1, null, '7')).rejects.toThrow(/CHECK/);
		await expect(insert('2026-10-07', null, T, '{}')).rejects.toThrow(/CHECK/);
		// A tombstone that clears classes is fine.
		await d1
			.prepare(
				`update net_worth_snapshots set total_minor = null, deleted_at = ?, classes = null
				where space_id = ? and date = '2026-10-03'`
			)
			.bind(T, spaceId)
			.run();
		expect(await rows(`pragma foreign_key_check`)).toEqual([]);
	});

	it('a re-run stops at the ALTER ("duplicate column") and changes nothing', async () => {
		const before = await rows(`select * from net_worth_snapshots order by space_id, date`);
		await expect(applyMigration(d1, MIGRATION)).rejects.toThrow(/duplicate column/);
		expect(await rows(`select * from net_worth_snapshots order by space_id, date`)).toEqual(before);
	});
});
