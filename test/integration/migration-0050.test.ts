import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { applyMigration, insertLegacyWallet, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0050 (FN-19b, AC 25): applied to a local D1 migrated up to 0049 that already holds notification
 * preferences, space notifications, a Gmail connection and a scan. Both rebuilt tables keep every row unchanged
 * (same ids and `seq`), their indexes come back, `gmail_payment` becomes a valid kind (refused before) while an
 * unknown kind is still refused, `gmail_connections` rows read `auto_save = 0`, ledger rows read `reread_at` null, the wallet reference nulls itself
 * when the wallet row goes, `gmail_scans.undone_at` is null, and a re-run stops harmlessly at the ALTERs.
 */

const MIGRATION = '0050_gmail_followups.sql';
const T = Date.parse('2026-10-28T03:00:00Z');

let d1: D1Database;
let dispose: () => Promise<void>;
let userId = '';
let spaceId = '';
let walletId = '';

const rows = async <R = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all<R>()
	).results;
const run = (sql: string, ...params: unknown[]) =>
	d1
		.prepare(sql)
		.bind(...params)
		.run();

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	const db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi50@contoh.id',
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	userId = r.userId;
	spaceId = (await resolveCurrentSpace(db, userId, undefined))!.id;
	walletId = (
		await insertLegacyWallet(
			d1,
			{ spaceId },
			{
				name: 'BCA',
				type: 'bank',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: true,
				lastFour: null
			},
			T
		)
	).id;
});
afterAll(() => dispose());

describe('migration 0050', () => {
	it('keeps every notification row and index, then accepts gmail_payment and still refuses an unknown kind', async () => {
		await run(
			`insert into notification_prefs (id, user_id, kind, enabled, hour, created_at, updated_at) values
				('p1', ?, 'close_reminder', 1, 21, 10, 11), ('p2', ?, 'budget_80', 0, null, 12, 13)`,
			userId,
			userId
		);
		await run(
			`insert into space_notifications (id, space_id, user_id, kind, data_key, params, read_at, created_at, updated_at, deleted_at, seq)
				values ('n1', ?, ?, 'bill_reminder', 'bill:s:2026-10-28', '{"count":2,"date":"2026-10-28"}', 20, 21, 22, null, 7),
					('n2', ?, ?, 'goal_milestone', 'goal:g:50', null, null, 23, 24, 25, 9)`,
			spaceId,
			userId,
			spaceId,
			userId
		);
		await run(
			`insert into gmail_connections (id, user_id, space_id, status, google_address, encrypted_token, token_nonce, token_key_id, scope, auto_check, checked_through, created_at, updated_at)
				values ('c1', ?, ?, 'connected', 'pemilik@gmail.example', 'sealed', '0123456789abcdef', '01234567890', 'scope', 1, 1, 30, 31)`,
			userId,
			spaceId
		);
		await run(
			`insert into gmail_scans (id, connection_id, user_id, kind, scan_window, days, after_s, status, created_at, updated_at)
				values ('s1', 'c1', ?, 'hourly', '2026-10-28T10', null, 1, 'done', 40, 41)`,
			userId
		);
		await run(
			`insert into gmail_mail (id, connection_id, user_id, space_id, gmail_id, received_at, status, scan_id, updated_at)
				values ('g1', 'c1', ?, ?, 'abc1', 50, 'listed', 's1', 51)`,
			userId,
			spaceId
		);
		// Before: the new kind is refused by both CHECKs.
		await expect(
			run(
				`insert into notification_prefs (id, user_id, kind, enabled, created_at, updated_at) values ('p3', ?, 'gmail_payment', 1, 1, 1)`,
				userId
			)
		).rejects.toThrow(/CHECK/);
		const before = {
			prefs: await rows('select * from notification_prefs order by id'),
			notes: await rows('select * from space_notifications order by id'),
			conns: await rows('select * from gmail_connections order by id'),
			scans: await rows('select * from gmail_scans order by id')
		};

		await applyMigration(d1, MIGRATION);

		expect(await rows('select * from notification_prefs order by id')).toEqual(before.prefs);
		expect(await rows('select * from space_notifications order by id')).toEqual(before.notes);
		expect(
			(await rows('select * from gmail_connections order by id')).map((c) => ({
				...c,
				auto_save: undefined,
				auto_save_wallet_id: undefined,
				auto_save_day: undefined,
				auto_saves: undefined
			}))
		).toEqual(
			before.conns.map((c) => ({
				...c,
				auto_save: undefined,
				auto_save_wallet_id: undefined,
				auto_save_day: undefined,
				auto_saves: undefined
			}))
		);
		expect(
			await rows(
				'select auto_save, auto_save_wallet_id, auto_save_day, auto_saves from gmail_connections'
			)
		).toEqual([{ auto_save: 0, auto_save_wallet_id: null, auto_save_day: null, auto_saves: 0 }]);
		expect(await rows('select undone_at from gmail_scans')).toEqual([{ undone_at: null }]);
		expect(await rows('select id, status, scan_id, reread_at from gmail_mail')).toEqual([
			{ id: 'g1', status: 'listed', scan_id: 's1', reread_at: null }
		]);
		const indexes = (
			await rows<{ name: string }>(
				`select name from sqlite_master where type = 'index' and tbl_name in
					('notification_prefs', 'space_notifications') and name not like 'sqlite_%' order by name`
			)
		).map((r) => r.name);
		expect(indexes).toEqual([
			'notification_prefs_user_kind_uq',
			'space_notifications_created_idx',
			'space_notifications_key_uq',
			'space_notifications_space_idx',
			'space_notifications_user_idx'
		]);
		// Foreign keys intact: none broken, and the rebuilt tables still cascade from users/spaces.
		expect(await rows('pragma foreign_key_check')).toEqual([]);

		// After: the new kind is accepted on both tables; the old kinds still pass; an unknown one is refused.
		await run(
			`insert into notification_prefs (id, user_id, kind, enabled, created_at, updated_at) values ('p3', ?, 'gmail_payment', 0, 1, 1)`,
			userId
		);
		await run(
			`insert into space_notifications (id, space_id, user_id, kind, data_key, params, created_at, updated_at, seq)
				values ('n3', ?, ?, 'gmail_payment', 'gmail:d1', '{}', 1, 1, 10),
					('n4', ?, ?, 'budget_100', 'budget:s:2026-10:100', '{}', 1, 1, 11)`,
			spaceId,
			userId,
			spaceId,
			userId
		);
		await expect(
			run(
				`insert into space_notifications (id, space_id, user_id, kind, data_key, params, created_at, updated_at, seq)
					values ('n5', ?, ?, 'mystery', 'x', '{}', 1, 1, 12)`,
				spaceId,
				userId
			)
		).rejects.toThrow(/CHECK/);
		await expect(
			run(
				`insert into notification_prefs (id, user_id, kind, enabled, created_at, updated_at) values ('p4', ?, 'mystery', 1, 1, 1)`,
				userId
			)
		).rejects.toThrow(/CHECK/);
		// The unique keys still hold.
		await expect(
			run(
				`insert into space_notifications (id, space_id, user_id, kind, data_key, params, created_at, updated_at, seq)
					values ('n6', ?, ?, 'gmail_payment', 'gmail:d1', '{}', 1, 1, 13)`,
				spaceId,
				userId
			)
		).rejects.toThrow(/UNIQUE/);

		// The wallet reference: a live wallet is accepted, an unknown id refused, a removed wallet nulls it.
		await run(
			`update gmail_connections set auto_save = 1, auto_save_wallet_id = ? where id = 'c1'`,
			walletId
		);
		await expect(
			run(`update gmail_connections set auto_save_wallet_id = 'nope' where id = 'c1'`)
		).rejects.toThrow(/FOREIGN KEY/);
		await run(`delete from wallets where id = ?`, walletId);
		expect(await rows(`select auto_save_wallet_id from gmail_connections where id = 'c1'`)).toEqual(
			[{ auto_save_wallet_id: null }]
		);
	});

	it('a re-run stops at the ALTERs and changes nothing', async () => {
		const before = {
			prefs: await rows('select * from notification_prefs order by id'),
			notes: await rows('select * from space_notifications order by id')
		};
		await expect(applyMigration(d1, MIGRATION)).rejects.toThrow(/duplicate column/);
		expect(await rows('select * from notification_prefs order by id')).toEqual(before.prefs);
		expect(await rows('select * from space_notifications order by id')).toEqual(before.notes);
	});
});
