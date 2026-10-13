import { isActionFailure } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { importCsv } from '#lib/server/imports/csv-import';
import { importBatchMoveStates, moveImportBatch, undoImportBatch } from '#lib/server/imports/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { checkStatement, continuityBreaks } from '#lib/server/statements/continuity';
import { importStatement } from '#lib/server/statements/statement-import';
import {
	deleteTransaction,
	getTransaction,
	updateTransaction
} from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { readWalletBalance } from '#lib/server/transactions/wallet-sum';
import { archiveWallet, createWallet, getWallet } from '#lib/server/wallets/repo';
import { TEMPLATE_COLUMNS } from '#lib/shared/csv';
import { parseMoneyAmount } from '#lib/shared/money-parse';
import { statementRow } from '#lib/shared/statements/rows';
import type { MappedRow, StatementParser } from '#lib/shared/statements/types';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-16j "Pindahkan ke dompet lain", end to end on a local D1: a whole import batch moves to another live
 * same-currency wallet of the space in one write (a statement batch's continuity wallet with it), every refusal
 * writes nothing, a transfer that would point at itself is skipped, and other users, removed members, stale pages
 * and concurrent moves are refused. A fictional test-only parser reads a tiny CSV; every name and amount is
 * invented.
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const impor = await import('../../src/routes/(app)/impor/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

const HEADER = ['uji_tanggal', 'uji_uraian', 'uji_debet', 'uji_kredit'];
const minor = (text: string) => parseMoneyAmount(text)?.minor ?? null;

/** "Bank Uji Pindah": CSV only; SALDO AWAL / SALDO AKHIR lines carry the printed balances. */
const TEST_BANK: StatementParser = {
	id: 'uji-pindah',
	label: 'Bank Uji Pindah',
	formats: ['csv'],
	detect: (doc) =>
		doc.format === 'csv' && HEADER.every((c, i) => (doc.rows[0]?.[i] ?? '').trim() === c) ? 0.9 : 0,
	parse(doc) {
		let opening: number | null = null;
		let closing: number | null = null;
		const rows: MappedRow[] = [];
		if (doc.format === 'csv')
			for (const [date = '', text = '', debit = '', credit = ''] of doc.rows.slice(1)) {
				if (text === 'SALDO AWAL') opening = minor(credit);
				else if (text === 'SALDO AKHIR') closing = minor(credit);
				else
					rows.push(
						statementRow(rows.length, {
							date,
							direction: debit ? 'debit' : 'credit',
							amount: debit || credit,
							description: text
						})
					);
			}
		return { rows, openingBalanceMinor: opening, closingBalanceMinor: closing };
	}
};

type Row = [date: string, title: string, amount: string];
function statementFile(rows: Row[], opening: string | null = null, closing: string | null = null) {
	const q = (s: string) => `"${s}"`;
	const lines = [HEADER.join(',')];
	if (opening !== null) lines.push(`,SALDO AWAL,,${q(opening)}`);
	for (const [date, title, amount] of rows)
		lines.push(
			amount.startsWith('-')
				? `${date},${title},${q(amount.slice(1))},`
				: `${date},${title},,${q(amount)}`
		);
	if (closing !== null) lines.push(`,SALDO AKHIR,,${q(closing)}`);
	return new TextEncoder().encode(lines.join('\n'));
}

const FOUR_ROWS: Row[] = [
	['2026-01-03', 'KOPI UJI', '-25.000,00'],
	['2026-01-10', 'GAJI UJI', '5.000.000,00'],
	['2026-01-31', 'LISTRIK UJI', '-300.000,00'],
	['2026-02-01', 'PULSA UJI', '-50.000,00']
];

let n = 0;
async function account() {
	const email = `pindah${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	return { user: { id: r.userId, email, name: 'Uji', createdAt: 0 }, scope };
}
type Account = Awaited<ReturnType<typeof account>>;

async function wallet(
	scope: SpaceScope,
	name: string,
	opts: { currency?: 'IDR' | 'USD'; opening?: number } = {}
) {
	const r = await createWallet(
		db,
		scope,
		{
			name,
			type: 'bank',
			currency: opts.currency ?? 'IDR',
			openingBalanceMinor: opts.opening ?? 0,
			isFavourite: false,
			lastFour: null
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

async function importFile(scope: SpaceScope, bytes: Uint8Array, walletId: string) {
	const r = await importStatement(
		db,
		scope,
		{
			bytes,
			password: null,
			institution: null,
			filename: 'mutasi-uji.csv',
			defaultWalletId: walletId,
			skipPossibleDuplicates: false
		},
		NOW,
		[TEST_BANK]
	);
	if (!r.ok || !r.batchId) throw new Error(`import failed: ${String(!r.ok && r.error)}`);
	return r.batchId;
}

interface TxRow {
	id: string;
	type: string;
	wallet_id: string | null;
	transfer_to_wallet_id: string | null;
	amount_minor: number | null;
	currency: string | null;
	occurred_on: string | null;
	occurred_at: number | null;
	title: string | null;
	category_id: string | null;
	deleted_at: number | null;
	updated_at: number;
	seq: number;
}

async function batchRows(batchId: string) {
	const { results } = await d1
		.prepare(
			`select id, type, wallet_id, transfer_to_wallet_id, amount_minor, currency,
				occurred_on, occurred_at, title, category_id, deleted_at, updated_at, seq
			from transactions where import_batch_id = ? order by occurred_on, id`
		)
		.bind(batchId)
		.all<TxRow>();
	return results;
}

async function batchRow(batchId: string) {
	return (await d1
		.prepare(`select wallet_id, updated_at, seq, undone_at from import_batches where id = ?`)
		.bind(batchId)
		.first<{
			wallet_id: string | null;
			updated_at: number;
			seq: number;
			undone_at: number | null;
		}>())!;
}

/** Everything a refusal must leave as it was. */
async function snapshot(batchId: string) {
	return { batch: await batchRow(batchId), rows: await batchRows(batchId) };
}

async function auditMoves(spaceId: string) {
	const { results } = await d1
		.prepare(`select * from audit_events where space_id = ? and action = 'import_batch_moved'`)
		.bind(spaceId)
		.all<Record<string, unknown>>();
	return results;
}

/** The money, date and content columns a move must never touch (transactions keep no foreign amount). */
const money = (r: TxRow) => ({
	id: r.id,
	amount_minor: r.amount_minor,
	currency: r.currency,
	occurred_on: r.occurred_on,
	occurred_at: r.occurred_at,
	title: r.title,
	category_id: r.category_id
});

async function move(a: Account, batchId: string, walletId: string, now = NOW + 10) {
	const { updated_at } = await batchRow(batchId);
	return moveImportBatch(db, a.scope, batchId, walletId, updated_at, now);
}

/** An edit-form save of a row, with `over` changed. */
async function edit(scope: SpaceScope, id: string, over: Partial<TransactionInput>, now: number) {
	const t = (await getTransaction(db, scope.spaceId, id))!;
	const input: TransactionInput = {
		type: t.type,
		amountMinor: t.amountMinor,
		currency: t.currency,
		walletId: t.walletId,
		transferToWalletId: t.transferToWalletId,
		categoryId: t.categoryId,
		adjustmentDirection: t.adjustmentDirection,
		title: t.title,
		note: t.note,
		occurredOn: t.occurredOn,
		occurredTime: null,
		...over
	};
	expect(await updateTransaction(db, scope, id, input, t.updatedAt, now)).toBe('ok');
}

describe('moveImportBatch', () => {
	it('AC-1/2/16/23: moves every live row and the continuity wallet, then back; amounts and dates untouched', async () => {
		const a = await account();
		const gopay = await wallet(a.scope, 'GoPay Uji');
		const bca = await wallet(a.scope, 'BCA Uji');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), gopay);
		const before = await batchRows(batchId);
		expect(before.map((r) => r.wallet_id)).toEqual([gopay, gopay, gopay, gopay]);
		const gopayBalance = await readWalletBalance(db, a.scope.spaceId, gopay);
		expect(gopayBalance).toBe(462_500_000n);

		expect(await move(a, batchId, bca)).toEqual({
			ok: true,
			moved: 4,
			skipped: 0,
			walletName: 'BCA Uji'
		});
		const after = await batchRows(batchId);
		expect(after.map((r) => r.wallet_id)).toEqual([bca, bca, bca, bca]);
		expect(after.map(money)).toEqual(before.map(money));
		for (const [i, r] of after.entries()) {
			expect(r.updated_at).toBeGreaterThan(before[i]!.updated_at);
			expect(r.seq).toBeGreaterThan(before[i]!.seq);
		}
		expect((await batchRow(batchId)).wallet_id).toBe(bca);
		// Riwayat/Beranda read the stored rows: the balances follow.
		expect(await readWalletBalance(db, a.scope.spaceId, gopay)).toBe(0n);
		expect(await readWalletBalance(db, a.scope.spaceId, bca)).toBe(462_500_000n);
		expect(await importBatchMoveStates(db, a.scope.spaceId, [batchId])).toEqual(
			new Map([[batchId, { fromWalletId: bca, moveBlocked: null }]])
		);

		// Moving back is just another move.
		expect(await move(a, batchId, gopay, NOW + 20)).toMatchObject({ ok: true, moved: 4 });
		expect((await batchRows(batchId)).map((r) => r.wallet_id)).toEqual([
			gopay,
			gopay,
			gopay,
			gopay
		]);
		expect((await batchRow(batchId)).wallet_id).toBe(gopay);
		expect((await batchRows(batchId)).map(money)).toEqual(before.map(money));
	});

	it('AC-14: one content-free audit row per move', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const to = await wallet(a.scope, 'Ke');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		expect(await auditMoves(a.scope.spaceId)).toEqual([]);
		await move(a, batchId, to);
		const events = await auditMoves(a.scope.spaceId);
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			id: expect.any(String),
			space_id: a.scope.spaceId,
			actor_user_id: a.user.id,
			action: 'import_batch_moved',
			target_user_id: null,
			created_at: NOW + 10
		});
		// A refusal records nothing.
		await move(a, batchId, to, NOW + 11);
		expect(await auditMoves(a.scope.spaceId)).toHaveLength(1);
	});

	it('AC-3/4: an edited row moves with its edits; a deleted row stays a tombstone, untouched', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const to = await wallet(a.scope, 'Ke');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const [first, second] = await batchRows(batchId);
		await edit(a.scope, first!.id, { title: 'Kopi diubah', amountMinor: 3_100_000 }, NOW + 1);
		const t = (await getTransaction(db, a.scope.spaceId, second!.id))!;
		expect(await deleteTransaction(db, a.scope, second!.id, t.updatedAt, NOW + 2)).toBe('ok');
		const before = await batchRows(batchId);
		const tombstone = before.find((r) => r.id === second!.id)!;

		expect(await move(a, batchId, to)).toMatchObject({ ok: true, moved: 3, skipped: 0 });
		const after = await batchRows(batchId);
		const edited = after.find((r) => r.id === first!.id)!;
		expect(edited).toMatchObject({ wallet_id: to, title: 'Kopi diubah', amount_minor: 3_100_000 });
		expect(after.find((r) => r.id === second!.id)).toEqual(tombstone);
		expect(tombstone).toMatchObject({ wallet_id: null, amount_minor: null });
		expect(tombstone.deleted_at).not.toBeNull();
	});

	it('AC-5: a batch whose rows sit in more than one wallet is refused whole', async () => {
		const a = await account();
		const def = await wallet(a.scope, 'Utama');
		const to = await wallet(a.scope, 'Tujuan');
		const cols = TEMPLATE_COLUMNS.join(',');
		const line = (r: Partial<Record<(typeof TEMPLATE_COLUMNS)[number], string>>) =>
			TEMPLATE_COLUMNS.map((c) => r[c] ?? '').join(',');
		const file =
			[
				cols,
				line({ date: '2026-03-01', type: 'expense', merchant: 'Toko Uji', amount: '10000' }),
				line({
					date: '2026-03-02',
					type: 'expense',
					merchant: 'Warung Uji',
					amount: '20000',
					wallet_source: 'Dompet Lain Uji'
				})
			].join('\n') + '\n';
		const csv = await importCsv(
			db,
			a.scope,
			{
				fileText: file,
				filename: 'uji.csv',
				format: null,
				defaultWalletId: def,
				skipPossibleDuplicates: false
			},
			NOW
		);
		if (!csv.ok || !csv.batchId) throw new Error('csv import failed');
		const batchId = csv.batchId;
		expect((await importBatchMoveStates(db, a.scope.spaceId, [batchId])).get(batchId)).toEqual({
			fromWalletId: null,
			moveBlocked: 'mixed_wallets'
		});
		const before = await snapshot(batchId);
		expect(await move(a, batchId, to)).toEqual({ ok: false, reason: 'mixed_wallets' });
		expect(await snapshot(batchId)).toEqual(before);
		expect(await auditMoves(a.scope.spaceId)).toEqual([]);
	});

	it('AC-5 (decision 3): one row moved by hand blocks the batch; it is never dragged back', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const other = await wallet(a.scope, 'Lain');
		const to = await wallet(a.scope, 'Ke');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const [first] = await batchRows(batchId);
		await edit(a.scope, first!.id, { walletId: other }, NOW + 1);
		expect((await importBatchMoveStates(db, a.scope.spaceId, [batchId])).get(batchId)).toEqual({
			fromWalletId: null,
			moveBlocked: 'mixed_wallets'
		});
		const before = await snapshot(batchId);
		expect(await move(a, batchId, to)).toEqual({ ok: false, reason: 'mixed_wallets' });
		expect(await snapshot(batchId)).toEqual(before);
	});

	it('a batch with no live row left has nothing to move', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const to = await wallet(a.scope, 'Ke');
		const batchId = await importFile(a.scope, statementFile([FOUR_ROWS[0]!]), from);
		const [only] = await batchRows(batchId);
		expect(await deleteTransaction(db, a.scope, only!.id, only!.updated_at, NOW + 1)).toBe('ok');
		expect((await importBatchMoveStates(db, a.scope.spaceId, [batchId])).get(batchId)).toEqual({
			fromWalletId: null,
			moveBlocked: 'nothing_to_move'
		});
		const before = await snapshot(batchId);
		expect(await move(a, batchId, to)).toEqual({ ok: false, reason: 'nothing_to_move' });
		expect(await snapshot(batchId)).toEqual(before);
	});

	it('AC-6: only the source side of a transfer moves; a transfer that would point at itself is skipped', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const x = await wallet(a.scope, 'Tabungan X');
		const to = await wallet(a.scope, 'Ke');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const [r1, r2, r3, r4] = await batchRows(batchId);
		const transfer = { type: 'transfer' as const, categoryId: null };
		await edit(a.scope, r1!.id, { ...transfer, transferToWalletId: x }, NOW + 1);
		await edit(a.scope, r2!.id, { ...transfer, transferToWalletId: to }, NOW + 1);
		await edit(a.scope, r3!.id, { ...transfer, walletId: x, transferToWalletId: from }, NOW + 1);
		await edit(a.scope, r4!.id, { ...transfer, walletId: to, transferToWalletId: from }, NOW + 1);
		const before = await batchRows(batchId);

		expect(await move(a, batchId, to)).toEqual({
			ok: true,
			moved: 2,
			skipped: 2,
			walletName: 'Ke'
		});
		const after = new Map((await batchRows(batchId)).map((r) => [r.id, r]));
		expect(after.get(r1!.id)).toMatchObject({ wallet_id: to, transfer_to_wallet_id: x });
		expect(after.get(r3!.id)).toMatchObject({ wallet_id: x, transfer_to_wallet_id: to });
		// Skipped rows are untouched (no wallet change, no new version).
		expect(after.get(r2!.id)).toEqual(before.find((r) => r.id === r2!.id));
		expect(after.get(r4!.id)).toEqual(before.find((r) => r.id === r4!.id));
	});

	it('AC-7/8/9: a different currency, an archived, unknown or other-space wallet, or the same wallet is refused', async () => {
		const a = await account();
		const b = await account();
		const from = await wallet(a.scope, 'Dari');
		const usd = await wallet(a.scope, 'Dolar', { currency: 'USD' });
		const archived = await wallet(a.scope, 'Lama');
		const theirs = await wallet(b.scope, 'Punya B');
		const w = (await getWallet(db, a.scope.spaceId, archived))!;
		expect(await archiveWallet(db, a.scope, archived, w.updatedAt, NOW + 1)).toBe('ok');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const before = await snapshot(batchId);

		expect(await move(a, batchId, usd)).toEqual({ ok: false, reason: 'currency_mismatch' });
		for (const target of [archived, theirs, 'tidak-ada', ''])
			expect(await move(a, batchId, target)).toEqual({ ok: false, reason: 'wallet_not_found' });
		expect(await move(a, batchId, from)).toEqual({ ok: false, reason: 'same_wallet' });
		expect(await snapshot(batchId)).toEqual(before);
		expect(await auditMoves(a.scope.spaceId)).toEqual([]);
	});

	it('AC-10: an undone batch is refused as already undone', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const to = await wallet(a.scope, 'Ke');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const { updated_at } = await batchRow(batchId);
		expect(await undoImportBatch(db, a.scope, batchId, updated_at, NOW + 1)).toBe('ok');
		const before = await snapshot(batchId);
		expect(await move(a, batchId, to)).toEqual({ ok: false, reason: 'already' });
		expect(await snapshot(batchId)).toEqual(before);
	});

	it('AC-11: a stale page is refused; 20 concurrent moves of one version: exactly one wins', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const to = await wallet(a.scope, 'Ke');
		const other = await wallet(a.scope, 'Lain');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const { updated_at } = await batchRow(batchId);
		expect(await moveImportBatch(db, a.scope, batchId, to, updated_at - 1, NOW + 1)).toEqual({
			ok: false,
			reason: 'stale'
		});
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				moveImportBatch(db, a.scope, batchId, i % 2 ? to : other, updated_at, NOW + 5)
			)
		);
		const wins = results.filter((r) => r.ok);
		expect(wins).toHaveLength(1);
		expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'stale')).toBe(true);
		const winner = (wins[0] as { walletName: string }).walletName === 'Ke' ? to : other;
		expect((await batchRows(batchId)).map((r) => r.wallet_id)).toEqual([
			winner,
			winner,
			winner,
			winner
		]);
		expect(await auditMoves(a.scope.spaceId)).toHaveLength(1);
	});

	it('a row moved by hand between the read and the write makes the move stale (nothing moves)', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const other = await wallet(a.scope, 'Lain');
		const to = await wallet(a.scope, 'Ke');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const [first] = await batchRows(batchId);
		// The other tab's edit lands right before the move's write.
		const racing = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'batch')
					return async (items: Parameters<Db['batch']>[0]) => {
						await d1
							.prepare(`update transactions set wallet_id = ? where id = ?`)
							.bind(other, first!.id)
							.run();
						return target.batch(items);
					};
				return Reflect.get(target, prop, receiver);
			}
		});
		const { updated_at } = await batchRow(batchId);
		const before = await snapshot(batchId);
		expect(await moveImportBatch(racing, a.scope, batchId, to, updated_at, NOW + 1)).toEqual({
			ok: false,
			reason: 'stale'
		});
		const after = await snapshot(batchId);
		expect(after.batch).toEqual(before.batch);
		expect(after.rows.filter((r) => r.wallet_id === to)).toEqual([]);
	});

	it('AC-12: another space’s batch or wallet answers exactly like a missing one', async () => {
		const a = await account();
		const b = await account();
		const aFrom = await wallet(a.scope, 'Dari A');
		const aTo = await wallet(a.scope, 'Ke A');
		const bFrom = await wallet(b.scope, 'Dari B');
		const aBatch = await importFile(a.scope, statementFile(FOUR_ROWS), aFrom);
		const bBatch = await importFile(b.scope, statementFile(FOUR_ROWS), bFrom);
		const { updated_at } = await batchRow(aBatch);
		const before = await snapshot(aBatch);
		expect(await moveImportBatch(db, b.scope, aBatch, bFrom, updated_at, NOW + 1)).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(await moveImportBatch(db, b.scope, 'tidak-ada', bFrom, updated_at, NOW + 1)).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(await move(b, bBatch, aTo)).toEqual({ ok: false, reason: 'wallet_not_found' });
		expect(await snapshot(aBatch)).toEqual(before);
		expect(await importBatchMoveStates(db, b.scope.spaceId, [aBatch])).toEqual(
			new Map([[aBatch, { fromWalletId: null, moveBlocked: 'nothing_to_move' }]])
		);
	});

	it('AC-13: a member removed after the page loaded is refused; nothing changes', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const ownerScope = { spaceId, userId: owner.user.id };
		const from = await wallet(ownerScope, 'Dari');
		const to = await wallet(ownerScope, 'Ke');
		const batchId = await importFile(ownerScope, statementFile(FOUR_ROWS), from);
		const { updated_at } = await batchRow(batchId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const before = await snapshot(batchId);
		expect(
			await moveImportBatch(
				db,
				{ spaceId, userId: member.user.id },
				batchId,
				to,
				updated_at,
				NOW + 1
			)
		).toEqual({ ok: false, reason: 'missing' });
		expect(await snapshot(batchId)).toEqual(before);
		expect(await auditMoves(spaceId)).toEqual([]);
	});

	it('FN-16j red team L1: a member removed while the move runs gets missing, never a status', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const ownerScope = { spaceId, userId: owner.user.id };
		const from = await wallet(ownerScope, 'Dari');
		const to = await wallet(ownerScope, 'Ke');
		const batchId = await importFile(ownerScope, statementFile(FOUR_ROWS), from);
		const { updated_at } = await batchRow(batchId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		// The owner removes the member after the move's first read passed, right before its write.
		const racing = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'batch')
					return async (items: Parameters<Db['batch']>[0]) => {
						await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
						return target.batch(items);
					};
				return Reflect.get(target, prop, receiver);
			}
		});
		const before = await snapshot(batchId);
		expect(
			await moveImportBatch(
				racing,
				{ spaceId, userId: member.user.id },
				batchId,
				to,
				updated_at,
				NOW + 1
			)
		).toEqual({ ok: false, reason: 'missing' });
		expect(await snapshot(batchId)).toEqual(before);
		expect(await auditMoves(spaceId)).toEqual([]);
	});

	it('FN-16j red team L2: a batch whose wallet is archived stays there, before or during the move', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const to = await wallet(a.scope, 'Ke');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const { updated_at } = await batchRow(batchId);
		const before = await snapshot(batchId);
		// Archived while the move runs: the guard refuses, nothing moves.
		const racing = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'batch')
					return async (items: Parameters<Db['batch']>[0]) => {
						await d1
							.prepare(`update wallets set deleted_at = ? where id = ?`)
							.bind(NOW, from)
							.run();
						return target.batch(items);
					};
				return Reflect.get(target, prop, receiver);
			}
		});
		expect(await moveImportBatch(racing, a.scope, batchId, to, updated_at, NOW + 1)).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(await snapshot(batchId)).toEqual(before);
		// Archived before: refused up front with its own reason.
		expect(await move(a, batchId, to)).toEqual({ ok: false, reason: 'source_archived' });
		expect(await snapshot(batchId)).toEqual(before);
		expect(await auditMoves(a.scope.spaceId)).toEqual([]);
	});

	it('AC-15: the continuity check follows the moved statement to its new wallet', async () => {
		const a = await account();
		const bca = await wallet(a.scope, 'BCA Uji', { opening: 1_000_000_000 });
		const gopay = await wallet(a.scope, 'GoPay Uji');
		const julyFile = statementFile(
			[
				['2026-07-01', 'BI-FAST CR UJI', '70.000.000,00'],
				['2026-07-20', 'TARIKAN ATM UJI', '-5.363.795,13']
			],
			'10.000.000,00',
			'74.636.204,87'
		);
		const augustFile = statementFile(
			[
				['2026-08-03', 'KOPI UJI', '-75.856,61'],
				['2026-08-25', 'GAJI UJI', '1.239.651,74']
			],
			'74.636.204,87',
			'75.800.000,00'
		);
		await importFile(a.scope, julyFile, bca);
		// GoPay has its own earlier statement too.
		await importFile(
			a.scope,
			statementFile([['2026-06-02', 'TOPUP UJI', '100.000,00']], '0,00', '100.000,00'),
			gopay
		);
		const august = await importFile(a.scope, augustFile, gopay);
		const span = {
			id: august,
			periodFrom: '2026-08-03',
			periodTo: '2026-08-25',
			openingBalanceMinor: 7_463_620_487,
			closingBalanceMinor: 7_580_000_000
		};
		const breaks = await continuityBreaks(db, a.scope.spaceId);
		expect(breaks).toMatchObject([{ batchId: august, walletId: gopay, status: 'gap' }]);
		expect(await checkStatement(db, a.scope.spaceId, gopay, span)).toMatchObject({ status: 'gap' });

		expect(await move(a, august, bca)).toMatchObject({ ok: true, moved: 2 });
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		expect(await checkStatement(db, a.scope.spaceId, bca, span)).toMatchObject({
			status: 'pass'
		});
	});

	it('binds any number of batch ids once (120 ids)', async () => {
		const a = await account();
		const from = await wallet(a.scope, 'Dari');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const ids = [...Array.from({ length: 119 }, (_, i) => `tidak-ada-${i}`), batchId];
		const states = await importBatchMoveStates(db, a.scope.spaceId, ids);
		expect(states.size).toBe(120);
		expect(states.get(batchId)).toEqual({ fromWalletId: from, moveBlocked: null });
	});
});

describe('/impor load and ?/move', () => {
	async function event(a: Account, form?: Record<string, string>) {
		return fakeEvent({
			url: form ? 'http://localhost/impor?/move' : 'http://localhost/impor',
			routeId: '/(app)/impor',
			db,
			user: a.user,
			space: await resolveCurrentSpace(db, a.user.id, undefined),
			...(form ? { form } : {})
		}).event as never;
	}
	const post = (e: never) => (impor.actions as Record<string, (event: never) => unknown>).move!(e);
	const failure = (r: unknown) =>
		isActionFailure(r) ? { status: r.status, data: r.data } : { status: 200, data: r };

	it('lists the move state and targets, moves from a plain form post, and maps every refusal', async () => {
		const a = await account();
		const b = await account();
		const from = await wallet(a.scope, 'Dari');
		const to = await wallet(a.scope, 'Ke');
		const usd = await wallet(a.scope, 'Dolar', { currency: 'USD' });
		const theirs = await wallet(b.scope, 'Punya B');
		const batchId = await importFile(a.scope, statementFile(FOUR_ROWS), from);
		const bBatch = await importFile(b.scope, statementFile(FOUR_ROWS), theirs);
		const loaded = (await impor.load(await event(a))) as {
			batches: { id: string; fromWalletId: string | null; moveBlocked: string | null }[];
			moveWallets: { id: string; name: string; currency: string }[];
		};
		expect(loaded.batches).toMatchObject([{ id: batchId, fromWalletId: from, moveBlocked: null }]);
		expect(loaded.moveWallets).toEqual(
			expect.arrayContaining([
				{ id: from, name: 'Dari', currency: 'IDR' },
				{ id: to, name: 'Ke', currency: 'IDR' },
				{ id: usd, name: 'Dolar', currency: 'USD' }
			])
		);
		expect(loaded.moveWallets.map((w) => w.id)).not.toContain(theirs);

		const version = String((await batchRow(batchId)).updated_at);
		const form = (over: Record<string, string>) => ({
			id: batchId,
			updatedAt: version,
			walletId: to,
			...over
		});
		const before = await snapshot(batchId);
		// Another space's batch and an unknown or overlong id: one answer (status and body).
		const foreign = failure(await post(await event(a, form({ id: bBatch }))));
		const unknown = failure(await post(await event(a, form({ id: 'tidak-ada' }))));
		const overlong = failure(await post(await event(a, form({ id: 'x'.repeat(200) }))));
		expect(foreign).toEqual({ status: 404, data: { error: 'Impor tidak ditemukan.' } });
		expect(unknown).toEqual(foreign);
		expect(overlong).toEqual(foreign);
		// Another space's wallet and an unknown one: one answer.
		const foreignWallet = failure(await post(await event(a, form({ walletId: theirs }))));
		expect(foreignWallet).toEqual({ status: 404, data: { error: 'Dompet tidak ditemukan.' } });
		expect(failure(await post(await event(a, form({ walletId: 'tidak-ada' }))))).toEqual(
			foreignWallet
		);
		expect(failure(await post(await event(a, form({ walletId: usd }))))).toMatchObject({
			status: 400
		});
		expect(failure(await post(await event(a, form({ walletId: from }))))).toMatchObject({
			status: 400
		});
		expect(failure(await post(await event(a, form({ updatedAt: '1e3' }))))).toMatchObject({
			status: 409
		});
		expect(await snapshot(batchId)).toEqual(before);

		expect(await post(await event(a, form({})))).toEqual({
			done: 'moved',
			// FN-51: the page replays the enter animation on this batch's row.
			batchId,
			moved: 4,
			skipped: 0,
			walletName: 'Ke'
		});
		// The same page posted again is out of date.
		expect(failure(await post(await event(a, form({}))))).toMatchObject({ status: 409 });
		const reloaded = (await impor.load(await event(a))) as typeof loaded;
		expect(reloaded.batches).toMatchObject([{ id: batchId, fromWalletId: to, moveBlocked: null }]);
	});
});
