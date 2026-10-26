import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { importRows, type PreparedRows } from '#lib/server/imports/csv-import';
import type { RawCsvTransaction } from '#lib/shared/csv';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	importStatement,
	type ImportStatementInput
} from '#lib/server/statements/statement-import';
import { deleteTransaction } from '#lib/server/transactions/repo';
import {
	AUTO_MATCH_MAX,
	applyTransferMatch,
	autoMatchTransferPairs,
	countTransferMatches,
	listTransferLinks,
	proposeTransferMatches,
	undoTransferMatch
} from '#lib/server/transfers/match';
import { newId } from '#lib/server/util';
import { createWallet } from '#lib/server/wallets/repo';
import type { WalletType } from '#lib/shared/wallets';
import { statementRow } from '#lib/shared/statements/rows';
import type { MappedRow, StatementParser } from '#lib/shared/statements/types';
import { openLocalD1 } from '../helpers/d1';

/**
 * FN-48d on a local D1: right after a statement import commits, its unambiguous own-transfer pairs merge by
 * themselves through the same guarded merge as "Cocokkan" (link `source` `auto`); ambiguous groups, card payments,
 * pairs the import did not touch, rows an undone auto-merge named, stale rows and other spaces' rows never do. A
 * fictional test-only parser reads a tiny CSV whose fifth column names the row's category; every name and amount
 * is invented.
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.parse('2026-07-12T03:00:00Z');
/** Rp 5.000.000 in minor units. */
const FIVE_M = 500_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

const rows = async <R>(sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all<R>()
	).results;

const HEADER = ['uji_tanggal', 'uji_uraian', 'uji_debet', 'uji_kredit', 'uji_kategori'];

/** "Bank Uji Fiktif": CSV only; a debit goes to "Transfer keluar", a credit to "Transfer masuk" unless named. */
const TEST_BANK: StatementParser = {
	id: 'uji-transfer',
	label: 'Bank Uji Fiktif',
	formats: ['csv'],
	detect: (doc) =>
		doc.format === 'csv' && HEADER.every((c, i) => (doc.rows[0]?.[i] ?? '').trim() === c) ? 0.9 : 0,
	parse(doc) {
		const out: MappedRow[] = [];
		if (doc.format === 'csv')
			for (const [date = '', text = '', debit = '', credit = '', category = ''] of doc.rows.slice(
				1
			)) {
				const row = statementRow(out.length, {
					date,
					direction: debit ? 'debit' : 'credit',
					amount: debit || credit,
					description: text
				});
				out.push(
					row.ok
						? {
								...row,
								value: {
									...row.value,
									categoryName: category || (debit ? 'Transfer keluar' : 'Transfer masuk')
								}
							}
						: row
				);
			}
		return { rows: out, openingBalanceMinor: null, closingBalanceMinor: null };
	}
};
const PARSERS = [TEST_BANK];

/** One statement line: WIB date, description, signed amount (`-` debit). */
type Line = [date: string, title: string, amount: string];
let fileNo = 0;
/** A statement file; every file differs (a numbered dummy line is never written: its amount is unreadable). */
function statementFile(lines: Line[]): Uint8Array {
	const q = (s: string) => `"${s}"`;
	const out = [HEADER.join(','), `2026-01-01,BERKAS ${++fileNo},,"x",`];
	for (const [date, title, amount] of lines)
		out.push(
			amount.startsWith('-')
				? `${date},${title},${q(amount.slice(1))},,`
				: `${date},${title},,${q(amount)},`
		);
	return new TextEncoder().encode(out.join('\n'));
}

const input = (bytes: Uint8Array, walletId: string): ImportStatementInput => ({
	bytes,
	password: null,
	institution: null,
	filename: 'mutasi-uji.csv',
	defaultWalletId: walletId,
	skipPossibleDuplicates: false
});

async function importInto(scope: SpaceScope, walletId: string, bytes: Uint8Array, now = NOW) {
	const r = await importStatement(db, scope, input(bytes, walletId), now, PARSERS);
	if (!r.ok) throw new Error(`import failed: ${String(r.error)}`);
	return r;
}

let n = 0;
async function walletIn(scope: SpaceScope, name: string, type: WalletType = 'bank') {
	const w = await createWallet(
		db,
		scope,
		{ name, type, currency: 'IDR', openingBalanceMinor: 0, isFavourite: false, lastFour: null },
		NOW
	);
	if (!w.ok) throw new Error('wallet failed');
	return w.id;
}
async function account() {
	const email = `otomatis${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	await ensurePresetCategories(db, space.id, NOW);
	return {
		user: { id: r.userId, email, name: 'Uji', createdAt: 0 },
		scope,
		A: await walletIn(scope, 'BCA'),
		B: await walletIn(scope, 'OCBC'),
		C: await walletIn(scope, 'Jago')
	};
}
type Account = Awaited<ReturnType<typeof account>>;

/** The rows import `batchId` wrote (live or tombstone), oldest index first. */
const batchRows = (batchId: string | null) =>
	rows<{
		id: string;
		type: string;
		deleted_at: number | null;
		transfer_to_wallet_id: string | null;
		created_at: number;
	}>(
		`select id, type, deleted_at, transfer_to_wallet_id, created_at from transactions
		where import_batch_id = ? order by dedupe_key`,
		batchId
	);
const links = (spaceId: string) =>
	rows<{ debit_transaction_id: string; credit_transaction_id: string; source: string }>(
		`select debit_transaction_id, credit_transaction_id, source from transfer_links
		where space_id = ? order by created_at, id`,
		spaceId
	);
const pairIds = async (spaceId: string) =>
	(await proposeTransferMatches(db, spaceId)).groups.map((g) => ({
		ambiguous: g.ambiguous,
		pairs: g.pairs.map((p) => `${p.debit.id}:${p.credit.id}:${p.kind}`)
	}));

/** A transfer-tile row written straight into D1 (no import batch), as another capture path would leave it. */
async function seed(
	a: Pick<Account, 'scope'>,
	wallet: string,
	type: 'expense' | 'income',
	day: string,
	amount = FIVE_M
) {
	const all = await listCategories(db, a.scope.spaceId, { includeHidden: true });
	const category = all.find((c) => c.tileKey === 'transfer' && c.kind === type && c.isPreset)!.id;
	const id = newId();
	await d1
		.prepare(
			`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
				occurred_on, occurred_at, source, dedupe_key, is_demo, created_at, updated_at, seq, category_source)
			values (?, ?, ?, ?, 'IDR', ?, ?, 'TRANSFER UJI', ?, ?, 'manual', null, 0, ?, ?, 1, 'auto')`
		)
		.bind(
			id,
			a.scope.spaceId,
			type,
			amount,
			category,
			wallet,
			day,
			Date.parse(`${day}T05:00:00Z`),
			NOW - 1000,
			NOW - 1000
		)
		.run();
	return id;
}

/** The main vector: wallet A's statement with the debit, then wallet B's with the credit the next day. */
async function clearPair(a: Account) {
	const first = await importInto(
		a.scope,
		a.A,
		statementFile([['2026-07-10', 'TRF KE OCBC', '-5.000.000']])
	);
	const fileB = statementFile([['2026-07-11', 'TRF DARI BCA', '5.000.000']]);
	const second = await importInto(a.scope, a.B, fileB);
	const [debit] = await batchRows(first.batchId);
	const [credit] = await batchRows(second.batchId);
	return { first, second, fileB, debit: debit!, credit: credit! };
}

describe('autoMatchTransferPairs after a statement import (FN-48d)', () => {
	it('merges the one clear pair right after the import that completes it (AC-1, AC-4)', async () => {
		const a = await account();
		const { first, second, debit, credit } = await clearPair(a);
		expect(first.autoMatchedCount).toBe(0);
		expect(second.autoMatchedCount).toBe(1);
		expect(await batchRows(first.batchId)).toEqual([
			{ ...debit, type: 'transfer', transfer_to_wallet_id: a.B }
		]);
		expect((await batchRows(second.batchId))[0]!.deleted_at).not.toBeNull();
		expect(await links(a.scope.spaceId)).toEqual([
			{ debit_transaction_id: debit.id, credit_transaction_id: credit.id, source: 'auto' }
		]);
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(0);
		const listed = await listTransferLinks(db, a.scope.spaceId);
		expect(listed.links.map((l) => [l.source, l.fromWalletId, l.toWalletId])).toEqual([
			['auto', a.A, a.B]
		]);
	});

	it('an ambiguous group merges nothing; every candidate stays listed (AC-2)', async () => {
		const a = await account();
		await importInto(a.scope, a.B, statementFile([['2026-07-11', 'TRF MASUK 1', '5.000.000']]));
		await importInto(a.scope, a.C, statementFile([['2026-07-11', 'TRF MASUK 2', '5.000.000']]));
		const r = await importInto(
			a.scope,
			a.A,
			statementFile([['2026-07-10', 'TRF KELUAR', '-5.000.000']])
		);
		expect(r.autoMatchedCount).toBe(0);
		expect(await links(a.scope.spaceId)).toEqual([]);
		const groups = await pairIds(a.scope.spaceId);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.ambiguous).toBe(true);
		expect(groups[0]!.pairs).toHaveLength(2);
	});

	it('a pair the import did not touch stays pending, even with the same amount (owner decision 2)', async () => {
		const a = await account();
		const d = await seed(a, a.A, 'expense', '2026-06-01');
		const c = await seed(a, a.B, 'income', '2026-06-01');
		const r = await importInto(
			a.scope,
			a.C,
			statementFile([['2026-07-20', 'TRF LAIN', '-5.000.000']])
		);
		expect(r.autoMatchedCount).toBe(0);
		expect(await pairIds(a.scope.spaceId)).toEqual([
			{ ambiguous: false, pairs: [`${d}:${c}:own`] }
		]);
	});

	it('a card payment pair is never merged by itself (AC-3)', async () => {
		const a = await account();
		const card = await walletIn(a.scope, 'Kartu Fiktif', 'kartu_kredit');
		const payment = await seed(a, card, 'income', '2026-07-11');
		const r = await importInto(
			a.scope,
			a.A,
			statementFile([['2026-07-10', 'BAYAR KARTU', '-5.000.000']])
		);
		expect(r.autoMatchedCount).toBe(0);
		expect(await links(a.scope.spaceId)).toEqual([]);
		const [debit] = await batchRows(r.batchId);
		expect(await pairIds(a.scope.spaceId)).toEqual([
			{ ambiguous: false, pairs: [`${debit!.id}:${payment}:card`] }
		]);
		// The guarded merge itself refuses an `auto` card pair too (never only the chooser).
		const [pair] = (await proposeTransferMatches(db, a.scope.spaceId)).groups[0]!.pairs;
		const choice = {
			debitId: pair!.debit.id,
			creditId: pair!.credit.id,
			debitUpdatedAt: pair!.debit.updatedAt,
			creditUpdatedAt: pair!.credit.updatedAt
		};
		expect(await applyTransferMatch(db, a.scope, choice, NOW + 1, 'auto')).toEqual({
			status: 'stale'
		});
		expect(await applyTransferMatch(db, a.scope, choice, NOW + 2)).toMatchObject({
			status: 'ok'
		});
		expect((await links(a.scope.spaceId))[0]!.source).toBe('manual');
	});

	it('an undone auto-merge is never re-applied to its rows; a hand confirm still works (AC-5)', async () => {
		const a = await account();
		const { debit, credit } = await clearPair(a);
		const before = await rows(
			`select id, created_at from transactions where id in (?, ?) order by id`,
			debit.id,
			credit.id
		);
		const [link] = (await listTransferLinks(db, a.scope.spaceId)).links;
		expect(await undoTransferMatch(db, a.scope, link!.id, NOW + 10)).toBe('ok');
		expect(
			await rows(
				`select id, created_at from transactions where id in (?, ?) and deleted_at is null order by id`,
				debit.id,
				credit.id
			)
		).toEqual(before);
		// The same pair, offered again: the auto merge refuses it, the review lists it.
		const [pair] = (await proposeTransferMatches(db, a.scope.spaceId)).groups[0]!.pairs;
		const choice = {
			debitId: pair!.debit.id,
			creditId: pair!.credit.id,
			debitUpdatedAt: pair!.debit.updatedAt,
			creditUpdatedAt: pair!.credit.updatedAt
		};
		expect(await applyTransferMatch(db, a.scope, choice, NOW + 11, 'auto')).toEqual({
			status: 'stale'
		});
		// A later import brings a new, clear partner for the same debit: still never auto-merged.
		expect(await deleteTransaction(db, a.scope, credit.id, pair!.credit.updatedAt, NOW + 12)).toBe(
			'ok'
		);
		const r = await importInto(
			a.scope,
			a.C,
			statementFile([['2026-07-11', 'TRF DARI BCA LAGI', '5.000.000']])
		);
		expect(r.autoMatchedCount).toBe(0);
		const [newCredit] = await batchRows(r.batchId);
		const groups = (await proposeTransferMatches(db, a.scope.spaceId)).groups;
		expect(groups.map((g) => g.pairs.map((p) => `${p.debit.id}:${p.credit.id}`))).toEqual([
			[`${debit.id}:${newCredit!.id}`]
		]);
		const p = groups[0]!.pairs[0]!;
		expect(
			await applyTransferMatch(
				db,
				a.scope,
				{
					debitId: p.debit.id,
					creditId: p.credit.id,
					debitUpdatedAt: p.debit.updatedAt,
					creditUpdatedAt: p.credit.updatedAt
				},
				NOW + 13
			)
		).toMatchObject({ status: 'ok' });
		expect((await links(a.scope.spaceId)).map((l) => l.source)).toEqual(['auto', 'manual']);
	});

	it('a re-imported statement merges nothing again and writes no second link (AC-6)', async () => {
		const a = await account();
		const { fileB } = await clearPair(a);
		const again = await importInto(a.scope, a.B, fileB, NOW + 20);
		expect(again.batchId).toBeNull();
		expect(again.counts).toMatchObject({ imported: 0, already: 1 });
		expect(again.autoMatchedCount).toBe(0);
		expect(await links(a.scope.spaceId)).toHaveLength(1);
	});

	it(`merges the newest ${AUTO_MATCH_MAX}; the rest stay pending with the true count (AC-7, AC-15: 120 amounts)`, async () => {
		const a = await account();
		const day = (i: number) => new Date(Date.UTC(2026, 0, 2 + i)).toISOString().slice(0, 10);
		const amount = (i: number) => `1.${String(i).padStart(3, '0')}.000`;
		const N = 120;
		const credits: Line[] = [];
		const debits: Line[] = [];
		for (let i = 0; i < N; i++) {
			credits.push([day(i), `TRF MASUK ${i}`, amount(i)]);
			debits.push([day(i), `TRF KELUAR ${i}`, `-${amount(i)}`]);
		}
		expect((await importInto(a.scope, a.B, statementFile(credits))).autoMatchedCount).toBe(0);
		const r = await importInto(a.scope, a.A, statementFile(debits));
		expect(r.counts.imported).toBe(N);
		expect(r.autoMatchedCount).toBe(AUTO_MATCH_MAX);
		const merged = await rows<{ occurred_on: string }>(
			`select occurred_on from transactions where import_batch_id = ? and type = 'transfer'
			order by occurred_on`,
			r.batchId
		);
		expect(merged.map((m) => m.occurred_on)).toEqual(
			Array.from({ length: AUTO_MATCH_MAX }, (_, k) => day(N - AUTO_MATCH_MAX + k))
		);
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(N - AUTO_MATCH_MAX);
	});

	it('reads and writes only its own space (AC-8)', async () => {
		const a = await account();
		const b = await account();
		// b holds a same-amount, same-day debit in its own space: never a competitor, never touched.
		const other = await importInto(
			b.scope,
			b.A,
			statementFile([['2026-07-10', 'TRF KELUAR B', '-5.000.000']])
		);
		const { second } = await clearPair(a);
		expect(second.autoMatchedCount).toBe(1);
		expect((await batchRows(other.batchId))[0]).toMatchObject({
			type: 'expense',
			deleted_at: null
		});
		expect(await links(b.scope.spaceId)).toEqual([]);
		// b's debit now gets a clear partner in b's own space: a's scope with b's batch id merges nothing there.
		await seed(b, b.B, 'income', '2026-07-11');
		expect(await autoMatchTransferPairs(db, a.scope, other.batchId!, NOW)).toEqual({
			autoMatchedCount: 0
		});
		expect(await links(b.scope.spaceId)).toEqual([]);
		expect((await batchRows(other.batchId))[0]).toMatchObject({
			type: 'expense',
			deleted_at: null
		});
		expect(await countTransferMatches(db, b.scope.spaceId)).toBe(1);
	});

	it('a removed member’s in-flight pass is refused like their manual merge (AC-8)', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		await ensurePresetCategories(db, spaceId, NOW);
		const ownerScope = { spaceId, userId: owner.user.id };
		const memberScope = { spaceId, userId: member.user.id };
		const A = await walletIn(ownerScope, 'Bersama A');
		const B = await walletIn(ownerScope, 'Bersama B');
		const r = await importInto(
			memberScope,
			A,
			statementFile([['2026-07-10', 'TRF KELUAR', '-5.000.000']])
		);
		expect(r.autoMatchedCount).toBe(0);
		await seed({ scope: ownerScope }, B, 'income', '2026-07-11');
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW + 1);
		expect(await autoMatchTransferPairs(db, memberScope, r.batchId!, NOW + 2)).toEqual({
			autoMatchedCount: 0
		});
		expect(await links(spaceId)).toEqual([]);
		// The pair itself was clear: a live member's pass merges it.
		expect(await autoMatchTransferPairs(db, ownerScope, r.batchId!, NOW + 3)).toEqual({
			autoMatchedCount: 1
		});
	});

	describe('a change between the pass’s read and its merge (AC-9)', () => {
		/** `db`, running `meanwhile` once just before its first `db.batch` (the merge). */
		function racing(meanwhile: () => Promise<unknown>): Db {
			let ran = false;
			return new Proxy(db, {
				get(target, key) {
					if (key === 'batch')
						return async (statements: Parameters<Db['batch']>[0]) => {
							if (!ran) {
								ran = true;
								await meanwhile();
							}
							return target.batch(statements);
						};
					const value = Reflect.get(target, key, target) as unknown;
					return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
				}
			});
		}

		async function pending(a: Account) {
			const r = await importInto(
				a.scope,
				a.A,
				statementFile([['2026-07-10', 'TRF KELUAR', '-5.000.000']])
			);
			const [debit] = await batchRows(r.batchId);
			const credit = await seed(a, a.B, 'income', '2026-07-11');
			return { batchId: r.batchId!, debit: debit!.id, credit };
		}

		it('a merge that throws stops the pass but still counts the merges already written (red team L1)', async () => {
			const a = await account();
			const r = await importInto(
				a.scope,
				a.A,
				statementFile([
					['2026-07-10', 'TRF KELUAR 1', '-5.000.000'],
					['2026-07-10', 'TRF KELUAR 2', '-7.000.000']
				])
			);
			await seed(a, a.B, 'income', '2026-07-11');
			await seed(a, a.B, 'income', '2026-07-11', 700_000_000);
			let calls = 0;
			const failing = new Proxy(db, {
				get(target, key) {
					if (key === 'batch')
						return async (statements: Parameters<Db['batch']>[0]) => {
							if (++calls === 2) throw new Error('D1_ERROR: simulated');
							return target.batch(statements);
						};
					const value = Reflect.get(target, key, target) as unknown;
					return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
				}
			});
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				expect(await autoMatchTransferPairs(failing, a.scope, r.batchId!, NOW + 1)).toEqual({
					autoMatchedCount: 1
				});
			} finally {
				spy.mockRestore();
			}
			expect((await links(a.scope.spaceId)).map((l) => l.source)).toEqual(['auto']);
		});

		it('a row edited meanwhile is never overwritten; the pair stays for the user', async () => {
			const a = await account();
			const { batchId, debit, credit } = await pending(a);
			const edit = () =>
				d1
					.prepare(
						`update transactions set title = 'DIUBAH', updated_at = updated_at + 1 where id = ?`
					)
					.bind(debit)
					.run();
			expect(await autoMatchTransferPairs(racing(edit), a.scope, batchId, NOW + 1)).toEqual({
				autoMatchedCount: 0
			});
			expect(await links(a.scope.spaceId)).toEqual([]);
			expect(await rows(`select title, type from transactions where id = ?`, debit)).toEqual([
				{ title: 'DIUBAH', type: 'expense' }
			]);
			expect(await pairIds(a.scope.spaceId)).toEqual([
				{ ambiguous: false, pairs: [`${debit}:${credit}:own`] }
			]);
		});

		it('a competing row that appears meanwhile makes the pair ambiguous: nothing merges', async () => {
			const a = await account();
			const { batchId } = await pending(a);
			const compete = () => seed(a, a.C, 'income', '2026-07-10');
			expect(await autoMatchTransferPairs(racing(compete), a.scope, batchId, NOW + 1)).toEqual({
				autoMatchedCount: 0
			});
			expect(await links(a.scope.spaceId)).toEqual([]);
			const groups = await pairIds(a.scope.spaceId);
			expect(groups.map((g) => [g.ambiguous, g.pairs.length])).toEqual([[true, 2]]);
		});
	});

	it('20 concurrent passes over the same batch merge the pair exactly once (concurrency probe)', async () => {
		const a = await account();
		const r = await importInto(
			a.scope,
			a.A,
			statementFile([['2026-07-10', 'TRF KE OCBC', '-5.000.000']])
		);
		await seed(a, a.B, 'income', '2026-07-11');
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) => autoMatchTransferPairs(db, a.scope, r.batchId!, NOW + i))
		);
		expect(results.reduce((sum, x) => sum + x.autoMatchedCount, 0)).toBe(1);
		expect(await links(a.scope.spaceId)).toHaveLength(1);
	});

	it('pairs across a WIB month end by occurred_on; two days apart never (month-boundary probe)', async () => {
		const a = await account();
		await importInto(a.scope, a.A, statementFile([['2026-07-31', 'TRF KE OCBC', '-5.000.000']]));
		const r = await importInto(
			a.scope,
			a.B,
			statementFile([['2026-08-01', 'TRF DARI BCA', '5.000.000']])
		);
		expect(r.autoMatchedCount).toBe(1);
		const b = await account();
		await importInto(b.scope, b.A, statementFile([['2026-07-30', 'TRF KE OCBC', '-5.000.000']]));
		const far = await importInto(
			b.scope,
			b.B,
			statementFile([['2026-08-01', 'TRF DARI BCA', '5.000.000']])
		);
		expect(far.autoMatchedCount).toBe(0);
		expect(await countTransferMatches(db, b.scope.spaceId)).toBe(0);
	});

	it('a CSV import never runs the pass; its pair stays for the user (AC-11)', async () => {
		const a = await account();
		const raw = (
			title: string,
			type: 'expense' | 'income',
			walletName: string,
			category: string
		): RawCsvTransaction => ({
			date: '2026-07-10',
			type,
			title,
			amountMinor: FIVE_M,
			currency: 'IDR',
			categoryName: category,
			walletName,
			paymentMethod: '',
			recurrence: '',
			tag: '',
			notes: '',
			reference: ''
		});
		const file: PreparedRows = {
			source: 'csv',
			format: 'template',
			rows: [
				{ index: 0, ok: true, value: raw('TRSF KELUAR', 'expense', 'BCA', 'Transfer keluar') },
				{ index: 1, ok: true, value: raw('TRSF MASUK', 'income', 'OCBC', 'Transfer masuk') }
			],
			notProcessed: 0,
			keyPrefix: 'csv:otomatis:'
		};
		const opts = { filename: null, fallbackWallet: null, skipPossibleDuplicates: false };
		expect(await importRows(db, a.scope, file, opts, NOW)).toMatchObject({
			ok: true,
			counts: { imported: 2 }
		});
		expect(await links(a.scope.spaceId)).toEqual([]);
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(1);
	});

	it('its read and its guarded merge look rows up by batch, id and amount, never by walking the space', async () => {
		const a = await account();
		const { batchId } = await importInto(
			a.scope,
			a.A,
			statementFile([['2026-07-10', 'TRF KE OCBC', '-5.000.000']])
		).then((r) => ({ batchId: r.batchId! }));
		await seed(a, a.B, 'income', '2026-07-11');
		const dialect = (
			db as unknown as { dialect: { sqlToQuery(q: SQL): { sql: string; params: unknown[] } } }
		).dialect;
		const plans: string[][] = [];
		const plan = async (text: string, params: unknown[]) =>
			plans.push(
				(
					await d1
						.prepare(`explain query plan ${text}`)
						.bind(...params)
						.all<{ detail: string }>()
				).results.map((r) => r.detail)
			);
		const explaining = new Proxy(db, {
			get(target, key) {
				if (key === 'all')
					return async (q: SQL) => {
						const { sql: text, params } = dialect.sqlToQuery(q);
						await plan(text, params);
						return target.all(q);
					};
				if (key === 'batch')
					return async (statements: Parameters<Db['batch']>[0]) => {
						const { sql: text, params } = (
							statements[1] as unknown as { toSQL(): { sql: string; params: unknown[] } }
						).toSQL();
						await plan(text, params);
						return target.batch(statements);
					};
				const value = Reflect.get(target, key, target) as unknown;
				return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
			}
		});
		expect(await autoMatchTransferPairs(explaining, a.scope, batchId, NOW + 1)).toEqual({
			autoMatchedCount: 1
		});
		const [read, merge] = plans;
		expect(read).toContain(
			'SEARCH t USING INDEX transactions_import_batch_idx (space_id=? AND import_batch_id=?)'
		);
		for (const steps of [read!, merge!]) {
			expect(steps.filter((d) => /^SCAN [tdc]\b/.test(d))).toEqual([]);
			expect(
				steps.filter((d) => /^SEARCH [dc] /.test(d) && !/amount_idx|autoindex_transactions/.test(d))
			).toEqual([]);
		}
	});

	it('a failing pass never fails the committed import: logged without row data, counted 0', async () => {
		const a = await account();
		await importInto(a.scope, a.A, statementFile([['2026-07-10', 'TRF KE OCBC', '-5.000.000']]));
		const dialect = (db as unknown as { dialect: { sqlToQuery(q: SQL): { sql: string } } }).dialect;
		const failing = new Proxy(db, {
			get(target, key) {
				if (key === 'all')
					return (q: SQL) => {
						if (dialect.sqlToQuery(q).sql.includes('autoBefore'))
							return Promise.reject(new Error('D1_ERROR: TRF DARI BCA 500000000'));
						return target.all(q);
					};
				const value = Reflect.get(target, key, target) as unknown;
				return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
			}
		});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const r = await importStatement(
				failing,
				a.scope,
				input(statementFile([['2026-07-11', 'TRF DARI BCA', '5.000.000']]), a.B),
				NOW,
				PARSERS
			);
			expect(r).toMatchObject({ ok: true, autoMatchedCount: 0, counts: { imported: 1 } });
			expect(logged).toHaveBeenCalledWith('impor: transfer auto-match failed', 'Error');
		} finally {
			logged.mockRestore();
		}
		expect(await links(a.scope.spaceId)).toEqual([]);
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(1);
	});
});
