import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0038 (FN-34b): applied to a local D1 migrated up to 0036 that already holds notification preferences
 * and user notifications, both rebuilt tables keep every row unchanged (`hour` null), their indexes come back,
 * `close_reminder` becomes a valid kind (it was refused before) and `budget_streak_days` exists with its format
 * triggers.
 */

const MIGRATION = '0038_streak_plus.sql';

let d1: D1Database;
let dispose: () => Promise<void>;

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

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
});
afterAll(() => dispose());

describe('migration 0038', () => {
	it('keeps seeded preferences and notifications, then accepts close_reminder and the hour', async () => {
		const userId = crypto.randomUUID();
		await run(
			`insert into users (id, email, name, status, adult_confirmed_at, created_at) values (?, ?, 'Lama', 'active', 1, 1)`,
			userId,
			`lama-${userId}@contoh.id`
		);
		await run(
			`insert into notification_prefs (id, user_id, kind, enabled, created_at, updated_at) values
				('p1', ?, 'daily_nudge', 0, 10, 11), ('p2', ?, 'budget_80', 1, 12, 13)`,
			userId,
			userId
		);
		await run(
			`insert into user_notifications (id, user_id, kind, data_key, params, read_at, created_at, updated_at, deleted_at)
				values ('n1', ?, 'daily_nudge', 'nudge:2026-10-08', '{"date":"2026-10-08"}', 20, 21, 22, null),
					('n2', ?, 'weekly_summary', 'weekly:2026-10-05', null, null, 23, 24, 25)`,
			userId,
			userId
		);
		// Before: the kind is refused by both CHECKs.
		await expect(
			run(
				`insert into notification_prefs (id, user_id, kind, enabled, created_at, updated_at) values ('p3', ?, 'close_reminder', 1, 1, 1)`,
				userId
			)
		).rejects.toThrow(/CHECK/);
		const before = {
			prefs: await rows('select * from notification_prefs order by id'),
			notes: await rows('select * from user_notifications order by id')
		};

		await applyMigration(d1, MIGRATION);

		expect(
			await rows(
				'select id, user_id, kind, enabled, created_at, updated_at from notification_prefs order by id'
			)
		).toEqual(before.prefs);
		expect(await rows('select hour from notification_prefs')).toEqual([
			{ hour: null },
			{ hour: null }
		]);
		expect(await rows('select * from user_notifications order by id')).toEqual(before.notes);
		const indexes = (
			await rows<{ name: string }>(
				`select name from sqlite_master where type = 'index' and tbl_name in
					('notification_prefs', 'user_notifications', 'budget_streak_days') and name not like 'sqlite_%' order by name`
			)
		).map((r) => r.name);
		expect(indexes).toEqual([
			'budget_streak_days_space_date_uq',
			'notification_prefs_user_kind_uq',
			'user_notifications_created_idx',
			'user_notifications_key_uq',
			'user_notifications_user_idx'
		]);

		// After: the new kind and hour are accepted; an hour on another kind or out of range is refused.
		await run(
			`insert into notification_prefs (id, user_id, kind, enabled, hour, created_at, updated_at) values ('p3', ?, 'close_reminder', 1, 21, 1, 1)`,
			userId
		);
		await run(
			`insert into user_notifications (id, user_id, kind, data_key, params, created_at, updated_at) values ('n3', ?, 'close_reminder', 'close:2026-10-08', '{"date":"2026-10-08"}', 1, 1)`,
			userId
		);
		await expect(run(`update notification_prefs set hour = 21 where id = 'p1'`)).rejects.toThrow(
			/CHECK/
		);
		await expect(run(`update notification_prefs set hour = 5 where id = 'p3'`)).rejects.toThrow(
			/CHECK/
		);
		// The unique keys still hold.
		await expect(
			run(
				`insert into user_notifications (id, user_id, kind, data_key, params, created_at, updated_at) values ('n4', ?, 'close_reminder', 'close:2026-10-08', '{}', 1, 1)`,
				userId
			)
		).rejects.toThrow(/UNIQUE/);
		await expect(
			run(
				`insert into budget_streak_days (id, space_id, date, status, created_at) values ('b1', 'nope', '2026-10-08', 'within', 1)`
			)
		).rejects.toThrow(/FOREIGN KEY/);
	});
});
