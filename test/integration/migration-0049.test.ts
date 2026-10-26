import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { EMONEY_ISSUERS } from '#lib/shared/wallets';
import { applyMigration, insertLegacyWallet, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0049 (FN-58 pass 1) adds `wallets.emoney_issuer` with `ALTER TABLE … ADD` and a column CHECK: applied to
 * a local D1 migrated up to 0048 holding an e-wallet, a bank wallet and an archived card, then checked (every wallet
 * kept byte for byte with a null issuer, the CHECK allowing the seven keys on an e_wallet only, no foreign key
 * broken), then applied again (the ALTER refuses a second run with "duplicate column" and nothing changes).
 */

const MIGRATION = '0049_emoney_cards.sql';
const T = Date.parse('2026-10-26T03:00:00Z');

let d1: D1Database;
let dispose: () => Promise<void>;
let ewalletId = '';
let bankId = '';
let walletsBefore: unknown[] = [];

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

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
	const db = getDb(d1);
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email: 'migrasi49@contoh.id',
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		T
	);
	if (!r.ok) throw new Error('setup failed');
	const spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const base = { currency: 'IDR', isFavourite: false, lastFour: null };
	ewalletId = (
		await insertLegacyWallet(
			d1,
			{ spaceId },
			{
				...base,
				name: 'Flazz',
				type: 'e_wallet',
				openingBalanceMinor: 5_000_000,
				lastFour: '0042'
			},
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
	const archived = await insertLegacyWallet(
		d1,
		{ spaceId },
		{ ...base, name: 'Kartu', type: 'kartu_kredit', openingBalanceMinor: -1000 },
		T
	);
	await run(`update wallets set deleted_at = ? where id = ?`, T, archived.id);
	walletsBefore = await rows(`select * from wallets order by id`);
	expect(
		(await rows(`pragma table_info(wallets)`)).some(
			(c) => (c as { name: string }).name === 'emoney_issuer'
		)
	).toBe(false);
	await applyMigration(d1, MIGRATION);
});
afterAll(() => dispose());

describe('migration 0049', () => {
	it('keeps every wallet as it was, with a null issuer (no backfill)', async () => {
		const after = (await rows(`select * from wallets order by id`)) as Record<string, unknown>[];
		expect(after.map(({ emoney_issuer, ...rest }) => (void emoney_issuer, rest))).toEqual(
			walletsBefore
		);
		expect(after.every((w) => w.emoney_issuer === null)).toBe(true);
		expect(await rows(`pragma foreign_key_check`)).toEqual([]);
	});

	it('the CHECK allows the seven issuer keys on an e_wallet only, and no other value', async () => {
		for (const issuer of EMONEY_ISSUERS) {
			await run(`update wallets set emoney_issuer = ? where id = ?`, issuer, ewalletId);
			expect(await rows(`select emoney_issuer from wallets where id = ?`, ewalletId)).toEqual([
				{ emoney_issuer: issuer }
			]);
		}
		for (const bad of ['gopay', 'BCA_FLAZZ', '', 'e_money'])
			await expect(
				run(`update wallets set emoney_issuer = ? where id = ?`, bad, ewalletId)
			).rejects.toThrow(/CHECK/);
		await expect(
			run(`update wallets set emoney_issuer = 'kmt' where id = ?`, bankId)
		).rejects.toThrow(/CHECK/);
		// An e-wallet with an issuer cannot change type without clearing it.
		await expect(run(`update wallets set type = 'bank' where id = ?`, ewalletId)).rejects.toThrow(
			/CHECK/
		);
		await run(`update wallets set emoney_issuer = null, type = 'bank' where id = ?`, ewalletId);
		await run(`update wallets set type = 'e_wallet' where id = ?`, ewalletId);
	});

	it('a re-run stops at the ALTER ("duplicate column") and changes nothing', async () => {
		const before = await rows(`select * from wallets order by id`);
		await expect(applyMigration(d1, MIGRATION)).rejects.toThrow(/duplicate column/);
		expect(await rows(`select * from wallets order by id`)).toEqual(before);
	});
});
