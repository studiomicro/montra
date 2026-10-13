import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createWallet } from '#lib/server/wallets/repo';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0041 (FN-49) on a local D1 migrated up to the one before it and filled first: `transactions` gains its two
 * columns by ALTER (not rebuilt: every existing row, live or tombstone, keeps every column byte for byte, and
 * the table keeps its original CHECKs), `feature_flags` is rebuilt with every row and accepts 'patungan', and the
 * new CHECKs, unique index and same-space triggers hold. Re-running the file repeats its rebuild cleanly and stops
 * harmlessly at the first ALTER ("duplicate column"), as 0037 does.
 */

const MIGRATION = '0041_patungan.sql';
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

let spaceId = '';
let userId = '';
let otherSpaceId = '';
let before: { transactions: unknown[]; flags: unknown[]; transactionsSql: string };

const snapshot = async () => ({
	transactions: await rows(`select * from transactions order by id`),
	flags: await rows(`select * from feature_flags order by id`),
	transactionsSql: (
		await rows<{ sql: string }>(`select sql from sqlite_master where name = 'transactions'`)
	)[0]!.sql
});

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	db = getDb(d1);
	const people = [];
	for (const n of [1, 2]) {
		const r = await signUp(
			db,
			{
				name: 'Uji',
				email: `migrasi40-${n}@contoh.id`,
				password: 'kopi-pagi-2026',
				adultConfirmed: true,
				consentAccepted: true
			},
			T
		);
		if (!r.ok) throw new Error('setup failed');
		people.push({
			userId: r.userId,
			spaceId: (await resolveCurrentSpace(db, r.userId, undefined))!.id
		});
	}
	({ spaceId, userId } = people[0]!);
	otherSpaceId = people[1]!.spaceId;
	const w = await createWallet(
		db,
		{ spaceId, userId },
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
	for (const [i, type] of (['expense', 'income', 'expense'] as const).entries())
		await run(
			`insert into transactions (id, space_id, type, amount_minor, currency, wallet_id, title, note,
				occurred_on, occurred_at, source, dedupe_key, is_demo, created_at, updated_at, seq, payment_method,
				tag, category_source)
			values (?, ?, ?, ?, 'IDR', ?, 'Makan', 'catatan', '2026-10-08', ?, 'statement', ?, ?, ?, ?, ?, 'QRIS',
				'kantor', 'auto')`,
			`t-${i}`,
			spaceId,
			type,
			40_000_000 + i,
			w.id,
			T + i,
			`statement:f:${i}`,
			i === 2 ? 1 : 0,
			T,
			T + i,
			i + 1
		);
	await run(
		`insert into transactions (id, space_id, type, source, dedupe_key, created_at, updated_at, deleted_at, seq)
		values ('t-dead', ?, 'expense', 'gmail', 'gmail:m1', ?, ?, ?, 9)`,
		spaceId,
		T,
		T + 5,
		T + 5
	);
	await run(
		`insert into feature_flags values ('f-1', ?, 'koleksi', 0, ?, ?), ('f-2', ?, 'ruang', 1, ?, ?)`,
		userId,
		T,
		T,
		userId,
		T,
		T + 1
	);
	before = await snapshot();
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

const link = (id: string, split: string | null, effective: number | null) =>
	run(
		`update transactions set patungan_split_id = ?, patungan_effective_amount_minor = ? where id = ?`,
		split,
		effective,
		id
	);

describe('migration 0041', () => {
	it('adds the two columns without rebuilding transactions; every row is kept as it was', async () => {
		const after = await snapshot();
		expect(after.transactions).toEqual(
			(before.transactions as Record<string, unknown>[]).map((r) => ({
				...r,
				patungan_split_id: null,
				patungan_effective_amount_minor: null
			}))
		);
		// The original table definition is still there, only extended (an ALTER, not a copy): every original
		// constraint unchanged, the two columns added.
		expect(after.transactionsSql).toContain(
			before.transactionsSql.slice(before.transactionsSql.indexOf('FOREIGN KEY'))
		);
		expect(after.transactionsSql).toContain(
			'`patungan_split_id` text REFERENCES `patungan_splits`(`id`)'
		);
		expect(after.transactionsSql).toContain('transactions_patungan_check');
		expect(after.flags).toEqual(before.flags);
	});

	it('accepts the patungan module flag, and nothing unknown', async () => {
		await run(`insert into feature_flags values ('f-3', ?, 'patungan', 0, ?, ?)`, userId, T, T);
		await expect(
			run(`insert into feature_flags values ('f-4', ?, 'lain', 0, ?, ?)`, userId, T, T)
		).rejects.toThrow(/CHECK/);
	});

	it('enforces the link rules in the database', async () => {
		await run(
			`insert into patungan_splits (id, space_id, created_by_user_id, payer_name, title, total_amount_minor,
				currency, occurred_on, mode, created_at, updated_at, seq)
			values ('s-1', ?, ?, 'Uji', 'Makan', 40000000, 'IDR', '2026-10-08', 'equal', ?, ?, 1),
				('s-2', ?, ?, 'Uji', 'Makan', 40000001, 'IDR', '2026-10-08', 'equal', ?, ?, 1),
				('s-other', ?, null, 'Lain', 'Makan', 40000000, 'IDR', '2026-10-08', 'equal', ?, ?, 1)`,
			spaceId,
			userId,
			T,
			T,
			spaceId,
			userId,
			T,
			T,
			otherSpaceId,
			T,
			T
		);
		await link('t-0', 's-1', 10_000_000);
		// Both or neither; the effective amount 1 … amount; only an expense.
		await expect(link('t-0', 's-1', null)).rejects.toThrow(/CHECK/);
		await expect(link('t-0', 's-1', 40_000_001)).rejects.toThrow(/CHECK/);
		await expect(link('t-0', 's-1', 0)).rejects.toThrow(/CHECK/);
		await expect(link('t-1', 's-2', 1)).rejects.toThrow(/CHECK/);
		// One live transaction per split; never another space's split.
		await expect(link('t-2', 's-1', 1)).rejects.toThrow(/UNIQUE/);
		await expect(link('t-2', 's-other', 1)).rejects.toThrow(/another space/);
		await expect(link('t-2', 'nope', 1)).rejects.toThrow();
		// A tombstone holds no link: deleting without clearing it is refused, clearing it works.
		await expect(
			run(
				`update transactions set deleted_at = ?, amount_minor = null, currency = null, wallet_id = null,
				occurred_on = null, occurred_at = null, title = null, note = null where id = 't-0'`,
				T
			)
		).rejects.toThrow(/CHECK/);
		expect(
			(
				await rows<{ effective: number }>(
					`select patungan_effective_amount_minor as effective from transactions where id = 't-0'`
				)
			)[0]?.effective
		).toBe(10_000_000);
	});

	it('a second run repeats the rebuild and stops at the first ALTER, losing nothing', async () => {
		const mid = await snapshot();
		const statements = readFileSync(`migrations/${MIGRATION}`, 'utf8')
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter(Boolean);
		const firstAlter = statements.findIndex((s) => s.startsWith('ALTER TABLE `transactions`'));
		for (const s of statements.slice(0, firstAlter)) await d1.prepare(s).run();
		await expect(d1.prepare(statements[firstAlter]!).run()).rejects.toThrow(/duplicate column/);
		expect(await snapshot()).toEqual(mid);
	});
});
