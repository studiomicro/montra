import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { applyMigration, insertLegacyWallet, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0047 (FN-55a/b): `card_statements` is created (IF NOT EXISTS) and `wallets` gains three card columns by
 * ALTER with column CHECKs. Applied to a local D1 migrated up to the one before it and filled with wallets first;
 * every existing wallet keeps every column byte for byte. Run again, the table and index steps are no-ops and the
 * first ALTER refuses harmlessly ("duplicate column"), as 0037/0040/0041 do.
 */

const MIGRATION = '0047_credit_cards.sql';
const T = Date.parse('2026-10-13T03:00:00Z');

let d1: D1Database;
let dispose: () => Promise<void>;
let spaceId = '';
let cardId = '';
let bankId = '';

const rows = async (sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all()
	).results;
const run = (sql: string, ...params: unknown[]) =>
	d1
		.prepare(sql)
		.bind(...params)
		.run();

let walletsBefore: unknown[] = [];

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	const db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi47@contoh.id',
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const base = { currency: 'IDR', isFavourite: false, lastFour: null };
	cardId = (
		await insertLegacyWallet(
			d1,
			{ spaceId },
			{ ...base, name: 'Kartu', type: 'kartu_kredit', openingBalanceMinor: -125000050 },
			T
		)
	).id;
	bankId = (
		await insertLegacyWallet(
			d1,
			{ spaceId },
			{ ...base, name: 'Bank', type: 'bank', openingBalanceMinor: 5000 },
			T
		)
	).id;
	walletsBefore = await rows(`select * from wallets order by id`);
	expect(await rows(`select name from sqlite_master where name = 'card_statements'`)).toEqual([]);
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

const insertStatement = (id: string, over: Record<string, unknown> = {}) => {
	const v = {
		wallet_id: cardId,
		import_batch_id: 'b-1',
		statement_date: '2026-10-25',
		due_date: '2026-11-12',
		previous_balance_minor: -200000000,
		new_balance_minor: -132500050,
		currency: 'IDR',
		deleted_at: null,
		...over
	};
	return run(
		`insert into card_statements (id, space_id, wallet_id, import_batch_id, statement_date, due_date,
			previous_balance_minor, new_balance_minor, currency, created_at, updated_at, deleted_at, seq)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		id,
		spaceId,
		v.wallet_id,
		v.import_batch_id,
		v.statement_date,
		v.due_date,
		v.previous_balance_minor,
		v.new_balance_minor,
		v.currency,
		T,
		T,
		v.deleted_at
	);
};

describe('migration 0047', () => {
	it('keeps every wallet as it was, with the three card columns null', async () => {
		const after = (await rows(`select * from wallets order by id`)) as Record<string, unknown>[];
		const card = new Set(['credit_limit_minor', 'statement_day', 'due_day']);
		expect(
			after.map((w) => Object.fromEntries(Object.entries(w).filter(([k]) => !card.has(k))))
		).toEqual(walletsBefore);
		expect(
			after.every(
				(w) => w.credit_limit_minor === null && w.statement_day === null && w.due_day === null
			)
		).toBe(true);
	});

	it('card columns: only on a card, a positive limit up to 10^13, days 1-31', async () => {
		await run(
			`update wallets set credit_limit_minor = 1500000000, statement_day = 25, due_day = 12 where id = ?`,
			cardId
		);
		await expect(run(`update wallets set due_day = 12 where id = ?`, bankId)).rejects.toThrow(
			/CHECK/
		);
		await expect(
			run(`update wallets set credit_limit_minor = 1 where id = ?`, bankId)
		).rejects.toThrow(/CHECK/);
		for (const bad of [0, 32])
			await expect(
				run(`update wallets set statement_day = ? where id = ?`, bad, cardId)
			).rejects.toThrow(/CHECK/);
		for (const bad of [0, -1, 10000000000001])
			await expect(
				run(`update wallets set credit_limit_minor = ? where id = ?`, bad, cardId)
			).rejects.toThrow(/CHECK/);
		// A card with fields set cannot become another type without clearing them.
		await expect(run(`update wallets set type = 'bank' where id = ?`, cardId)).rejects.toThrow(
			/CHECK/
		);
	});

	it('card_statements: real dates, safe balances, one live row per card and date, content-free tombstone', async () => {
		for (const id of ['b-1', 'b-2'])
			await run(
				`insert into import_batches (id, space_id, source, row_count, imported_count, skipped_count,
					created_at, updated_at, seq) values (?, ?, 'statement', 1, 1, 0, ?, ?, 1)`,
				id,
				spaceId,
				T,
				T
			);
		await expect(insertStatement('s-0', { import_batch_id: 'no-batch' })).rejects.toThrow(
			/FOREIGN KEY/
		);
		await insertStatement('s-1');
		await expect(insertStatement('s-2')).rejects.toThrow(/UNIQUE/);
		await expect(insertStatement('s-3', { statement_date: '2026-02-30' })).rejects.toThrow(/CHECK/);
		await expect(
			insertStatement('s-4', { statement_date: '2026-10-26', due_date: '12/11/2026' })
		).rejects.toThrow(/CHECK/);
		await expect(
			insertStatement('s-5', { statement_date: '2026-10-27', new_balance_minor: null })
		).rejects.toThrow(/CHECK/);
		// A tombstone keeps no figures.
		await expect(
			insertStatement('s-6', { statement_date: '2026-10-28', deleted_at: T })
		).rejects.toThrow(/CHECK/);
		await run(
			`update card_statements set deleted_at = ?, statement_date = null, due_date = null,
				previous_balance_minor = null, new_balance_minor = null, currency = null where id = 's-1'`,
			T
		);
		// The tombstone frees its statement date.
		await insertStatement('s-7');
		await expect(
			insertStatement('s-8', { import_batch_id: 'b-2', statement_date: '2026-11-25' })
		).resolves.toBeDefined();
		expect(
			(
				await rows(`select name from sqlite_master where type = 'index' and tbl_name = 'card_statements'
					and name like 'card_statements_%' order by name`)
			).map((r) => (r as { name: string }).name)
		).toEqual(['card_statements_live_uq', 'card_statements_wallet_idx']);
	});

	it('re-runs: the table and index steps change nothing, the first ALTER stops it harmlessly', async () => {
		const statements = await rows(`select * from card_statements order by id`);
		const wallets = await rows(`select * from wallets order by id`);
		await expect(applyMigration(d1, MIGRATION)).rejects.toThrow(/duplicate column/);
		expect(await rows(`select * from card_statements order by id`)).toEqual(statements);
		expect(await rows(`select * from wallets order by id`)).toEqual(wallets);
	});
});
