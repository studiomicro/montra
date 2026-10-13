import { isActionFailure } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { listImportBatches, undoImportBatch } from '#lib/server/imports/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	checkStatement,
	closeContinuityGap,
	continuityBreaks
} from '#lib/server/statements/continuity';
import {
	importStatement,
	previewStatement,
	type ImportStatementInput
} from '#lib/server/statements/statement-import';
import { createTransaction, deleteTransaction } from '#lib/server/transactions/repo';
import { readWalletBalance } from '#lib/server/transactions/wallet-sum';
import { createWallet } from '#lib/server/wallets/repo';
import { parseMoneyAmount } from '#lib/shared/money-parse';
import { statementRow } from '#lib/shared/statements/rows';
import type { MappedRow, StatementParser } from '#lib/shared/statements/types';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-48 Part B: statement continuity per wallet, end to end on a local D1 — what each statement batch records,
 * the check by date (never import order), per wallet and per space, the gap's one FN-37 adjustment (once, even
 * when confirmed twice at the same time), and its undo by deleting that row. A fictional test-only parser reads a
 * tiny CSV with printed SALDO AWAL / SALDO AKHIR lines; every name and amount is invented, except the owner's
 * real figures in the AC-42 vector (amounts only).
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

/** "Bank Uji Fiktif": CSV only; SALDO AWAL / SALDO AKHIR lines carry the printed balances. */
const TEST_BANK: StatementParser = {
	id: 'uji-saldo',
	label: 'Bank Uji Fiktif',
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
const PARSERS = [TEST_BANK];

type Row = [date: string, title: string, amount: string];
/** A statement file: rows with a signed amount (`-` debit), and the printed balances when given. */
function statementFile(rows: Row[], opening: string | null, closing: string | null): Uint8Array {
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

let n = 0;
async function account() {
	const email = `saldo${++n}@contoh.id`;
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

async function wallet(scope: SpaceScope, name = 'Rekening Uji', openingBalanceMinor = 0) {
	const r = await createWallet(
		db,
		scope,
		{ name, type: 'bank', currency: 'IDR', openingBalanceMinor, isFavourite: true, lastFour: null },
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

const input = (bytes: Uint8Array, walletId: string | null): ImportStatementInput => ({
	bytes,
	password: null,
	institution: null,
	filename: 'mutasi-uji.csv',
	defaultWalletId: walletId,
	skipPossibleDuplicates: false
});

async function importFile(scope: SpaceScope, bytes: Uint8Array, walletId: string) {
	const r = await importStatement(db, scope, input(bytes, walletId), NOW, PARSERS);
	if (!r.ok) throw new Error(`import failed: ${String(r.error)}`);
	return r;
}

async function adjustments(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select id, amount_minor, adjustment_direction, occurred_on, wallet_id, source, updated_at
			from transactions where space_id = ? and type = 'adjustment' and deleted_at is null`
		)
		.bind(spaceId)
		.all<{
			id: string;
			amount_minor: number;
			adjustment_direction: string;
			occurred_on: string;
			wallet_id: string;
			source: string;
			updated_at: number;
		}>();
	return results;
}

// The owner's sample figures (AC-42): opening 0 in the app, July imported, Saldo Awal printed 10.000.000,00.
const JULY: Row[] = [
	['2026-07-01', 'BI-FAST CR UJI', '70.000.000,00'],
	['2026-07-20', 'TARIKAN ATM UJI', '-5.363.795,13']
];
const JULY_FILE = statementFile(JULY, '10.000.000,00', '74.636.204,87');
const AUGUST_FILE = statementFile(
	[
		['2026-08-03', 'KOPI UJI', '-75.856,61'],
		['2026-08-25', 'GAJI UJI', '1.239.651,74']
	],
	'74.636.204,87',
	'75.800.000,00'
);
const SEPTEMBER_AFTER_GAP = statementFile(
	[['2026-09-02', 'LISTRIK UJI', '-300.000,00']],
	'76.000.000,00',
	'75.700.000,00'
);

describe('statement batches record their span and printed balances', () => {
	it('stores the wallet, the first and last row date and both balances; CSV batches stay null', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const r = await importFile(a.scope, JULY_FILE, w);
		const [batch] = (
			await d1
				.prepare(
					`select source, wallet_id, period_from, period_to, opening_balance_minor, closing_balance_minor
					from import_batches where id = ?`
				)
				.bind(r.batchId)
				.all()
		).results;
		expect(batch).toEqual({
			source: 'statement',
			wallet_id: w,
			period_from: '2026-07-01',
			period_to: '2026-07-20',
			opening_balance_minor: 1_000_000_000,
			closing_balance_minor: 7_463_620_487
		});
	});
});

describe('continuity vectors', () => {
	it('AC-41: a first statement whose Saldo Awal equals the wallet balance before it shows no warning', async () => {
		const a = await account();
		const w = await wallet(a.scope, 'Rekening Uji', 1_000_000_000);
		const preview = await previewStatement(
			db,
			a.scope.spaceId,
			{ ...input(JULY_FILE, w) },
			PARSERS
		);
		expect(preview).toMatchObject({
			ok: true,
			summary: { continuity: { status: 'pass', against: 'wallet' } }
		});
		await importFile(a.scope, JULY_FILE, w);
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
	});

	it('AC-42: the owner’s figures report a gap of Rp 10.000.000,00 before 1 July, never silently', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const gap = {
			status: 'gap',
			against: 'wallet',
			periodFrom: '2026-07-01',
			previousPeriodTo: null,
			openingMinor: 1_000_000_000,
			expectedMinor: 0,
			gapMinor: 1_000_000_000,
			adjustOn: '2026-06-30'
		};
		const preview = await previewStatement(db, a.scope.spaceId, input(JULY_FILE, w), PARSERS);
		expect(preview).toMatchObject({ ok: true, summary: { continuity: gap } });
		// AC-45: the rows still import; the gap stays listed until it is resolved.
		const r = await importFile(a.scope, JULY_FILE, w);
		expect(r.counts.imported).toBe(2);
		expect(r.summary.continuity).toEqual(gap);
		expect(await readWalletBalance(db, a.scope.spaceId, w)).toBe(6_463_620_487n);
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([
			{
				batchId: r.batchId,
				walletId: w,
				walletName: 'Rekening Uji',
				periodTo: '2026-07-20',
				...gap
			}
		]);
		expect(await continuityBreaks(db, a.scope.spaceId)).toHaveLength(1);
	});

	it('a gap between two months is measured from the earlier statement’s Saldo Akhir', async () => {
		const a = await account();
		const w = await wallet(a.scope, 'Rekening Uji', 1_000_000_000);
		await importFile(a.scope, JULY_FILE, w);
		const aug = await importFile(a.scope, AUGUST_FILE, w);
		expect(aug.summary.continuity).toEqual({ status: 'pass', against: 'statement' });
		const sep = await importFile(a.scope, SEPTEMBER_AFTER_GAP, w);
		expect(sep.summary.continuity).toEqual({
			status: 'gap',
			against: 'statement',
			periodFrom: '2026-09-02',
			previousPeriodTo: '2026-08-25',
			openingMinor: 7_600_000_000,
			expectedMinor: 7_580_000_000,
			gapMinor: 20_000_000,
			adjustOn: '2026-09-01'
		});
	});

	it('AC-43: statements imported in reverse order are still compared by date', async () => {
		const a = await account();
		const w = await wallet(a.scope, 'Rekening Uji', 1_000_000_000);
		const aug = await importFile(a.scope, AUGUST_FILE, w);
		// Alone, August is compared with the wallet (its balance before 3 August is the opening balance).
		expect(aug.summary.continuity).toMatchObject({ status: 'gap', against: 'wallet' });
		const jul = await importFile(a.scope, JULY_FILE, w);
		expect(jul.summary.continuity).toEqual({ status: 'pass', against: 'wallet' });
		// With July in, August follows July's Saldo Akhir: no break left.
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		expect(
			await checkStatement(db, a.scope.spaceId, w, {
				id: aug.batchId,
				periodFrom: '2026-08-03',
				periodTo: '2026-08-25',
				openingBalanceMinor: 7_463_620_487,
				closingBalanceMinor: 7_580_000_000
			})
		).toEqual({ status: 'pass', against: 'statement' });
	});

	it('overlapping statements are never compared; the same file again changes nothing', async () => {
		const a = await account();
		const w = await wallet(a.scope, 'Rekening Uji', 1_000_000_000);
		const jul = await importFile(a.scope, JULY_FILE, w);
		const again = await importFile(a.scope, JULY_FILE, w);
		expect(again.batchId).toBeNull();
		expect(again.counts.already).toBe(2);
		expect(again.summary.continuity).toEqual(jul.summary.continuity);
		const overlapping = statementFile(
			[
				['2026-07-15', 'PULSA UJI', '-10.000,00'],
				['2026-08-10', 'PULSA UJI', '-10.000,00']
			],
			'1,00',
			'2,00'
		);
		const o = await importFile(a.scope, overlapping, w);
		expect(o.summary.continuity).toEqual({ status: 'overlap' });
		const breaks = await continuityBreaks(db, a.scope.spaceId);
		expect(breaks.map((b) => [b.batchId, b.status]).sort()).toEqual(
			[
				[jul.batchId, 'overlap'],
				[o.batchId, 'overlap']
			].sort()
		);
		// An overlap offers nothing to close.
		expect(await closeContinuityGap(db, a.scope, o.batchId!, 0, NOW)).toEqual({
			ok: false,
			reason: 'already'
		});
	});

	it('AC-46: no claim when the statement or its predecessor printed no balance', async () => {
		const a = await account();
		const w1 = await wallet(a.scope, 'Rekening Satu');
		const noOpening = statementFile([['2026-07-01', 'X UJI', '-1,00']], null, '5,00');
		const r = await importFile(a.scope, noOpening, w1);
		expect(r.summary.continuity).toEqual({ status: 'none' });
		const w2 = await wallet(a.scope, 'Rekening Dua', 9_900);
		const noClosing = statementFile([['2026-08-01', 'Y UJI', '-1,00']], '99,00', null);
		const after = statementFile([['2026-09-01', 'Z UJI', '-1,00']], '42,00', '41,00');
		expect((await importFile(a.scope, noClosing, w2)).summary.continuity).toEqual({
			status: 'pass',
			against: 'wallet'
		});
		// The earlier statement printed no Saldo Akhir: September is not compared with anything.
		expect((await importFile(a.scope, after, w2)).summary.continuity).toEqual({ status: 'none' });
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		// No wallet chosen: nothing is imported and nothing is claimed.
		const preview = await previewStatement(db, a.scope.spaceId, input(JULY_FILE, null), PARSERS);
		expect(preview).toMatchObject({ ok: true, summary: { continuity: { status: 'none' } } });
	});

	it('AC-47: an undone batch is left out as if it had never been imported', async () => {
		const a = await account();
		const w = await wallet(a.scope, 'Rekening Uji', 1_000_000_000);
		const jul = await importFile(a.scope, JULY_FILE, w);
		await importFile(a.scope, AUGUST_FILE, w);
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		const batch = (await listImportBatches(db, a.scope.spaceId)).find((b) => b.id === jul.batchId)!;
		expect(await undoImportBatch(db, a.scope, batch.id, batch.updatedAt, NOW + 1)).toBe('ok');
		// August is now the first statement: compared with the wallet's balance before 3 August (July's rows gone).
		const breaks = await continuityBreaks(db, a.scope.spaceId);
		expect(breaks).toHaveLength(1);
		expect(breaks[0]).toMatchObject({
			against: 'wallet',
			expectedMinor: 1_000_000_000,
			gapMinor: 7_463_620_487 - 1_000_000_000
		});
	});

	it('AC-48: another wallet’s statements never affect the check', async () => {
		const a = await account();
		const w1 = await wallet(a.scope, 'Rekening Satu', 1_000_000_000);
		const w2 = await wallet(a.scope, 'Rekening Dua', 7_463_620_487);
		await importFile(a.scope, JULY_FILE, w1);
		// August in the other wallet: compared with that wallet's own balance, which matches.
		const aug = await importFile(a.scope, AUGUST_FILE, w2);
		expect(aug.summary.continuity).toEqual({ status: 'pass', against: 'wallet' });
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
	});

	it('QA: a leading row skipped as a possible duplicate still counts toward the period, catching an overlap', async () => {
		// The engineer's documented deviation (continuity.ts statementSpan doc comment): the period spans every
		// readable row, written or not. Proven here: without it, this file's period would start at its one
		// freshly written row (5 August) instead of 1 July, missing that it shares 1 July with the July batch
		// already on file — an overlap that must never be silently compared.
		const a = await account();
		const w = await wallet(a.scope, 'Rekening Uji', 1_000_000_000);
		const jul = await importFile(a.scope, JULY_FILE, w);
		expect(jul.summary.continuity).toEqual({ status: 'pass', against: 'wallet' });
		// Same 1 July row as JULY_FILE (date, title, amount): a possible duplicate of an already-live row.
		const reimportWithExtra = statementFile(
			[
				['2026-07-01', 'BI-FAST CR UJI', '70.000.000,00'],
				['2026-08-05', 'KOPI UJI', '-50.000,00']
			],
			'10.000.000,00',
			'70.000.000,00'
		);
		const result = await importStatement(
			db,
			a.scope,
			{ ...input(reimportWithExtra, w), skipPossibleDuplicates: true },
			NOW + 1,
			PARSERS
		);
		if (!result.ok) throw new Error(`import failed: ${String(result.error)}`);
		// Only the fresh 5 August row was written; 1 July was skipped as a possible duplicate, not re-created.
		expect(result.counts.imported).toBe(1);
		const [batch] = (
			await d1
				.prepare('select period_from, period_to from import_batches where id = ?')
				.bind(result.batchId)
				.all()
		).results;
		// The span still starts 1 July — the skipped row's own date — so it correctly overlaps the July batch.
		expect(batch).toEqual({ period_from: '2026-07-01', period_to: '2026-08-05' });
		expect(result.summary.continuity).toEqual({ status: 'overlap' });
		// Same start date: the later-ending statement is listed first (never left to the random id).
		expect(await continuityBreaks(db, a.scope.spaceId)).toMatchObject([
			{ batchId: result.batchId, status: 'overlap' },
			{ batchId: jul.batchId, status: 'overlap' }
		]);
	});

	it('Data demo rows never count in the wallet balance before a statement', async () => {
		const a = await account();
		const w = await wallet(a.scope, 'Rekening Uji', 1_000_000_000);
		await ensurePresetCategories(db, a.scope.spaceId, NOW);
		const income = (await listCategories(db, a.scope.spaceId)).find((c) => c.kind === 'income')!;
		const demo = await createTransaction(
			db,
			a.scope,
			{
				type: 'income',
				amountMinor: 500_000,
				currency: 'IDR',
				walletId: w,
				transferToWalletId: null,
				categoryId: income.id,
				title: 'Demo',
				note: null,
				occurredOn: '2026-06-15',
				occurredTime: null
			},
			NOW,
			{ source: 'manual', dedupeKey: null, isDemo: true }
		);
		expect(demo.ok).toBe(true);
		const preview = await previewStatement(db, a.scope.spaceId, input(JULY_FILE, w), PARSERS);
		expect(preview).toMatchObject({ ok: true, summary: { continuity: { status: 'pass' } } });
	});
});

describe('closing a gap with one balance adjustment', () => {
	it('AC-44: writes exactly one adjustment, dated the day before, after which the wallet matches the bank', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const r = await importFile(a.scope, JULY_FILE, w);
		const done = await closeContinuityGap(db, a.scope, r.batchId!, 1_000_000_000, NOW + 1);
		expect(done.ok).toBe(true);
		expect(await adjustments(a.scope.spaceId)).toEqual([
			expect.objectContaining({
				amount_minor: 1_000_000_000,
				adjustment_direction: 'increase',
				occurred_on: '2026-06-30',
				wallet_id: w,
				source: 'manual'
			})
		]);
		// The wallet now shows the statement's own Saldo Akhir; the opening balance itself is untouched.
		expect(await readWalletBalance(db, a.scope.spaceId, w)).toBe(7_463_620_487n);
		const { results } = await d1
			.prepare('select opening_balance_minor from wallets where id = ?')
			.bind(w)
			.all();
		expect(results).toEqual([{ opening_balance_minor: 0 }]);
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		// Confirmed again (a second tab): nothing more.
		expect(await closeContinuityGap(db, a.scope, r.batchId!, 1_000_000_000, NOW + 2)).toEqual({
			ok: false,
			reason: 'already'
		});
		expect(await adjustments(a.scope.spaceId)).toHaveLength(1);
	});

	it('20 concurrent confirmations write one adjustment', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const r = await importFile(a.scope, JULY_FILE, w);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				closeContinuityGap(db, a.scope, r.batchId!, 1_000_000_000, NOW + i)
			)
		);
		expect(results.filter((x) => x.ok)).toHaveLength(1);
		expect(results.filter((x) => !x.ok).every((x) => !x.ok && x.reason === 'already')).toBe(true);
		expect(await adjustments(a.scope.spaceId)).toHaveLength(1);
		expect(await readWalletBalance(db, a.scope.spaceId, w)).toBe(7_463_620_487n);
	});

	it('closes a gap between months with a decrease dated the day before the later statement', async () => {
		const a = await account();
		const w = await wallet(a.scope, 'Rekening Uji', 1_000_000_000);
		await importFile(a.scope, JULY_FILE, w);
		await importFile(a.scope, AUGUST_FILE, w);
		const missing = statementFile(
			[['2026-09-02', 'LISTRIK UJI', '-300.000,00']],
			'75.000.000,00',
			'74.700.000,00'
		);
		const sep = await importFile(a.scope, missing, w);
		expect(sep.summary.continuity).toMatchObject({ status: 'gap', gapMinor: -80_000_000 });
		expect((await closeContinuityGap(db, a.scope, sep.batchId!, -80_000_000, NOW + 1)).ok).toBe(
			true
		);
		expect(await adjustments(a.scope.spaceId)).toEqual([
			expect.objectContaining({
				amount_minor: 80_000_000,
				adjustment_direction: 'decrease',
				occurred_on: '2026-09-01'
			})
		]);
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		expect(await readWalletBalance(db, a.scope.spaceId, w)).toBe(7_470_000_000n);
	});

	it('deleting the adjustment undoes it: the gap shows again and can be closed again', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const r = await importFile(a.scope, JULY_FILE, w);
		expect((await closeContinuityGap(db, a.scope, r.batchId!, 1_000_000_000, NOW + 1)).ok).toBe(
			true
		);
		const [adj] = await adjustments(a.scope.spaceId);
		expect(await deleteTransaction(db, a.scope, adj!.id, adj!.updated_at, NOW + 2)).toBe('ok');
		expect(await continuityBreaks(db, a.scope.spaceId)).toMatchObject([
			{ batchId: r.batchId, status: 'gap', gapMinor: 1_000_000_000 }
		]);
		expect((await closeContinuityGap(db, a.scope, r.batchId!, 1_000_000_000, NOW + 3)).ok).toBe(
			true
		);
		expect(await adjustments(a.scope.spaceId)).toHaveLength(1);
	});

	it('a page showing another gap is stale; an unknown or another space’s batch is missing', async () => {
		const a = await account();
		const b = await account();
		const w = await wallet(a.scope);
		const r = await importFile(a.scope, JULY_FILE, w);
		expect(await closeContinuityGap(db, a.scope, r.batchId!, 1, NOW)).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(await closeContinuityGap(db, a.scope, 'tidak-ada', 1_000_000_000, NOW)).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(await closeContinuityGap(db, b.scope, r.batchId!, 1_000_000_000, NOW)).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(await continuityBreaks(db, b.scope.spaceId)).toEqual([]);
		expect(await adjustments(a.scope.spaceId)).toEqual([]);
	});

	it('a removed member cannot close a shared space’s gap', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const ownerScope = { spaceId, userId: owner.user.id };
		const w = await wallet(ownerScope);
		const r = await importFile(ownerScope, JULY_FILE, w);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const result = await closeContinuityGap(
			db,
			{ spaceId, userId: member.user.id },
			r.batchId!,
			1_000_000_000,
			NOW + 1
		);
		expect(result.ok).toBe(false);
		expect(await adjustments(spaceId)).toEqual([]);
	});
});

describe('/impor load and ?/closeGap', () => {
	async function event(a: Awaited<ReturnType<typeof account>>, form?: Record<string, string>) {
		return fakeEvent({
			url: form ? 'http://localhost/impor?/closeGap' : 'http://localhost/impor',
			routeId: '/(app)/impor',
			db,
			user: a.user,
			space: await resolveCurrentSpace(db, a.user.id, undefined),
			...(form ? { form } : {})
		}).event as never;
	}
	const closeGap = (e: never) =>
		(impor.actions as Record<string, (event: never) => unknown>).closeGap!(e);

	it('lists the break, closes it from a plain form post, then lists nothing', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const r = await importFile(a.scope, JULY_FILE, w);
		const loaded = (await impor.load(await event(a))) as { continuity: { batchId: string }[] };
		expect(loaded.continuity).toMatchObject([{ batchId: r.batchId, gapMinor: 1_000_000_000 }]);

		const stale = await closeGap(await event(a, { id: r.batchId!, gap: '5' }));
		expect(isActionFailure(stale) && stale.status).toBe(409);
		const malformed = await closeGap(await event(a, { id: r.batchId!, gap: '1e3' }));
		expect(isActionFailure(malformed) && malformed.status).toBe(409);
		const unknown = await closeGap(await event(a, { id: 'x'.repeat(200), gap: '1' }));
		expect(isActionFailure(unknown) && unknown.status).toBe(404);

		expect(await closeGap(await event(a, { id: r.batchId!, gap: '1000000000' }))).toEqual({
			done: 'gapClosed'
		});
		expect(await closeGap(await event(a, { id: r.batchId!, gap: '1000000000' }))).toMatchObject({
			done: 'already'
		});
		const after = (await impor.load(await event(a))) as { continuity: unknown[] };
		expect(after.continuity).toEqual([]);
	});

	it('another account’s post finds nothing (same answer as an unknown id)', async () => {
		const a = await account();
		const b = await account();
		const w = await wallet(a.scope);
		const r = await importFile(a.scope, JULY_FILE, w);
		const res = await closeGap(await event(b, { id: r.batchId!, gap: '1000000000' }));
		expect(isActionFailure(res) && res.status).toBe(404);
		expect(await adjustments(a.scope.spaceId)).toEqual([]);
	});
});
