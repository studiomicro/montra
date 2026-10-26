import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { cardSummaries } from '#lib/server/cards/summary';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { listImportBatches, moveImportBatch, undoImportBatch } from '#lib/server/imports/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { closeContinuityGap, continuityBreaks } from '#lib/server/statements/continuity';
import {
	importStatement,
	previewStatement,
	type ImportStatementInput
} from '#lib/server/statements/statement-import';
import { createTransaction } from '#lib/server/transactions/repo';
import { readWalletBalance } from '#lib/server/transactions/wallet-sum';
import { countTransferMatches } from '#lib/server/transfers/match';
import { createWallet, getWallet, updateWallet } from '#lib/server/wallets/repo';
import type { StatementParser } from '#lib/shared/statements/types';
import { FICTIONAL_BANK, fictionalStatementPdf } from '../fixtures/statements/fictional-bank';
import {
	FICTIONAL_CARD,
	FICTIONAL_CARD_SPEC,
	fictionalCardPages,
	fictionalCardPdf
} from '../fixtures/statements/fictional-card';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-55b (card statement import), proven with the test-only fictional issuer: the strict self-check writes nothing
 * on any doubt, the wallet-kind gate, the card's last 4, statement-level dedupe (any bytes), the card duplicate
 * rule, statement-to-statement continuity, undo and move carrying the statement record, categories by class,
 * passwords, concurrency, and two users in two spaces.
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
// The shipped registry has no card parser (no real sample yet); route tests put the fictional one in.
const registry = vi.hoisted(() => [] as unknown[]);
vi.mock('#lib/shared/statements/parsers', () => ({ STATEMENT_PARSERS: registry }));

const impor = await import('../../src/routes/(app)/impor/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.parse('2026-10-26T03:00:00Z');
const PARSERS: StatementParser[] = [FICTIONAL_BANK, FICTIONAL_CARD];

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());
afterEach(() => {
	registry.length = 0;
});

let n = 0;
async function account() {
	const email = `tagihan${++n}@contoh.id`;
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

async function wallet(
	scope: SpaceScope,
	over: Partial<Parameters<typeof createWallet>[2]> = {}
): Promise<string> {
	const r = await createWallet(
		db,
		scope,
		{
			name: 'Kartu Fiktif',
			type: 'kartu_kredit',
			currency: 'IDR',
			openingBalanceMinor: -200000000,
			isFavourite: false,
			lastFour: null,
			...over
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

const input = (
	bytes: Uint8Array,
	walletId: string | null,
	over: Partial<ImportStatementInput> = {}
): ImportStatementInput => ({
	bytes: bytes.slice(),
	password: null,
	institution: null,
	filename: 'tagihan-fiktif.pdf',
	defaultWalletId: walletId,
	skipPossibleDuplicates: true,
	...over
});

const count = async (table: string, spaceId: string, live = true) =>
	(
		await d1
			.prepare(
				`select count(*) as n from ${table} where space_id = ?${live ? ' and deleted_at is null' : ''}`
			)
			.bind(spaceId)
			.first<{ n: number }>()
	)?.n ?? 0;
const written = async (spaceId: string) => ({
	transactions: await count('transactions', spaceId, false),
	batches: await count('import_batches', spaceId, false),
	statements: await count('card_statements', spaceId, false)
});

async function rowsOf(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select t.occurred_on, t.type, t.amount_minor, t.title, t.note, t.source, t.category_source, c.tile_key
			from transactions t left join categories c on c.id = t.category_id
			where t.space_id = ? and t.deleted_at is null order by t.occurred_on, t.title`
		)
		.bind(spaceId)
		.all<Record<string, string | number | null>>();
	return results;
}

describe('card statement import (AC 19, 32, 18, 42)', () => {
	it('imports the fictional statement: rows by class, the stored statement, and the card page shows it', async () => {
		const a = await account();
		const w = await wallet(a.scope, { lastFour: '0001' });
		const preview = await previewStatement(
			db,
			a.scope.spaceId,
			input(fictionalCardPdf(), w),
			PARSERS
		);
		expect(preview).toMatchObject({
			ok: true,
			summary: {
				institution: { id: 'fiktif-kartu' },
				balance: { status: 'pass' },
				continuity: { status: 'none' },
				card: {
					statementDate: '2026-10-25',
					dueDate: '2026-11-12',
					previousBalanceMinor: -200000000,
					newBalanceMinor: -132500050,
					minimumPaymentMinor: 10000000,
					limitMinor: 1500000000,
					totals: { payments: 200000000, purchases: 125000050, fees: 7500000, interest: 0 },
					feesAndInterestMinor: 7500000,
					walletBalanceMinor: -200000000
				}
			},
			counts: { rows: 5, imported: 5, possibleDuplicates: 0 }
		});
		expect(await written(a.scope.spaceId)).toEqual({ transactions: 0, batches: 0, statements: 0 });

		const r = await importStatement(db, a.scope, input(fictionalCardPdf(), w), NOW, PARSERS);
		expect(r).toMatchObject({ ok: true, counts: { imported: 5 } });
		expect(await rowsOf(a.scope.spaceId)).toEqual([
			{
				occurred_on: '2026-09-27',
				type: 'expense',
				amount_minor: 80000050,
				title: 'TOKO BUKU CONTOH',
				note: null,
				source: 'statement',
				category_source: 'auto',
				tile_key: expect.any(String)
			},
			{
				occurred_on: '2026-09-30',
				type: 'income',
				amount_minor: 200000000,
				title: 'PEMBAYARAN TERIMA KASIH',
				note: null,
				source: 'statement',
				category_source: 'auto',
				tile_key: 'transfer'
			},
			{
				occurred_on: '2026-10-05',
				type: 'expense',
				amount_minor: 20500000,
				title: 'LANGGANAN FIKTIF ONLINE',
				note: 'USD 12,50',
				source: 'statement',
				category_source: 'auto',
				tile_key: expect.any(String)
			},
			{
				occurred_on: '2026-10-10',
				type: 'expense',
				amount_minor: 24500000,
				title: 'CICILAN TOKO ELEKTRONIK FIKTIF',
				note: 'CICILAN 3/12',
				source: 'statement',
				category_source: 'auto',
				tile_key: expect.any(String)
			},
			{
				occurred_on: '2026-10-25',
				type: 'expense',
				amount_minor: 7500000,
				title: 'BIAYA TAHUNAN',
				note: null,
				source: 'statement',
				category_source: 'auto',
				tile_key: 'biaya-bank'
			}
		]);
		const { results: stored } = await d1
			.prepare(
				'select statement_date, due_date, period_from, period_to, previous_balance_minor, new_balance_minor, minimum_payment_minor, limit_minor, currency from card_statements where space_id = ?'
			)
			.bind(a.scope.spaceId)
			.all();
		expect(stored).toEqual([
			{
				statement_date: '2026-10-25',
				due_date: '2026-11-12',
				period_from: '2026-09-26',
				period_to: '2026-10-25',
				previous_balance_minor: -200000000,
				new_balance_minor: -132500050,
				minimum_payment_minor: 10000000,
				limit_minor: 1500000000,
				currency: 'IDR'
			}
		]);
		// The wallet now owes the printed new balance exactly; the card page's bill agrees (no gap).
		expect(await readWalletBalance(db, a.scope.spaceId, w)).toBe(-132500050n);
		const card = (await getWallet(db, a.scope.spaceId, w))!;
		const [s] = await cardSummaries(
			db,
			a.scope.spaceId,
			[{ ...card, balanceMinor: -132500050 }],
			'2026-10-26'
		);
		expect(s).toMatchObject({
			unmatchedPayments: 1,
			bill: { paidMinor: 0, remainingMinor: 132500050, unbilledMinor: 0, gapMinor: 0 },
			due: { kind: 'in', days: 17, date: '2026-11-12' }
		});
		// The printed limit is never written to the wallet, nor the printed card's last 4.
		expect(card).toMatchObject({ creditLimitMinor: null, lastFour: '0001' });
	});

	it('a card number in a description is kept as its last 4 only', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const rows = [...FICTIONAL_CARD_SPEC.rows];
		rows[0] = '27/09 28/09 TOKO 4111111111110001 800.000,50';
		await importStatement(
			db,
			a.scope,
			input(fictionalCardPdf(fictionalCardPages({ rows })), w),
			NOW,
			PARSERS
		);
		const titles = (await rowsOf(a.scope.spaceId)).map((r) => r.title);
		expect(titles).toContain('TOKO ••••0001');
		expect(JSON.stringify(titles)).not.toContain('4111111111110001');
	});

	it("the printed card last 4 must match the wallet's; an unset wallet last 4 is never written (AC 25)", async () => {
		const a = await account();
		const other = await wallet(a.scope, { lastFour: '9999', name: 'Lain' });
		const before = await written(a.scope.spaceId);
		expect(
			await importStatement(db, a.scope, input(fictionalCardPdf(), other), NOW, PARSERS)
		).toMatchObject({
			ok: false,
			error: 'card_mismatch'
		});
		expect(await written(a.scope.spaceId)).toEqual(before);
		const unset = await wallet(a.scope, { name: 'Tanpa' });
		expect(
			await importStatement(db, a.scope, input(fictionalCardPdf(), unset), NOW, PARSERS)
		).toMatchObject({ ok: true });
		expect((await getWallet(db, a.scope.spaceId, unset))?.lastFour).toBeNull();
	});
});

describe('fail closed: nothing is written (AC 20, 21, 29)', () => {
	const cases: [string, string[][]][] = [
		['new balance one sen wrong', fictionalCardPages({ next: '1.325.000,51' })],
		['payments total wrong', fictionalCardPages({ payments: '1.999.999,99' })],
		['purchases total wrong', fictionalCardPages({ purchases: '1.250.000,49' })],
		[
			'an unreadable row',
			fictionalCardPages({
				rows: FICTIONAL_CARD_SPEC.rows.map((r, i) => (i === 0 ? '27/09 28/09 TOKO 800.000,5' : r))
			})
		],
		[
			'an amount forged inside a description',
			fictionalCardPages({
				rows: FICTIONAL_CARD_SPEC.rows.map((r, i) =>
					i === 0 ? '27/09 28/09 TOKO 1.000,00 BUKU 800.000,50' : r
				)
			})
		],
		[
			'a forged "TAGIHAN BARU" line inside the table',
			fictionalCardPages({ rows: ['TAGIHAN BARU 0,00', ...FICTIONAL_CARD_SPEC.rows] })
		],
		[
			'a table line outside a table',
			fictionalCardPages().map((p, i) => (i === 1 ? [...p, '01/10 01/10 TOKO 1.000,00'] : p))
		]
	];
	it.each(cases)('%s: refused whole as inconsistent', async (_name, pages) => {
		const a = await account();
		const w = await wallet(a.scope);
		const r = await importStatement(db, a.scope, input(fictionalCardPdf(pages), w), NOW, PARSERS);
		expect(r).toMatchObject({ ok: false, error: 'inconsistent' });
		expect(await written(a.scope.spaceId)).toEqual({ transactions: 0, batches: 0, statements: 0 });
	});

	it("a second issuer's letterhead planted in a description refuses the file (institution_conflict)", async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const rows = [...FICTIONAL_CARD_SPEC.rows];
		rows[0] = '27/09 28/09 BANK CONTOH FIKTIF 800.000,50';
		const r = await importStatement(
			db,
			a.scope,
			input(fictionalCardPdf(fictionalCardPages({ rows })), w),
			NOW,
			PARSERS
		);
		expect(r).toMatchObject({ ok: false, error: 'institution_conflict' });
		expect(await written(a.scope.spaceId)).toEqual({ transactions: 0, batches: 0, statements: 0 });
	});

	it('AC 29: a statement printing a second card is refused as not supported yet', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pages = fictionalCardPages().map((p, i) =>
			i === 1
				? p.map((l) => (l.startsWith('NOMOR KARTU') ? 'NOMOR KARTU 4111 11** **** 0002' : l))
				: p
		);
		expect(
			await importStatement(db, a.scope, input(fictionalCardPdf(pages), w), NOW, PARSERS)
		).toMatchObject({
			ok: false,
			error: 'card_unsupported'
		});
		expect(await written(a.scope.spaceId)).toEqual({ transactions: 0, batches: 0, statements: 0 });
	});
});

describe('wallet kind and currency gate (AC 25, 18)', () => {
	it('a card statement into a bank wallet or no wallet, a bank statement into a card wallet: refused, nothing written', async () => {
		const a = await account();
		const card = await wallet(a.scope);
		const bank = await wallet(a.scope, { name: 'Bank', type: 'bank', openingBalanceMinor: 0 });
		const cases: [Uint8Array, string | null, string][] = [
			[fictionalCardPdf(), bank, 'needs_card_wallet'],
			[fictionalCardPdf(), null, 'needs_card_wallet'],
			[fictionalStatementPdf(), card, 'needs_bank_wallet']
		];
		for (const [bytes, walletId, error] of cases) {
			expect(
				await importStatement(db, a.scope, input(bytes, walletId), NOW, PARSERS)
			).toMatchObject({ ok: false, error });
			expect(
				await previewStatement(db, a.scope.spaceId, input(bytes, walletId), PARSERS)
			).toMatchObject({ ok: false, error });
		}
		// A manual pick of the card reader for a bank wallet: the same answer.
		expect(
			await importStatement(
				db,
				a.scope,
				input(fictionalCardPdf(), bank, { institution: 'fiktif-kartu' }),
				NOW,
				PARSERS
			)
		).toMatchObject({ ok: false, error: 'needs_card_wallet' });
		expect(await written(a.scope.spaceId)).toEqual({ transactions: 0, batches: 0, statements: 0 });
	});

	it('a USD card wallet: the IDR statement is refused (card statements are IDR only)', async () => {
		const a = await account();
		const usd = await wallet(a.scope, { currency: 'USD', openingBalanceMinor: 0 });
		expect(
			await importStatement(db, a.scope, input(fictionalCardPdf(), usd), NOW, PARSERS)
		).toMatchObject({
			ok: false,
			error: 'card_currency'
		});
	});

	it('another space\'s card wallet id is "not found" before the file is read', async () => {
		const a = await account();
		const b = await account();
		const theirs = await wallet(b.scope);
		expect(
			await importStatement(db, a.scope, input(fictionalCardPdf(), theirs), NOW, PARSERS)
		).toEqual({
			ok: false,
			error: 'wallet_not_found'
		});
		expect(await written(b.scope.spaceId)).toEqual({ transactions: 0, batches: 0, statements: 0 });
	});
});

describe('statement-level dedupe (AC 26, 39)', () => {
	it('a second PDF of the same statement (other bytes) and the very same file are both "already imported"; after undo it imports again', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const first = fictionalCardPdf();
		const second = fictionalCardPdf(fictionalCardPages({}, 3));
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
		await importStatement(db, a.scope, input(first, w), NOW, PARSERS);
		const before = await written(a.scope.spaceId);
		for (const bytes of [second, first])
			expect(await importStatement(db, a.scope, input(bytes, w), NOW, PARSERS)).toMatchObject({
				ok: false,
				error: 'card_already_imported'
			});
		expect(await written(a.scope.spaceId)).toEqual(before);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 1)).toBe('ok');
		expect(await count('card_statements', a.scope.spaceId)).toBe(0);
		// The undone statement's rows stay tombstoned (the same bytes never re-create them); another download imports.
		expect(await importStatement(db, a.scope, input(second, w), NOW + 2, PARSERS)).toMatchObject({
			ok: true,
			counts: { imported: 5 }
		});
		expect(await count('card_statements', a.scope.spaceId)).toBe(1);
	});

	it('20 concurrent imports of the same statement write one batch and one stored statement', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const files = Array.from({ length: 20 }, (_, i) =>
			fictionalCardPdf(fictionalCardPages({}, 1 + (i % 5)))
		);
		const results = await Promise.all(
			files.map((bytes) => importStatement(db, a.scope, input(bytes, w), NOW, PARSERS))
		);
		expect(results.filter((r) => r.ok && r.batchId !== null)).toHaveLength(1);
		expect(
			results.every((r) =>
				r.ok ? true : ['card_already_imported', 'busy', 'gone'].includes(r.error)
			)
		).toBe(true);
		expect(await count('card_statements', a.scope.spaceId)).toBe(1);
		expect(await count('import_batches', a.scope.spaceId)).toBe(1);
		expect(await count('transactions', a.scope.spaceId)).toBe(5);
	});
});

describe('card duplicate rule (AC 27)', () => {
	async function manual(scope: SpaceScope, walletId: string, on: string, amount = 80000050) {
		await ensurePresetCategories(db, scope.spaceId, NOW);
		const category = (await listCategories(db, scope.spaceId)).find((c) => c.kind === 'expense')!;
		const r = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor: amount,
				currency: 'IDR',
				walletId,
				transferToWalletId: null,
				categoryId: category.id,
				title: 'Belanja buku',
				note: null,
				occurredOn: on,
				occurredTime: '10:00'
			},
			NOW
		);
		if (!r.ok) throw new Error('row failed');
	}

	it('a same-amount row in the card 2 days away is "Mungkin duplikat"; 4 days away or in another wallet is not', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const other = await wallet(a.scope, { name: 'Bank', type: 'bank', openingBalanceMinor: 0 });
		await manual(a.scope, w, '2026-09-25');
		await manual(a.scope, w, '2026-10-01', 20500000);
		await manual(a.scope, other, '2026-09-27');
		const p = await previewStatement(db, a.scope.spaceId, input(fictionalCardPdf(), w), PARSERS);
		expect(p).toMatchObject({ ok: true, counts: { possibleDuplicates: 1 } });
		if (!p.ok) throw new Error('preview failed');
		expect(p.duplicates.map((d) => [d.date, d.amountMinor])).toEqual([['2026-09-27', 80000050]]);
		const r = await importStatement(db, a.scope, input(fictionalCardPdf(), w), NOW, PARSERS);
		expect(r).toMatchObject({ ok: true, counts: { imported: 4, skipped: 1 } });
	});
});

describe('continuity statement to statement (AC 28)', () => {
	const september = (next = '2.000.000,00') =>
		fictionalCardPages({
			statementDate: '25/09/2026',
			dueDate: '12/10/2026',
			period: '26/08/2026 - 25/09/2026',
			previous: '0,00',
			payments: '0,00',
			purchases: '2.000.000,00',
			fees: '0,00',
			interest: '0,00',
			next,
			minimum: null,
			rows: ['01/09 02/09 TOKO SEPTEMBER 2.000.000,00']
		});
	// October's statement holds a purchase dated in the previous cycle (24/09) posted on 27/09.
	const october = (previous: string) =>
		fictionalCardPages({
			previous,
			payments: '2.000.000,00',
			purchases: '1.250.000,50',
			rows: [
				'24/09 27/09 TOKO BUKU CONTOH 800.000,50',
				'30/09 01/10 PEMBAYARAN TERIMA KASIH 2.000.000,00 CR',
				'05/10 06/10 LANGGANAN FIKTIF ONLINE 205.000,00',
				'10/10 11/10 CICILAN TOKO ELEKTRONIK FIKTIF 245.000,00',
				'25/10 25/10 BIAYA TAHUNAN 75.000,00'
			],
			next: previous === '2.000.000,00' ? '1.325.000,50' : '1.325.000,51'
		});

	it("pass when the previous balance equals the earlier statement's new balance; the first makes no claim", async () => {
		const a = await account();
		const w = await wallet(a.scope, { openingBalanceMinor: 0 });
		const first = await importStatement(
			db,
			a.scope,
			input(fictionalCardPdf(september()), w),
			NOW,
			PARSERS
		);
		expect(first).toMatchObject({ ok: true, summary: { continuity: { status: 'none' } } });
		const second = await importStatement(
			db,
			a.scope,
			input(fictionalCardPdf(october('2.000.000,00')), w),
			NOW,
			PARSERS
		);
		expect(second).toMatchObject({
			ok: true,
			summary: { continuity: { status: 'pass', against: 'statement' } }
		});
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
	});

	it('a gap of one sen shows both figures and "Catat penyesuaian" closes it with one row', async () => {
		const a = await account();
		const w = await wallet(a.scope, { openingBalanceMinor: 0 });
		await importStatement(db, a.scope, input(fictionalCardPdf(september()), w), NOW, PARSERS);
		const second = await importStatement(
			db,
			a.scope,
			input(fictionalCardPdf(october('2.000.000,01')), w),
			NOW,
			PARSERS
		);
		expect(second).toMatchObject({
			ok: true,
			summary: {
				continuity: {
					status: 'gap',
					against: 'statement',
					openingMinor: -200000001,
					expectedMinor: -200000000,
					gapMinor: -1,
					periodFrom: '2026-09-26',
					adjustOn: '2026-09-25'
				}
			}
		});
		const [gap] = await continuityBreaks(db, a.scope.spaceId);
		expect(gap).toMatchObject({ status: 'gap', gapMinor: -1 });
		expect(await closeContinuityGap(db, a.scope, gap!.batchId, -1, NOW + 1)).toMatchObject({
			ok: true
		});
		expect(await continuityBreaks(db, a.scope.spaceId)).toEqual([]);
		const adjustments = await d1
			.prepare(
				`select occurred_on, amount_minor, adjustment_direction from transactions where space_id = ? and type = 'adjustment'`
			)
			.bind(a.scope.spaceId)
			.all();
		expect(adjustments.results).toEqual([
			{ occurred_on: '2026-09-25', amount_minor: 1, adjustment_direction: 'decrease' }
		]);
	});
});

describe('passwords (AC 30)', () => {
	it('no password: encrypted; wrong: wrong_password; right: reads; the password is stored nowhere', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const locked = fictionalCardPdf(fictionalCardPages(), { password: 'sandi-kartu-fiktif' });
		expect(await importStatement(db, a.scope, input(locked, w), NOW, PARSERS)).toMatchObject({
			ok: false,
			error: 'encrypted'
		});
		expect(
			await importStatement(db, a.scope, input(locked, w, { password: 'salah' }), NOW, PARSERS)
		).toMatchObject({
			ok: false,
			error: 'wrong_password'
		});
		expect(
			await importStatement(
				db,
				a.scope,
				input(locked, w, { password: 'sandi-kartu-fiktif' }),
				NOW,
				PARSERS
			)
		).toMatchObject({ ok: true, counts: { imported: 5 } });
		for (const table of ['transactions', 'import_batches', 'card_statements']) {
			const { results } = await d1
				.prepare(`select * from ${table} where space_id = ?`)
				.bind(a.scope.spaceId)
				.all();
			expect(JSON.stringify(results)).not.toContain('sandi-kartu-fiktif');
		}
	});
});

describe('undo and move (AC 31)', () => {
	it('undo tombstones the rows and the statement together; the card page stops showing it', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		await importStatement(db, a.scope, input(fictionalCardPdf(), w), NOW, PARSERS);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 1)).toBe('ok');
		expect(await count('transactions', a.scope.spaceId)).toBe(0);
		const { results } = await d1
			.prepare(
				'select statement_date, new_balance_minor, deleted_at from card_statements where space_id = ?'
			)
			.bind(a.scope.spaceId)
			.all();
		expect(results).toEqual([
			{ statement_date: null, new_balance_minor: null, deleted_at: NOW + 1 }
		]);
		const card = (await getWallet(db, a.scope.spaceId, w))!;
		const [s] = await cardSummaries(
			db,
			a.scope.spaceId,
			[{ ...card, balanceMinor: card.openingBalanceMinor }],
			'2026-10-26'
		);
		expect(s?.bill).toBeNull();
	});

	it('moves with its statement to another IDR card; refused to a bank wallet, another currency or another space', async () => {
		const a = await account();
		const b = await account();
		const from = await wallet(a.scope);
		const to = await wallet(a.scope, { name: 'Kartu Dua' });
		const bank = await wallet(a.scope, { name: 'Bank', type: 'bank', openingBalanceMinor: 0 });
		const usd = await wallet(a.scope, { name: 'USD', currency: 'USD', openingBalanceMinor: 0 });
		const theirs = await wallet(b.scope);
		await importStatement(db, a.scope, input(fictionalCardPdf(), from), NOW, PARSERS);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		const snapshot = async () => ({
			rows: (
				await d1
					.prepare('select wallet_id from transactions where space_id = ? order by id')
					.bind(a.scope.spaceId)
					.all()
			).results,
			statements: (
				await d1
					.prepare('select wallet_id from card_statements where space_id = ?')
					.bind(a.scope.spaceId)
					.all()
			).results
		});
		const before = await snapshot();
		for (const [target, reason] of [
			[bank, 'card_wallet_required'],
			[usd, 'currency_mismatch'],
			[theirs, 'wallet_not_found']
		] as const)
			expect(
				await moveImportBatch(db, a.scope, batch!.id, target, batch!.updatedAt, NOW + 1)
			).toEqual({
				ok: false,
				reason
			});
		expect(await snapshot()).toEqual(before);
		expect(
			await moveImportBatch(db, a.scope, batch!.id, to, batch!.updatedAt, NOW + 1)
		).toMatchObject({
			ok: true,
			moved: 5
		});
		expect((await snapshot()).statements).toEqual([{ wallet_id: to }]);
		// A card that already holds this statement date is refused (the moved rows look like duplicates: kept).
		await importStatement(
			db,
			a.scope,
			input(fictionalCardPdf(fictionalCardPages({}, 2)), from, { skipPossibleDuplicates: false }),
			NOW + 2,
			PARSERS
		);
		const batches = await listImportBatches(db, a.scope.spaceId);
		const newer = batches.find((x) => x.id !== batch!.id)!;
		expect(await moveImportBatch(db, a.scope, newer.id, to, newer.updatedAt, NOW + 3)).toEqual({
			ok: false,
			reason: 'card_statement_exists'
		});
	});
});

describe('pairing the bill payment after import (A5 with B7)', () => {
	it('a bank "kartu-kredit" debit pairs with the imported payment line', async () => {
		const a = await account();
		const card = await wallet(a.scope);
		const bank = await wallet(a.scope, { name: 'Bank', type: 'bank', openingBalanceMinor: 0 });
		await importStatement(db, a.scope, input(fictionalCardPdf(), card), NOW, PARSERS);
		await ensurePresetCategories(db, a.scope.spaceId, NOW);
		const kk = (await listCategories(db, a.scope.spaceId)).find(
			(c) => c.tileKey === 'kartu-kredit'
		)!;
		await createTransaction(
			db,
			a.scope,
			{
				type: 'expense',
				amountMinor: 200000000,
				currency: 'IDR',
				walletId: bank,
				transferToWalletId: null,
				categoryId: kk.id,
				title: 'KARTU KREDIT/PL FIKTIF',
				note: null,
				occurredOn: '2026-09-29',
				occurredTime: '09:00'
			},
			NOW
		);
		expect(await countTransferMatches(db, a.scope.spaceId)).toBe(1);
	});
});

describe('/impor with a card wallet (AC 34, 38)', () => {
	async function run(fn: () => unknown) {
		try {
			const value = await fn();
			if (isActionFailure(value))
				return {
					kind: 'fail' as const,
					status: value.status,
					data: value.data as unknown as Record<string, unknown>
				};
			return { kind: 'ok' as const, value: value as Record<string, unknown> };
		} catch (e) {
			if (isRedirect(e) || isHttpError(e)) return { kind: 'thrown' as const, status: e.status };
			throw e;
		}
	}
	async function uploadEvent(
		who: Awaited<ReturnType<typeof account>>,
		action: string,
		fields: Record<string, string | File>
	) {
		const current = await resolveCurrentSpace(db, who.user.id, undefined);
		const { event } = fakeEvent({
			url: `http://localhost/impor?/${action}`,
			routeId: '/(app)/impor',
			db,
			user: who.user,
			space: current
		});
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.append(k, v);
		const encoded = new Request('http://localhost/', { method: 'POST', body });
		(event as unknown as { request: Request }).request = new Request(
			`http://localhost/impor?/${action}`,
			{
				method: 'POST',
				headers: { 'content-type': encoded.headers.get('content-type')! },
				body: await encoded.arrayBuffer()
			}
		);
		return event as never;
	}
	type Action = (event: never) => unknown;
	const act = (name: string) => (impor.actions as Record<string, Action>)[name] as Action;

	it('the page lists every planned card issuer disabled and gives wallets their type', async () => {
		const a = await account();
		await wallet(a.scope);
		const page = await run(async () =>
			impor.load(
				fakeEvent({
					url: 'http://localhost/impor',
					routeId: '/(app)/impor',
					db,
					user: a.user,
					space: await resolveCurrentSpace(db, a.user.id, undefined)
				}).event as never
			)
		);
		expect(page).toMatchObject({
			kind: 'ok',
			value: {
				cardInstitutions: [],
				wallets: [expect.objectContaining({ type: 'kartu_kredit' })]
			}
		});
		const rows = (
			page as unknown as { value: { cardCatalogue: { id: string; supported: boolean }[] } }
		).value.cardCatalogue;
		expect(rows.map((r) => [r.id, r.supported])).toEqual([
			['bca-card', false],
			['mandiri-card', false],
			['bri-card', false],
			['bni-card', false],
			['cimb-card', false],
			['ocbc-card', false]
		]);
	});

	it('a card statement posted with a bank wallet answers the wallet-kind message (no-JS form post)', async () => {
		registry.push(FICTIONAL_BANK, FICTIONAL_CARD);
		const a = await account();
		const bank = await wallet(a.scope, { name: 'Bank', type: 'bank', openingBalanceMinor: 0 });
		const r = await run(async () =>
			act('importStatement')(
				await uploadEvent(a, 'importStatement', {
					file: new File([fictionalCardPdf() as BlobPart], 'tagihan.pdf', {
						type: 'application/pdf'
					}),
					defaultWalletId: bank
				})
			)
		);
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { section: 'statement', error: 'Ini tagihan kartu kredit; pilih dompet kartu kredit.' }
		});
	});

	it('a second import of a stored statement answers "Tagihan ini sudah diimpor"', async () => {
		registry.push(FICTIONAL_BANK, FICTIONAL_CARD);
		const a = await account();
		const card = await wallet(a.scope);
		const post = async () =>
			run(async () =>
				act('importStatement')(
					await uploadEvent(a, 'importStatement', {
						file: new File([fictionalCardPdf() as BlobPart], 'tagihan.pdf', {
							type: 'application/pdf'
						}),
						defaultWalletId: card
					})
				)
			);
		expect(await post()).toMatchObject({ kind: 'ok', value: { done: 'statementImported' } });
		expect(await post()).toMatchObject({
			kind: 'fail',
			data: { error: 'Tagihan ini sudah diimpor.' }
		});
	});
});

describe('red team L2: an account statement never moves into a card wallet', () => {
	it('a bank statement batch moved to a card is refused with its own reason; nothing changes', async () => {
		const a = await account();
		const bank = await wallet(a.scope, { name: 'Bank', type: 'bank', openingBalanceMinor: 0 });
		const card = await wallet(a.scope);
		const other = await wallet(a.scope, { name: 'Bank Dua', type: 'bank', openingBalanceMinor: 0 });
		expect(
			await importStatement(db, a.scope, input(fictionalStatementPdf(), bank), NOW, PARSERS)
		).toMatchObject({ ok: true });
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		const rows = async () =>
			(
				await d1
					.prepare('select wallet_id from transactions where space_id = ? order by id')
					.bind(a.scope.spaceId)
					.all()
			).results;
		const before = await rows();
		expect(await moveImportBatch(db, a.scope, batch!.id, card, batch!.updatedAt, NOW + 1)).toEqual({
			ok: false,
			reason: 'bank_statement_to_card'
		});
		expect(await rows()).toEqual(before);
		// Another non-card wallet is still fine.
		expect(
			await moveImportBatch(db, a.scope, batch!.id, other, batch!.updatedAt, NOW + 1)
		).toMatchObject({ ok: true });
	});
});

describe('red team L2 retype: a wallet with account statements never becomes a card', () => {
	it('the retype is refused while a bank statement batch is live; after its undo it goes through', async () => {
		const a = await account();
		const bank = await wallet(a.scope, { name: 'Bank', type: 'bank', openingBalanceMinor: 0 });
		expect(
			await importStatement(db, a.scope, input(fictionalStatementPdf(), bank), NOW, PARSERS)
		).toMatchObject({ ok: true });
		const asCard = async () => {
			const w = (await getWallet(db, a.scope.spaceId, bank))!;
			return updateWallet(
				db,
				a.scope,
				bank,
				{
					name: w.name,
					type: 'kartu_kredit',
					currency: 'IDR',
					openingBalanceMinor: 0,
					isFavourite: false,
					lastFour: null
				},
				w.updatedAt,
				NOW + 1
			);
		};
		expect(await asCard()).toBe('bank_statements_locked');
		expect((await getWallet(db, a.scope.spaceId, bank))?.type).toBe('bank');
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 2)).toBe('ok');
		expect(await asCard()).toBe('ok');
	});
});
