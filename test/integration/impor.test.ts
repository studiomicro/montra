import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { exportTransactionsCsv } from '#lib/server/imports/csv-export';
import { importCsv, previewCsv, type ImportCsvInput } from '#lib/server/imports/csv-import';
import { listImportBatches, undoImportBatch } from '#lib/server/imports/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { periodTotals } from '#lib/server/transactions/aggregate';
import { createTransaction } from '#lib/server/transactions/repo';
import { createWallet, listWallets } from '#lib/server/wallets/repo';
import { CSV_MAX_ROWS, parseCsv, readCsv, TEMPLATE_COLUMNS } from '#lib/shared/csv';
import { inspect } from 'node:util';
import { FORMULA_VECTORS, MASKING_VECTORS as M } from '../fixtures/export-vectors';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const impor = await import('../../src/routes/(app)/impor/+page.server');
const ekspor = await import('../../src/routes/(app)/impor/ekspor/+server');
const hooks = await import('../../src/hooks.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = 1_800_000_000_000;
const YEAR = { type: null, categoryId: null, walletId: null, q: null } as const;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function account() {
	const email = `impor${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	return { user: { id: r.userId, email, name: 'Uji', createdAt: 0 }, scope };
}
type Account = Awaited<ReturnType<typeof account>>;

async function wallet(scope: SpaceScope, name: string, currency: 'IDR' | 'USD' = 'IDR') {
	const r = await createWallet(
		db,
		scope,
		{ name, type: 'bank', currency, openingBalanceMinor: 0, isFavourite: false, lastFour: null },
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

const HEADER = TEMPLATE_COLUMNS.join(',');
type Row = Partial<Record<(typeof TEMPLATE_COLUMNS)[number], string>>;
const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const line = (r: Row) => TEMPLATE_COLUMNS.map((c) => quote(r[c] ?? '')).join(',');
const templateFile = (rows: Row[]) => [HEADER, ...rows.map(line)].join('\n') + '\n';

const input = (fileText: string, over: Partial<ImportCsvInput> = {}): ImportCsvInput => ({
	fileText,
	filename: 'uji.csv',
	format: null,
	defaultWalletId: null,
	skipPossibleDuplicates: false,
	...over
});

async function liveRows(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select t.id, t.type, t.amount_minor, t.title, t.occurred_on, t.source, t.import_batch_id,
				t.payment_method, t.recurrence, t.tag, t.reference, t.note, c.name as category, w.name as wallet
			from transactions t left join categories c on c.id = t.category_id
			left join wallets w on w.id = t.wallet_id
			where t.space_id = ? and t.deleted_at is null order by t.occurred_on, t.title`
		)
		.bind(spaceId)
		.all<Record<string, string | number | null>>();
	return results;
}

/** Every cell of an exported file (header included), read by the shared RFC 4180 reader. */
function exportedCells(csv: string): string[] {
	const parsed = parseCsv(csv);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.rows.flat();
}

/** Logged arguments as the console prints them (message, cause and stack included). */
const printed = (calls: unknown[][]) =>
	calls
		.flat()
		.map((x) => inspect(x, { depth: 5 }))
		.join('\n');

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	// Keep the BOM (Response.text() would drop it): the test checks the exact bytes.
	return new TextDecoder('utf-8', { ignoreBOM: true }).decode(
		await new Response(stream).arrayBuffer()
	);
}

describe('importCsv (template)', () => {
	it('creates missing categories and wallets, writes source csv with the batch id and extras', async () => {
		const a = await account();
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'Kopi Kenangan',
				amount: 'Rp 28.000,00',
				category: 'Ngopi',
				payment_method: 'QRIS',
				recurrence: 'harian',
				tag: 'pagi',
				notes: 'oat milk',
				wallet_source: 'Dompet Kantor',
				reference: 'INV-1'
			},
			{
				date: '02/10/2026',
				type: 'pemasukan',
				merchant: 'Kantor',
				amount: '1.250.000',
				payment_method: 'BCA'
			}
		]);
		const r = await importCsv(db, a.scope, input(file), NOW);
		expect(r).toMatchObject({
			ok: true,
			counts: { rows: 2, imported: 2, skipped: 0, already: 0, foreignCurrency: 0 }
		});
		const batchId = r.ok ? r.batchId : null;
		expect(batchId).toBeTruthy();
		const rows = await liveRows(a.scope.spaceId);
		expect(rows).toEqual([
			expect.objectContaining({
				type: 'expense',
				amount_minor: 2_800_000,
				title: 'Kopi Kenangan',
				occurred_on: '2026-10-01',
				source: 'csv',
				import_batch_id: batchId,
				payment_method: 'QRIS',
				recurrence: 'harian',
				tag: 'pagi',
				reference: 'INV-1',
				note: 'oat milk',
				category: 'Ngopi',
				wallet: 'Dompet Kantor'
			}),
			expect.objectContaining({
				type: 'income',
				amount_minor: 125_000_000,
				occurred_on: '2026-10-02',
				// Empty wallet_source falls back to payment_method; no category falls back to the income preset.
				wallet: 'BCA',
				category: 'Pemasukan Lain'
			})
		]);
		const cats = await listCategories(db, a.scope.spaceId);
		expect(cats.find((c) => c.name === 'Ngopi')).toMatchObject({
			kind: 'expense',
			tileKey: 'lain'
		});
		const wallets = await listWallets(db, a.scope.spaceId);
		expect(wallets.map((w) => [w.name, w.type, w.currency]).sort()).toEqual([
			['BCA', 'lainnya', 'IDR'],
			['Dompet Kantor', 'lainnya', 'IDR']
		]);
		expect(wallets.filter((w) => w.isFavourite)).toHaveLength(1);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(batch).toMatchObject({
			id: batchId,
			format: 'template',
			filename: 'uji.csv',
			rowCount: 2,
			importedCount: 2,
			skippedCount: 0,
			alreadyImportedCount: 0,
			undoneAt: null
		});
	});

	it('matches existing wallets and categories by name, case-insensitively, without duplicating them', async () => {
		const a = await account();
		const bca = await wallet(a.scope, 'BCA');
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'A',
				amount: '1000',
				category: 'kopi',
				wallet_source: 'bca'
			},
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'B',
				amount: '2000',
				category: 'KOPI',
				wallet_source: 'Bca'
			}
		]);
		expect((await importCsv(db, a.scope, input(file), NOW)).ok).toBe(true);
		const rows = await liveRows(a.scope.spaceId);
		expect(rows.map((r) => [r.wallet, r.category])).toEqual([
			['BCA', 'Kopi'],
			['BCA', 'Kopi']
		]);
		expect((await listWallets(db, a.scope.spaceId)).map((w) => w.id)).toEqual([bca]);
		expect(
			(await listCategories(db, a.scope.spaceId)).filter((c) => /kopi/i.test(c.name))
		).toHaveLength(1);
	});

	it('re-importing the same file creates nothing and reports every row as already imported', async () => {
		const a = await account();
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'A',
				amount: '1000',
				wallet_source: 'Tunai'
			},
			{ date: '2026-10-02', type: 'expense', merchant: 'B', amount: '2000', wallet_source: 'Tunai' }
		]);
		await importCsv(db, a.scope, input(file), NOW);
		const again = await importCsv(db, a.scope, input(file), NOW + 1);
		expect(again).toEqual({
			ok: true,
			batchId: null,
			counts: expect.objectContaining({ imported: 0, already: 2, skipped: 0 })
		});
		expect(await liveRows(a.scope.spaceId)).toHaveLength(2);
		expect(await listImportBatches(db, a.scope.spaceId)).toHaveLength(1);
	});

	it('saves every valid row and counts the bad ones, never guessing an amount or date', async () => {
		const a = await account();
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'Ok',
				amount: '1000',
				wallet_source: 'Tunai'
			},
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'Bad amount',
				amount: 'seribu-an',
				wallet_source: 'Tunai'
			},
			{
				date: 'besok',
				type: 'expense',
				merchant: 'Bad date',
				amount: '1000',
				wallet_source: 'Tunai'
			},
			{
				date: '2026-10-01',
				type: 'transfer',
				merchant: 'Pindah',
				amount: '1000',
				wallet_source: 'Tunai'
			},
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'Too big',
				amount: '100.000.000.001',
				wallet_source: 'Tunai'
			},
			{ date: '2026-10-01', type: 'expense', merchant: 'No wallet', amount: '1000' }
		]);
		const r = await importCsv(db, a.scope, input(file), NOW);
		expect(r).toMatchObject({ ok: true, counts: { rows: 6, imported: 1, skipped: 5 } });
		expect((await liveRows(a.scope.spaceId)).map((x) => x.title)).toEqual(['Ok']);
	});

	it('uses the chosen wallet for rows that name none; another space’s wallet id is refused', async () => {
		const a = await account();
		const b = await account();
		const mine = await wallet(a.scope, 'Utama');
		const theirs = await wallet(b.scope, 'Rahasia');
		const file = templateFile([
			{ date: '2026-10-01', type: 'expense', merchant: 'X', amount: '1000' }
		]);
		expect(await importCsv(db, a.scope, input(file, { defaultWalletId: theirs }), NOW)).toEqual({
			ok: false,
			error: 'wallet_not_found'
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await liveRows(b.scope.spaceId)).toEqual([]);
		const r = await importCsv(db, a.scope, input(file, { defaultWalletId: mine }), NOW);
		expect(r).toMatchObject({ ok: true, counts: { imported: 1 } });
		expect((await liveRows(a.scope.spaceId))[0]).toMatchObject({ wallet: 'Utama' });
	});

	it('flags rows matching an existing transaction as possible duplicates and can leave them out', async () => {
		const a = await account();
		await ensurePresetCategories(db, a.scope.spaceId, NOW);
		const w = await wallet(a.scope, 'Tunai');
		const cats = await listCategories(db, a.scope.spaceId);
		await createTransaction(
			db,
			a.scope,
			{
				type: 'expense',
				amountMinor: 2_800_000,
				currency: 'IDR',
				walletId: w,
				transferToWalletId: null,
				categoryId: cats.find((c) => c.kind === 'expense')!.id,
				title: 'Kopi Kenangan',
				note: null,
				occurredOn: '2026-10-01',
				occurredTime: null
			},
			NOW
		);
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'kopi kenangan',
				amount: '28000',
				wallet_source: 'Tunai'
			},
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'Roti',
				amount: '28000',
				wallet_source: 'Tunai'
			}
		]);
		const preview = await previewCsv(db, a.scope.spaceId, { fileText: file, format: null });
		expect(preview).toMatchObject({
			ok: true,
			format: 'template',
			counts: { imported: 2, possibleDuplicates: 1 },
			duplicates: [{ line: 1, date: '2026-10-01', title: 'kopi kenangan', amountMinor: 2_800_000 }]
		});
		expect(await liveRows(a.scope.spaceId)).toHaveLength(1);
		const r = await importCsv(db, a.scope, input(file, { skipPossibleDuplicates: true }), NOW);
		expect(r).toMatchObject({
			ok: true,
			counts: { imported: 1, skipped: 1, possibleDuplicates: 1 }
		});
		expect((await liveRows(a.scope.spaceId)).map((x) => x.title).sort()).toEqual([
			'Kopi Kenangan',
			'Roti'
		]);
	});

	it('processes at most CSV_MAX_ROWS rows and reports the rest; totals equal the file exactly', async () => {
		const a = await account();
		const extra = 3;
		const rows: Row[] = [];
		let expectedOut = 0n;
		let expectedIn = 0n;
		for (let i = 0; i < CSV_MAX_ROWS + extra; i++) {
			const day = String((i % 28) + 1).padStart(2, '0');
			const income = i % 7 === 0;
			const rupiah = 1000 + ((i * 7919) % 900_000);
			if (i < CSV_MAX_ROWS) {
				if (income) expectedIn += BigInt(rupiah) * 100n;
				else expectedOut += BigInt(rupiah) * 100n;
			}
			rows.push({
				date: `2026-${String((i % 12) + 1).padStart(2, '0')}-${day}`,
				type: income ? 'income' : 'expense',
				merchant: `Toko ${i}`,
				amount: rupiah.toLocaleString('id-ID'),
				category: `Kat ${i % 5}`,
				wallet_source: `Dompet ${i % 3}`
			});
		}
		const r = await importCsv(db, a.scope, input(templateFile(rows)), NOW);
		expect(r).toMatchObject({
			ok: true,
			counts: { rows: CSV_MAX_ROWS, imported: CSV_MAX_ROWS, notProcessed: extra }
		});
		const totals = await periodTotals(db, a.scope.spaceId, {
			...YEAR,
			from: '2026-01-01',
			to: '2026-12-31'
		});
		expect(totals.count).toBe(CSV_MAX_ROWS);
		expect(totals.totals).toEqual([
			{ currency: 'IDR', inMinor: Number(expectedIn), outMinor: Number(expectedOut) }
		]);
	}, 120_000);

	it('20 concurrent imports of the same file create each row exactly once, never an error', async () => {
		const a = await account();
		const file = templateFile(
			Array.from({ length: 30 }, (_, i) => ({
				date: '2026-10-05',
				type: 'expense',
				merchant: `Item ${i}`,
				amount: String(1000 + i),
				wallet_source: 'Tunai',
				category: 'Belanja'
			}))
		);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => importCsv(db, a.scope, input(file), NOW))
		);
		expect(results.every((r) => r.ok)).toBe(true);
		const imported = results.reduce((s, r) => s + (r.ok ? r.counts.imported : 0), 0);
		expect(imported).toBe(30);
		expect(await liveRows(a.scope.spaceId)).toHaveLength(30);
		expect((await listWallets(db, a.scope.spaceId)).filter((w) => w.name === 'Tunai')).toHaveLength(
			1
		);
		expect(
			(await listCategories(db, a.scope.spaceId)).filter((c) => c.name === 'Belanja')
		).toHaveLength(1);
	}, 120_000);

	it('a removed member’s import writes nothing (the membership is re-checked inside the batch)', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await wallet({ spaceId, userId: owner.user.id }, 'Tunai');
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'X',
				amount: '1000',
				// A preset category and an existing wallet: the write itself must refuse.
				category: 'Kopi',
				wallet_source: 'Tunai'
			},
			{ date: '2026-10-01', type: 'expense', merchant: 'Y', amount: '1000', wallet_source: 'Baru' }
		]);
		const r = await importCsv(db, { spaceId, userId: member.user.id }, input(file), NOW);
		expect(r).toEqual({ ok: false, error: 'gone' });
		expect(await liveRows(spaceId)).toEqual([]);
		expect(await listImportBatches(db, spaceId)).toEqual([]);
		expect((await listWallets(db, spaceId)).map((w) => w.name)).toEqual(['Tunai']);
	});
});

describe('importCsv: FN-39 ride-hailing and food-delivery guess', () => {
	it('a blank category cell goes to the preset the description names, else to "Lainnya"', async () => {
		const a = await account();
		// A space seeded before FN-39 (and FN-48): the later presets come with the import's own preset check.
		await ensurePresetCategories(db, a.scope.spaceId, NOW);
		await d1
			.prepare(
				`delete from categories where space_id = ? and tile_key in ('ojek-online', 'pesan-antar-makanan',
					'biaya-bank', 'pajak', 'tarik-tunai', 'kartu-kredit', 'transfer', 'bunga')`
			)
			.bind(a.scope.spaceId)
			.run();
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'GRABFOOD JKT',
				amount: '45.000',
				wallet_source: 'BCA'
			},
			{
				date: '2026-10-02',
				type: 'expense',
				merchant: 'GOJEK*JAKARTA',
				amount: '15.000',
				wallet_source: 'BCA'
			},
			{
				date: '2026-10-03',
				type: 'expense',
				merchant: 'Toko Buku',
				amount: '60.000',
				wallet_source: 'BCA'
			},
			{
				date: '2026-10-04',
				type: 'expense',
				merchant: 'GrabFood',
				amount: '30.000',
				category: 'Kantor',
				wallet_source: 'BCA'
			},
			{
				date: '2026-10-05',
				type: 'income',
				merchant: 'Refund Gojek',
				amount: '15.000',
				wallet_source: 'BCA'
			}
		]);
		const r = await importCsv(db, a.scope, input(file), NOW);
		expect(r).toMatchObject({ ok: true, counts: { imported: 5, skipped: 0 } });
		const rows = await liveRows(a.scope.spaceId);
		expect(rows.map((x) => [x.title, x.category])).toEqual([
			['GRABFOOD JKT', 'Pesan Antar Makanan'],
			['GOJEK*JAKARTA', 'Ojek Online'],
			['Toko Buku', 'Lainnya'],
			['GrabFood', 'Kantor'],
			['Refund Gojek', 'Pemasukan Lain']
		]);
		// The guessed rows point at the space's presets, never at new categories of the same name.
		const cats = await listCategories(db, a.scope.spaceId, { includeHidden: true });
		for (const name of ['Ojek Online', 'Pesan Antar Makanan'])
			expect(cats.filter((c) => c.name === name)).toEqual([
				expect.objectContaining({ isPreset: true, kind: 'expense' })
			]);
	});
});

describe('importCsv (Money Manager)', () => {
	it('skips non-IDR rows apart from the other skips; IDR rows still import', async () => {
		const a = await account();
		const file = [
			'Period,Accounts,Category,Subcategory,Note,Income/Expense,Amount,Currency',
			'2026-10-01 08:00:00,Cash,Food/Groceries,,Pasar,Exp.,45000,IDR',
			'2026-10-01 09:00:00,Wise,Travel,,Hotel,Expense,120.50,USD',
			'2026-10-02 10:00:00,Cash,Transfer,,Ke BCA,Transfer-Out,5000,IDR',
			'2026-10-03 10:00:00,BCA,Salary,,Gaji,Income,"10,000,000.00",IDR'
		].join('\r\n');
		const r = await importCsv(db, a.scope, input(file), NOW);
		expect(r).toMatchObject({
			ok: true,
			counts: { rows: 4, imported: 2, skipped: 1, foreignCurrency: 1 }
		});
		const rows = await liveRows(a.scope.spaceId);
		expect(rows.map((x) => [x.title, x.category, x.wallet, x.amount_minor])).toEqual([
			['Pasar', 'Food', 'Cash', 4_500_000],
			['Gaji', 'Salary', 'BCA', 1_000_000_000]
		]);
		expect((await listImportBatches(db, a.scope.spaceId))[0]).toMatchObject({
			format: 'money_manager',
			skippedCount: 2
		});
	});

	it('an unknown header needs a format; a manual override that does not fit is refused', async () => {
		const a = await account();
		const file = 'Tanggal,Jumlah\n2026-10-01,5000\n';
		expect(await importCsv(db, a.scope, input(file), NOW)).toEqual({
			ok: false,
			error: 'format_unknown'
		});
		expect(await importCsv(db, a.scope, input(file, { format: 'template' }), NOW)).toEqual({
			ok: false,
			error: 'format_mismatch'
		});
	});
});

describe('undoImportBatch', () => {
	it('tombstones every row of the batch content-free and sets undone_at; a second undo is a no-op', async () => {
		const a = await account();
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'A',
				amount: '1000',
				wallet_source: 'Tunai',
				tag: 't'
			},
			{ date: '2026-10-02', type: 'income', merchant: 'B', amount: '5000', wallet_source: 'Tunai' }
		]);
		const r = await importCsv(db, a.scope, input(file), NOW);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt - 1, NOW + 5)).toBe(
			'stale'
		);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 10)).toBe('ok');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		const totals = await periodTotals(db, a.scope.spaceId, {
			...YEAR,
			from: '2026-10-01',
			to: '2026-10-31'
		});
		expect(totals).toMatchObject({ count: 0, totals: [] });
		const tomb = await d1
			.prepare(
				`select amount_minor, title, tag, payment_method, wallet_id, dedupe_key, import_batch_id
				from transactions where space_id = ?`
			)
			.bind(a.scope.spaceId)
			.all();
		expect(tomb.results).toHaveLength(2);
		for (const t of tomb.results)
			expect(t).toMatchObject({
				amount_minor: null,
				title: null,
				tag: null,
				payment_method: null,
				wallet_id: null,
				import_batch_id: r.ok ? r.batchId : 'x'
			});
		const [after] = await listImportBatches(db, a.scope.spaceId);
		expect(after!.undoneAt).toBe(NOW + 10);
		// Replay of the same (now stale) form, and a fresh one: nothing happens, no error.
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 20)).toBe(
			'already'
		);
		expect(await undoImportBatch(db, a.scope, after!.id, after!.updatedAt, NOW + 20)).toBe(
			'already'
		);
		// The same file is never recreated after an undo (deleted captures stay deleted).
		expect(await importCsv(db, a.scope, input(file), NOW + 30)).toMatchObject({
			ok: true,
			counts: { imported: 0, already: 2 }
		});
	});

	it('another space’s batch id reads as missing and changes nothing', async () => {
		const a = await account();
		const b = await account();
		const file = templateFile([
			{ date: '2026-10-01', type: 'expense', merchant: 'A', amount: '1000', wallet_source: 'Tunai' }
		]);
		await importCsv(db, a.scope, input(file), NOW);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, b.scope, batch!.id, batch!.updatedAt, NOW + 1)).toBe(
			'missing'
		);
		expect(await liveRows(a.scope.spaceId)).toHaveLength(1);
		expect(await listImportBatches(db, b.scope.spaceId)).toEqual([]);
	});
});

describe('exportTransactionsCsv', () => {
	it('neutralises formula cells, leaves out transfers and demo rows, and round-trips into an empty space', async () => {
		const a = await account();
		// Import keeps every one of these as typed (tab and CR starts are covered below: cleaning removes them).
		const vectors = FORMULA_VECTORS;
		const file =
			HEADER +
			'\n' +
			vectors
				.map((v, i) =>
					TEMPLATE_COLUMNS.map((c) =>
						c === 'date'
							? `2026-10-0${i + 1}`
							: c === 'type'
								? i % 2
									? 'income'
									: 'expense'
								: c === 'merchant' || c === 'notes' || c === 'tag' || c === 'reference'
									? `"${v.replaceAll('"', '""')}"`
									: c === 'amount'
										? `${1000 * (i + 1)}`
										: c === 'wallet_source'
											? 'Tunai'
											: c === 'category'
												? 'Lain-lain'
												: ''
					).join(',')
				)
				.join('\n');
		const imported = await importCsv(db, a.scope, input(file), NOW);
		expect(imported).toMatchObject({ ok: true, counts: { imported: 6 } });
		// A transfer and a demo row in range never leave the space through export.
		const [tunai] = await listWallets(db, a.scope.spaceId);
		const other = await wallet(a.scope, 'Lain');
		await createTransaction(
			db,
			a.scope,
			{
				type: 'transfer',
				amountMinor: 500,
				currency: 'IDR',
				walletId: tunai!.id,
				transferToWalletId: other,
				categoryId: null,
				title: 'Pindah',
				note: null,
				occurredOn: '2026-10-03',
				occurredTime: null
			},
			NOW
		);
		await d1
			.prepare(
				`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					title, occurred_on, occurred_at, source, is_demo, created_at, updated_at, seq)
				select 'demo-1', space_id, type, amount_minor, currency, category_id, wallet_id, 'Demo',
					occurred_on, occurred_at, 'manual', 1, created_at, updated_at, seq
				from transactions where space_id = ? and type = 'expense' limit 1`
			)
			.bind(a.scope.spaceId)
			.run();

		const csv = await readStream(exportTransactionsCsv(db, a.scope, '2026-10-01', '2026-10-31'));
		expect(csv.startsWith('\uFEFF' + HEADER + '\r\n')).toBe(true);
		expect(csv).not.toContain('Pindah');
		expect(csv).not.toContain('Demo');
		const parsed = readCsv(csv);
		expect(parsed.ok).toBe(true);
		const records = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean).slice(1);
		expect(records).toHaveLength(6);
		const cells = exportedCells(csv);
		for (const v of vectors.slice(0, 4)) {
			// Each of the four text cells (title, tag, notes, reference) carries the guard.
			expect(cells.filter((c) => c === `'${v}`)).toHaveLength(4);
		}
		expect(cells.filter((c) => /^[=+\-@\t\r]/.test(c))).toEqual([]);

		// Round trip: the export imported into an empty space gives the same amounts, dates, types and titles.
		const b = await account();
		const again = await importCsv(db, b.scope, input(csv), NOW);
		expect(again).toMatchObject({ ok: true, counts: { imported: 6, skipped: 0 } });
		const pick = (rows: Awaited<ReturnType<typeof liveRows>>) =>
			rows
				.map((r) => [r.type, r.amount_minor, r.occurred_on, r.title, r.note, r.tag, r.reference])
				.sort();
		const original = (await liveRows(a.scope.spaceId)).filter(
			(r) => r.type !== 'transfer' && r.title !== 'Demo'
		);
		expect(pick(await liveRows(b.scope.spaceId))).toEqual(pick(original));

		// A title or note starting with a tab or CR (any other write path) is guarded too.
		await d1
			.prepare(
				`update transactions set title = char(9) || 'Tab', note = char(13) || 'CR'
				where space_id = ? and occurred_on = '2026-10-01'`
			)
			.bind(a.scope.spaceId)
			.run();
		const guardedCells = exportedCells(
			await readStream(exportTransactionsCsv(db, a.scope, '2026-10-01', '2026-10-01'))
		);
		expect(guardedCells).toContain("'\tTab");
		expect(guardedCells).toContain("'\rCR");
		expect(guardedCells.filter((c) => /^[=+\-@\t\r]/.test(c))).toEqual([]);
	});

	it('streams more than one page in newest-first order', async () => {
		const a = await account();
		const rows: Row[] = Array.from({ length: 1205 }, (_, i) => ({
			date: `2026-0${(i % 9) + 1}-15`,
			type: 'expense',
			merchant: `T${i}`,
			amount: String(1000 + i),
			wallet_source: 'Tunai'
		}));
		await importCsv(db, a.scope, input(templateFile(rows)), NOW);
		const csv = await readStream(exportTransactionsCsv(db, a.scope, '2026-01-01', '2026-12-31'));
		const records = csv.split('\r\n').filter(Boolean).slice(1);
		expect(records).toHaveLength(1205);
		const dates = records.map((r) => r.slice(0, 10));
		expect([...dates].sort().reverse()).toEqual(dates);
		expect(new Set(records).size).toBe(1205);
	}, 60_000);
});

// ---- Routes: /impor actions and /impor/ekspor -------------------------------------------------

type Handler = (event: never) => unknown;

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
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

async function uploadEvent(
	who: Account,
	action: string,
	fields: Record<string, string | File>,
	space?: string
) {
	const current = await resolveCurrentSpace(db, who.user.id, space);
	const { event } = fakeEvent({
		url: `http://localhost/impor?/${action}`,
		routeId: '/(app)/impor',
		db,
		user: who.user,
		space: current
	});
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	// Serialised up front (a plain byte body, like a browser upload) rather than undici's lazy FormData stream.
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

const csvFile = (text: string, name = 'uji.csv') => new File([text], name, { type: 'text/csv' });
const act = (name: string) => (impor.actions as Record<string, Handler>)[name]!;

describe('/impor routes', () => {
	it('import and preview read the file in memory and answer with server counts', async () => {
		const a = await account();
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'A',
				amount: '1000',
				wallet_source: 'Tunai'
			},
			{
				date: '2026-10-01',
				type: 'transfer',
				merchant: 'B',
				amount: '1000',
				wallet_source: 'Tunai'
			}
		]);
		const preview = await run(async () =>
			act('preview')(await uploadEvent(a, 'preview', { file: csvFile(file), format: '' }))
		);
		expect(preview).toMatchObject({
			kind: 'ok',
			value: { done: 'previewed', format: 'template', counts: { imported: 1, skipped: 1 } }
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		const done = await run(async () =>
			act('import')(
				await uploadEvent(a, 'import', {
					file: csvFile(file),
					format: '',
					skipPossibleDuplicates: 'on'
				})
			)
		);
		expect(done).toMatchObject({
			kind: 'ok',
			value: { done: 'imported', counts: { imported: 1, skipped: 1 } }
		});
		const load = await run(async () =>
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
		expect(load).toMatchObject({ kind: 'ok', value: { loadError: null } });
		const batches = (load as unknown as { value: { batches: { id: string; updatedAt: number }[] } })
			.value.batches;
		expect(batches).toHaveLength(1);
		const { event: undoEv } = fakeEvent({
			url: 'http://localhost/impor?/undo',
			routeId: '/(app)/impor',
			db,
			user: a.user,
			space: await resolveCurrentSpace(db, a.user.id, undefined),
			form: { id: batches[0]!.id, updatedAt: String(batches[0]!.updatedAt) }
		});
		expect(await run(() => act('undo')(undoEv as never))).toMatchObject({
			kind: 'ok',
			value: { done: 'undone' }
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	});

	it('refuses a missing, empty, non-UTF-8, malformed or unknown-format file with a clear message, never a 500', async () => {
		const a = await account();
		const cases: [Record<string, string | File>, string][] = [
			[{ format: '' }, 'Pilih berkas CSV dulu.'],
			[{ file: csvFile(''), format: '' }, 'Berkas CSV kosong.'],
			[
				{ file: new File([new Uint8Array([0x61, 0xff, 0xfe, 0x0a])], 'x.csv'), format: '' },
				'Berkas tidak bisa dibaca sebagai teks UTF-8. Simpan ulang sebagai CSV UTF-8.'
			],
			[
				{ file: csvFile('date,type,merchant,amount\n"2026-10-01,expense\n'), format: '' },
				'Berkas CSV rusak: ada tanda kutip yang tidak ditutup.'
			],
			[{ file: csvFile('a,b\n1,2\n'), format: '' }, 'Format tidak terdeteksi, pilih manual'],
			[{ file: csvFile('a,b\n1,2\n'), format: 'excel' }, 'Pilih format dari daftar.']
		];
		for (const [fields, error] of cases) {
			const r = await run(async () => act('import')(await uploadEvent(a, 'import', fields)));
			expect(r).toMatchObject({ kind: 'fail', status: 400, data: { error } });
		}
	});

	it('refuses an oversized body with 400 and a non-form body with 415', async () => {
		const a = await account();
		const big = csvFile('x'.repeat(5 * 1024 * 1024 + 70 * 1024));
		expect(
			await run(async () => act('import')(await uploadEvent(a, 'import', { file: big })))
		).toMatchObject({
			kind: 'error',
			status: 400
		});
		const { event } = fakeEvent({
			url: 'http://localhost/impor?/import',
			routeId: '/(app)/impor',
			db,
			user: a.user,
			space: await resolveCurrentSpace(db, a.user.id, undefined),
			headers: { 'content-type': 'text/plain' }
		});
		(event as unknown as { request: Request }).request = new Request(
			'http://localhost/impor?/import',
			{
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'date,type'
			}
		);
		expect(await run(() => act('import')(event as never))).toMatchObject({
			kind: 'error',
			status: 415
		});
	});

	it('cross-space: another space’s wallet id and batch id get the uniform not-found answers', async () => {
		const a = await account();
		const b = await account();
		const theirs = await wallet(b.scope, 'Rahasia');
		await importCsv(
			db,
			b.scope,
			input(
				templateFile([
					{ date: '2026-10-01', type: 'expense', merchant: 'S', amount: '9', wallet_source: 'X' }
				])
			),
			NOW
		);
		const [batch] = await listImportBatches(db, b.scope.spaceId);
		const file = templateFile([
			{ date: '2026-10-01', type: 'expense', merchant: 'A', amount: '1000' }
		]);
		expect(
			await run(async () =>
				act('import')(
					await uploadEvent(a, 'import', { file: csvFile(file), defaultWalletId: theirs })
				)
			)
		).toMatchObject({ kind: 'fail', status: 404, data: { error: 'Dompet tidak ditemukan.' } });
		const { event } = fakeEvent({
			url: 'http://localhost/impor?/undo',
			routeId: '/(app)/impor',
			db,
			user: a.user,
			space: await resolveCurrentSpace(db, a.user.id, undefined),
			form: { id: batch!.id, updatedAt: String(batch!.updatedAt) }
		});
		expect(await run(() => act('undo')(event as never))).toMatchObject({
			kind: 'fail',
			status: 404,
			data: { error: 'Impor tidak ditemukan.' }
		});
		expect(await liveRows(b.scope.spaceId)).toHaveLength(1);
		// Export of a's space never contains b's rows.
		const res = (await ekspor.GET(
			fakeEvent({
				url: 'http://localhost/impor/ekspor?from=2026-10-01&to=2026-10-31',
				routeId: '/(app)/impor/ekspor',
				db,
				user: a.user,
				space: await resolveCurrentSpace(db, a.user.id, b.scope.spaceId)
			}).event as never
		)) as Response;
		expect(await res.text()).not.toContain('S,');
	});

	it('export: CSV attachment for a valid range; a missing range or a range over a year goes back with a message', async () => {
		const a = await account();
		const get = async (query: string) =>
			run(async () =>
				ekspor.GET(
					fakeEvent({
						url: `http://localhost/impor/ekspor${query}`,
						routeId: '/(app)/impor/ekspor',
						db,
						user: a.user,
						space: await resolveCurrentSpace(db, a.user.id, undefined)
					}).event as never
				)
			);
		const ok = await get('?from=2026-10-01&to=2026-10-31');
		const res = (ok as { value: unknown }).value as Response;
		expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(res.headers.get('content-disposition')).toBe(
			'attachment; filename="montra-2026-10-01-2026-10-31.csv"'
		);
		expect(await readStream(res.body!)).toBe('\uFEFF' + HEADER + '\r\n');
		for (const bad of ['', '?from=2026-10-01', '?from=2026-10-31&to=2026-10-01', '?from=x&to=y'])
			expect(await get(bad)).toEqual({
				kind: 'redirect',
				status: 303,
				location: '/impor?ekspor=salah#ekspor'
			});
		expect(await get('?from=2025-01-01&to=2026-12-31')).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/impor?ekspor=dipotong&from=2025-01-01&to=2026-01-01#ekspor'
		});
	});

	it('signed out: the export answers a redirect to sign in, never data', async () => {
		const r = await run(() =>
			ekspor.GET(
				fakeEvent({
					url: 'http://localhost/impor/ekspor?from=2026-10-01&to=2026-10-31',
					routeId: '/(app)/impor/ekspor',
					db
				}).event as never
			)
		);
		expect(r).toMatchObject({ kind: 'redirect', status: 303, location: '/masuk' });
	});
});

// ---- Cycle 2: red team L1–L6 ---------------------------------------------------------------------------

describe('cycle 2 (red team L1–L6)', () => {
	it('L1: account and card numbers are cut to the last 4 digits before storage and in the export', async () => {
		const a = await account();
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'Transfer',
				amount: '1000',
				payment_method: M.paymentMethod.input,
				wallet_source: M.walletName.input,
				reference: M.reference.input
			}
		]);
		const r = await run(async () =>
			act('import')(
				await uploadEvent(a, 'import', { file: csvFile(file, 'mutasi 9876543210.csv'), format: '' })
			)
		);
		expect(r).toMatchObject({ kind: 'ok', value: { done: 'imported' } });
		const [row] = await liveRows(a.scope.spaceId);
		expect(row).toMatchObject({
			reference: M.reference.masked,
			payment_method: M.paymentMethod.masked,
			wallet: M.walletName.masked
		});
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(batch!.filename).toBe('mutasi \u2022\u2022\u2022\u20223210.csv');
		const csv = await readStream(exportTransactionsCsv(db, a.scope, '2026-10-01', '2026-10-01'));
		for (const full of [M.reference.input, '0123456789', '4111 1111 1111 1234', '9876543210'])
			expect(csv).not.toContain(full);
		expect(csv).toContain(M.reference.masked);
		// A value stored by any other path is masked on the way out too.
		await d1
			.prepare('update transactions set reference = ? where space_id = ?')
			.bind(M.storedReference.input, a.scope.spaceId)
			.run();
		const again = await readStream(exportTransactionsCsv(db, a.scope, '2026-10-01', '2026-10-01'));
		expect(again).not.toContain('8808123456789012');
		expect(again).toContain(M.storedReference.masked);
	});

	it('L2: a D1 failure during preview or import logs no row data and answers 503', async () => {
		const a = await account();
		const secret = 'Rahasia Kopi Rp 28.000 2026-10-01';
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'Rahasia Kopi',
				amount: '28000',
				wallet_source: 'Tunai'
			}
		]);
		const failing = new Proxy(db, {
			get(target, prop) {
				if (prop === 'batch' || prop === 'all')
					return () =>
						Promise.reject(
							Object.assign(new Error(`Failed query: insert … params: ${secret}`), {
								cause: Object.assign(new Error(`D1_ERROR: ${secret}`), { code: 'SQLITE_BUSY' })
							})
						);
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			for (const name of ['import', 'preview']) {
				const event = await uploadEvent(a, name, { file: csvFile(file), format: '' });
				(event as unknown as { locals: { db: Db } }).locals.db = failing as Db;
				const r = await run(() => act(name)(event));
				expect(r).toMatchObject({
					kind: 'fail',
					status: 503,
					data: {
						error: 'Impor gagal karena gangguan server. Tidak ada yang tersimpan. Coba lagi.'
					}
				});
			}
			const logged = printed(spy.mock.calls);
			expect(spy).toHaveBeenCalled();
			expect(logged).not.toContain('Rahasia');
			expect(logged).not.toContain('28000');
			expect(logged).not.toContain('2026-10-01');
			expect(logged).toContain('SQLITE_BUSY');
			// The app-wide hook logs unexpected errors the same way.
			spy.mockClear();
			await hooks.handleError({
				kind: 'unknown',
				error: new Error(`Failed query: select … params: ${secret}`),
				event: { route: { id: '/(app)/impor' } }
			} as never);
			expect(printed(spy.mock.calls)).not.toContain('Rahasia');
			expect(printed(spy.mock.calls)).toContain('/(app)/impor');
			spy.mockClear();
			await hooks.handleError({
				kind: 'app',
				error: new Error('x'),
				event: { route: { id: '/' } }
			} as never);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	});

	it('L3: wallets and categories are created only for rows that are written', async () => {
		const a = await account();
		await wallet(a.scope, 'Wise', 'USD');
		// The 15 presets are the space's defaults (seeded by any category screen), not something the import adds.
		await ensurePresetCategories(db, a.scope.spaceId, NOW);
		const before = {
			wallets: (await listWallets(db, a.scope.spaceId, { includeArchived: true })).length,
			categories: (await listCategories(db, a.scope.spaceId, { includeHidden: true })).length
		};
		// Every row names the USD wallet: the validator refuses all of them (currency), so nothing is created.
		const refused = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'A',
				amount: '1000',
				category: 'Baru Satu',
				wallet_source: 'Wise'
			},
			{
				date: '2026-10-01',
				type: 'income',
				merchant: 'B',
				amount: '1000',
				category: 'Baru Dua',
				wallet_source: 'wise'
			}
		]);
		expect(await importCsv(db, a.scope, input(refused), NOW)).toMatchObject({
			ok: true,
			batchId: null,
			counts: { imported: 0, skipped: 2 }
		});
		expect((await listWallets(db, a.scope.spaceId, { includeArchived: true })).length).toBe(
			before.wallets
		);
		expect((await listCategories(db, a.scope.spaceId, { includeHidden: true })).length).toBe(
			before.categories
		);
		// A mixed file: only the written row's new wallet and category appear.
		const mixed = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'A',
				amount: '1000',
				category: 'Pakai',
				wallet_source: 'Dompet Baru'
			},
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'B',
				amount: '1000',
				category: 'Tidak Dipakai',
				wallet_source: 'Wise'
			},
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'C',
				// Parses, but the validator refuses it (over the 10^13 cap).
				amount: '100.000.000.001',
				category: 'Juga Tidak',
				wallet_source: 'Dompet Lain'
			}
		]);
		expect(await importCsv(db, a.scope, input(mixed), NOW)).toMatchObject({
			ok: true,
			counts: { imported: 1, skipped: 2 }
		});
		const names = (await listWallets(db, a.scope.spaceId)).map((w) => w.name).sort();
		expect(names).toEqual(['Dompet Baru', 'Wise']);
		const cats = (await listCategories(db, a.scope.spaceId, { includeHidden: true })).map(
			(c) => c.name
		);
		expect(cats).toContain('Pakai');
		expect(cats).not.toContain('Tidak Dipakai');
		expect(cats).not.toContain('Juga Tidak');
		expect(cats).not.toContain('Baru Satu');
	});

	it('L3: a refused batch (removed member) leaves no wallet or category behind', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		await ensurePresetCategories(db, spaceId, NOW);
		const cats = (await listCategories(db, spaceId, { includeHidden: true })).length;
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const file = templateFile([
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'X',
				amount: '1000',
				category: 'Baru',
				wallet_source: 'Baru'
			}
		]);
		expect(await importCsv(db, { spaceId, userId: member.user.id }, input(file), NOW)).toEqual({
			ok: false,
			error: 'gone'
		});
		expect(await listWallets(db, spaceId, { includeArchived: true })).toEqual([]);
		expect((await listCategories(db, spaceId, { includeHidden: true })).length).toBe(cats);
	});

	it('L5: an export stops at the next page once the member is removed', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const memberScope = { spaceId, userId: member.user.id };
		const rows: Row[] = Array.from({ length: 1500 }, (_, i) => ({
			date: '2026-10-10',
			type: 'expense',
			merchant: `T${i}`,
			amount: String(1000 + i),
			wallet_source: 'Tunai'
		}));
		expect(await importCsv(db, memberScope, input(templateFile(rows)), NOW)).toMatchObject({
			ok: true,
			counts: { imported: 1500 }
		});
		const reader = exportTransactionsCsv(db, memberScope, '2026-10-01', '2026-10-31').getReader();
		const decoder = new TextDecoder();
		let text = '';
		for (let i = 0; i < 2; i++) text += decoder.decode((await reader.read()).value);
		expect(text.split('\r\n').filter(Boolean)).toHaveLength(1 + 1000);
		const m = (await listMembers(db, spaceId, owner.user.id)).find((x) => !x.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: m.id }, NOW);
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			text += decoder.decode(next.value);
		}
		expect(text.split('\r\n').filter(Boolean)).toHaveLength(1 + 1000);
		// The owner still gets all of it.
		const full = await readStream(
			exportTransactionsCsv(db, { spaceId, userId: owner.user.id }, '2026-10-01', '2026-10-31')
		);
		expect(full.split('\r\n').filter(Boolean)).toHaveLength(1 + 1500);
	});

	it('L6: blank lines never count toward the 5,000-row cap or "not processed"', async () => {
		const a = await account();
		const file =
			HEADER +
			'\n' +
			'\n'.repeat(CSV_MAX_ROWS + 10) +
			line({
				date: '2026-10-01',
				type: 'expense',
				merchant: 'A',
				amount: '1000',
				wallet_source: 'Tunai'
			}) +
			'\n\n,,,\n' +
			line({
				date: '2026-10-02',
				type: 'expense',
				merchant: 'B',
				amount: '2000',
				wallet_source: 'Tunai'
			}) +
			'\n';
		expect(await importCsv(db, a.scope, input(file), NOW)).toMatchObject({
			ok: true,
			counts: { rows: 2, imported: 2, notProcessed: 0 }
		});
	});
});
