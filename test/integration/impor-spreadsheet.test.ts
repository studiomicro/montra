import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinThrottleWindow } from '../helpers/clock';
import { saveKey } from '#lib/server/ai-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { overUserAttemptLimit, THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import {
	ensurePresetCategories,
	listCategories,
	setCategoryHidden
} from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { listImportBatches, undoImportBatch } from '#lib/server/imports/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { importSheet, previewSheet, type SheetLayout } from '#lib/server/spreadsheet/import';
import { reserveSheetRead } from '#lib/server/spreadsheet/validation';
import { STATEMENT_UPLOADS_PER_WINDOW } from '#lib/server/statements/validation';
import { periodTotals } from '#lib/server/transactions/aggregate';
import { TRANSACTION_CREATES_MAX } from '#lib/server/transactions/create-limit';
import { sha256Hex } from '#lib/server/util';
import { archiveWallet, createWallet, getWallet, listWallets } from '#lib/server/wallets/repo';
import { base64urlEncode } from '#lib/shared/base64url';
import type { SheetMapping } from '#lib/shared/spreadsheet/types';
import {
	budgetOnlyXlsx,
	generateRows,
	longTableXlsx,
	monthTabsXlsx,
	sums,
	unlabeledXlsx
} from '../fixtures/spreadsheets';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { messagesResponse } from '../helpers/receipts';
import { buildXlsx } from '../helpers/xlsx';

// FN-17: the spreadsheet import against a local D1. The AI suggestion is stubbed (no test reaches a provider).
const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const { fakeFetch } = vi.hoisted(() => ({
	fakeFetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
}));
vi.mock('#lib/server/spreadsheet/ai-mapping', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/spreadsheet/ai-mapping')>();
	return {
		...actual,
		suggestTabMapping: (...args: Parameters<typeof actual.suggestTabMapping>) =>
			actual.suggestTabMapping(
				args[0],
				args[1],
				args[2],
				args[3],
				fakeFetch as unknown as typeof fetch
			)
	};
});

const impor = await import('../../src/routes/(app)/impor/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.now();
const YEAR = {
	type: null,
	categoryId: null,
	walletId: null,
	q: null,
	from: '2026-01-01',
	to: '2026-12-31'
} as const;
const ENC = base64urlEncode(new Uint8Array(32).fill(17));

function configure(o: { gateway?: boolean } = {}) {
	for (const k of Object.keys(binding)) delete binding[k];
	binding.DB = d1;
	binding.AI_KEYS_ENCRYPTION_KEY = ENC;
	if (o.gateway !== false) {
		binding.AI_GATEWAY_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
		binding.AI_GATEWAY_ID = 'montra-test';
	}
}

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	configure();
});
afterAll(() => dispose());
beforeEach(() => {
	configure();
	fakeFetch.mockReset();
	fakeFetch.mockImplementation(async () => {
		throw new Error('no provider in tests');
	});
});

let n = 0;
async function account() {
	const email = `sheet${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	await ensurePresetCategories(db, space.id);
	return { user: { id: r.userId, email, name: 'Uji', createdAt: 0 }, scope };
}
type Account = Awaited<ReturnType<typeof account>>;

async function wallet(scope: SpaceScope, name = 'Kas Fiktif') {
	const r = await createWallet(
		db,
		scope,
		{
			name,
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

/** The mapping exactly as the section's form posts it back (every offered tab, its roles and choices). */
function mappingOf(layout: SheetLayout, over: (m: SheetMapping) => void = () => {}): SheetMapping {
	const m: SheetMapping = {
		fillDown: layout.fillDown,
		tabs: layout.tabs
			.filter((t) => t.status !== 'skipped')
			.map((t) => ({
				tab: t.tab,
				use: true,
				headerRow: t.headerRow,
				columns: t.columns.map((c) => c.role),
				kind: t.kind,
				month: t.month
			}))
	};
	over(m);
	return m;
}

function fieldsOf(m: SheetMapping): Record<string, string> {
	const f: Record<string, string> = {};
	if (m.fillDown) f.fillDown = 'on';
	for (const t of m.tabs) {
		if (t.use) f[`tab.${t.tab}.use`] = 'on';
		f[`tab.${t.tab}.header`] = String(t.headerRow);
		f[`tab.${t.tab}.kind`] = t.kind;
		f[`tab.${t.tab}.month`] = t.month ?? '';
		t.columns.forEach((c, i) => (f[`tab.${t.tab}.col.${i}`] = c));
	}
	return f;
}

async function liveRows(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select type, amount_minor, category_id, wallet_id, source, dedupe_key from transactions
			where space_id = ? and deleted_at is null`
		)
		.bind(spaceId)
		.all<Record<string, string | number | null>>();
	return results;
}

async function counts(spaceId: string) {
	const one = async (table: string) =>
		(await d1
			.prepare(`select count(*) as n from ${table} where space_id = ?`)
			.bind(spaceId)
			.first<{ n: number }>())!.n;
	return { wallets: await one('wallets'), categories: await one('categories') };
}

type Handler = (event: never) => unknown;
const act = (name: string) => (impor.actions as Record<string, Handler>)[name]!;

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
	space?: string,
	dbOverride?: Db
) {
	const current = await resolveCurrentSpace(db, who.user.id, space);
	const { event } = fakeEvent({
		url: `http://localhost/impor?/${action}`,
		routeId: '/(app)/impor',
		db: dbOverride ?? db,
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

const xlsx = (bytes: Uint8Array, name = 'keuangan 1234567890123.xlsx') =>
	new File([bytes as BlobPart], name, {
		type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	});

const ROWS = generateRows(3000);
const EXPECTED = sums(ROWS);

describe('AC 17: 3,000 generated rows, totals identical to the file', () => {
	for (const [label, build] of [
		['one long table', longTableXlsx],
		['one tab per month', monthTabsXlsx]
	] as const)
		it(`${label}: preview, import and Riwayat totals equal the generator's own sums`, async () => {
			const a = await account();
			const w = await wallet(a.scope);
			const bytes = build(ROWS);
			const before = await counts(a.scope.spaceId);
			const read = await previewSheet(db, a.scope.spaceId, { bytes, mapping: null });
			if (!read.ok) throw new Error(read.error);
			expect(read.review).toBeNull();
			expect(read.layout.tabs.every((t) => t.status === 'ready')).toBe(true);
			const mapping = mappingOf(read.layout);
			const review = await previewSheet(db, a.scope.spaceId, { bytes, mapping });
			if (!review.ok || !review.review) throw new Error('no review');
			expect(review.review.fileTotals).toEqual(EXPECTED);
			expect(review.review.counts).toMatchObject({ imported: 3000, already: 0, notProcessed: 0 });
			const result = await importSheet(
				db,
				a.scope,
				{ bytes, filename: 'keuangan.xlsx', mapping, walletId: w, skipPossibleDuplicates: false },
				NOW
			);
			expect(result).toMatchObject({ ok: true, counts: { imported: 3000, already: 0 } });
			const totals = await periodTotals(db, a.scope.spaceId, YEAR);
			expect(totals.count).toBe(3000);
			expect(totals.totals).toEqual([
				{ currency: 'IDR', inMinor: EXPECTED.incomeMinor, outMinor: EXPECTED.expenseMinor }
			]);
			const rows = await liveRows(a.scope.spaceId);
			expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['spreadsheet']));
			expect(new Set(rows.map((r) => r.wallet_id))).toEqual(new Set([w]));
			expect(rows.every((r) => String(r.dedupe_key).startsWith('spreadsheet:'))).toBe(true);
			// AC 14: nothing created; unmatched categories ("Jajan Fiktif", "Usaha Fiktif") are "Tanpa kategori".
			expect(await counts(a.scope.spaceId)).toEqual(before);
			const unmatched = ROWS.filter((r) => r.category.endsWith('Fiktif')).length;
			expect(rows.filter((r) => r.category_id === null)).toHaveLength(unmatched);
			const [batch] = await listImportBatches(db, a.scope.spaceId);
			expect(batch).toMatchObject({ source: 'spreadsheet', format: null, importedCount: 3000 });
		}, 180_000);

	it('the AI step stubbed to fail or to answer an odd mapping changes no total', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		await saveKey(
			db,
			a.user.id,
			'anthropic',
			'sk-ant-api03-synthetic-0001-AbCdEfGh',
			binding as never,
			NOW
		);
		const bytes = unlabeledXlsx(ROWS);
		fakeFetch.mockImplementation(async () =>
			messagesResponse(
				JSON.stringify({
					header_row: 0,
					kind: 'both',
					columns: [
						{ index: 0, role: 'amount' },
						{ index: 2, role: 'date' }
					]
				})
			)
		);
		const suggested = await run(async () =>
			act('suggestMapping')(
				await uploadEvent(a, 'suggestMapping', { file: xlsx(bytes), aiTab: '0' })
			)
		);
		// An odd but schema-valid mapping only pre-fills: no review, no write.
		expect(suggested).toMatchObject({
			kind: 'ok',
			value: { sheet: { review: null, aiError: null } }
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		// The import recomputes from the file and the user's confirmed mapping only.
		const read = await previewSheet(db, a.scope.spaceId, { bytes, mapping: null });
		if (!read.ok) throw new Error(read.error);
		const result = await importSheet(
			db,
			a.scope,
			{
				bytes,
				filename: null,
				mapping: mappingOf(read.layout),
				walletId: w,
				skipPossibleDuplicates: false
			},
			NOW
		);
		expect(result).toMatchObject({ ok: true, counts: { imported: 3000 } });
		const totals = await periodTotals(db, a.scope.spaceId, YEAR);
		expect(totals.totals).toEqual([
			{ currency: 'IDR', inMinor: EXPECTED.incomeMinor, outMinor: EXPECTED.expenseMinor }
		]);
	}, 180_000);
});

const small = () =>
	buildXlsx([
		{
			name: 'Pengeluaran',
			rows: [
				['Tanggal', 'Keterangan', 'Kategori', 'Jumlah'],
				['2026-10-01', 'Kopi fiktif', 'Makan & Minum', 28000],
				['2026-10-02', 'Parkir fiktif', 'Transportasi', 5000],
				['2026-10-03', 'Hiburan fiktif', 'Hiburan', 75000]
			]
		}
	]);

describe('/impor spreadsheet actions', () => {
	it('read → mapping → review → import → already → undo; nothing recreated by the same file', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const bytes = small();
		const read = await run(async () =>
			act('previewSheet')(
				await uploadEvent(a, 'previewSheet', { file: xlsx(bytes), step: 'read', walletId: w })
			)
		);
		expect(read).toMatchObject({
			kind: 'ok',
			value: {
				section: 'spreadsheet',
				sheet: { step: 'read', review: null, filename: 'keuangan ••••0123.xlsx' }
			}
		});
		const layout = (read as unknown as { value: { sheet: { layout: SheetLayout } } }).value.sheet
			.layout;
		const fields = fieldsOf(mappingOf(layout));
		const review = await run(async () =>
			act('previewSheet')(
				await uploadEvent(a, 'previewSheet', {
					file: xlsx(bytes),
					step: 'apply',
					walletId: w,
					...fields
				})
			)
		);
		expect(review).toMatchObject({
			kind: 'ok',
			value: {
				sheet: {
					step: 'reviewed',
					review: {
						counts: { rows: 3, imported: 3, already: 0 },
						categories: [
							{ name: 'Makan & Minum', target: 'Makan & Minum' },
							{ name: 'Transportasi', target: 'Transportasi' },
							{ name: 'Hiburan', target: 'Hiburan' }
						]
					}
				}
			}
		});
		const imported = await run(async () =>
			act('importSheet')(
				await uploadEvent(a, 'importSheet', { file: xlsx(bytes), walletId: w, ...fields })
			)
		);
		expect(imported).toMatchObject({
			kind: 'ok',
			value: { sheet: { step: 'imported', counts: { imported: 3 } } }
		});
		const again = await run(async () =>
			act('importSheet')(
				await uploadEvent(a, 'importSheet', { file: xlsx(bytes), walletId: w, ...fields })
			)
		);
		expect(again).toMatchObject({
			kind: 'ok',
			value: { sheet: { counts: { imported: 0, already: 3 } } }
		});
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 1)).toBe('ok');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		const after = await importSheet(
			db,
			a.scope,
			{
				bytes,
				filename: null,
				mapping: mappingOf(layout),
				walletId: w,
				skipPossibleDuplicates: false
			},
			NOW
		);
		expect(after).toMatchObject({ ok: true, batchId: null, counts: { imported: 0, already: 3 } });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 120_000);

	it('a hidden category is never a target: the row is "Tanpa kategori"', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const hiburan = (await listCategories(db, a.scope.spaceId)).find((c) => c.name === 'Hiburan')!;
		expect(await setCategoryHidden(db, a.scope, hiburan.id, true, NOW)).toBe('ok');
		const bytes = small();
		const read = await previewSheet(db, a.scope.spaceId, { bytes, mapping: null });
		if (!read.ok) throw new Error(read.error);
		const review = await previewSheet(db, a.scope.spaceId, {
			bytes,
			mapping: mappingOf(read.layout)
		});
		expect(review).toMatchObject({
			ok: true,
			review: {
				categories: expect.arrayContaining([
					{ name: 'Hiburan', kind: 'expense', target: null, rows: 1 }
				])
			}
		});
		await importSheet(
			db,
			a.scope,
			{
				bytes,
				filename: null,
				mapping: mappingOf(read.layout),
				walletId: w,
				skipPossibleDuplicates: false
			},
			NOW
		);
		const rows = await liveRows(a.scope.spaceId);
		expect(rows.filter((r) => r.category_id === null)).toHaveLength(1);
		expect(rows.some((r) => r.category_id === hiburan.id)).toBe(false);
	});

	it('20 concurrent imports of the same file end with one set of rows', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const bytes = small();
		const read = await previewSheet(db, a.scope.spaceId, { bytes, mapping: null });
		if (!read.ok) throw new Error(read.error);
		const mapping = mappingOf(read.layout);
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				importSheet(
					db,
					a.scope,
					{ bytes, filename: null, mapping, walletId: w, skipPossibleDuplicates: false },
					NOW
				)
			)
		);
		expect(results.reduce((s, r) => s + (r.ok ? r.counts.imported : 0), 0)).toBe(3);
		expect(await liveRows(a.scope.spaceId)).toHaveLength(3);
	}, 120_000);

	it('wallet: another space’s or an archived wallet is "not found"; one is required', async () => {
		const a = await account();
		const b = await account();
		const theirs = await wallet(b.scope);
		const mine = await wallet(a.scope, 'Lama');
		const w = (await getWallet(db, a.scope.spaceId, mine))!;
		expect(await archiveWallet(db, a.scope, mine, w.updatedAt, NOW)).toBe('ok');
		const bytes = small();
		const read = await previewSheet(db, a.scope.spaceId, { bytes, mapping: null });
		if (!read.ok) throw new Error(read.error);
		const fields = fieldsOf(mappingOf(read.layout));
		for (const id of [theirs, mine, 'tidak-ada'])
			expect(
				await run(async () =>
					act('importSheet')(
						await uploadEvent(a, 'importSheet', { file: xlsx(bytes), walletId: id, ...fields })
					)
				)
			).toEqual({
				kind: 'fail',
				status: 404,
				data: { section: 'spreadsheet', sheetError: 'Dompet tidak ditemukan.' }
			});
		expect(
			await run(async () =>
				act('importSheet')(await uploadEvent(a, 'importSheet', { file: xlsx(bytes), ...fields }))
			)
		).toEqual({
			kind: 'fail',
			status: 400,
			data: { section: 'spreadsheet', sheetError: 'Pilih dompet untuk impor ini.' }
		});
		expect(await liveRows(b.scope.spaceId)).toEqual([]);
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	});

	it('cross-space: a non-member is answered in their own space; a removed member writes nothing', async () => {
		const a = await account();
		const b = await account();
		const bytes = small();
		const mine = await wallet(a.scope);
		const read = await previewSheet(db, a.scope.spaceId, { bytes, mapping: null });
		if (!read.ok) throw new Error(read.error);
		const fields = fieldsOf(mappingOf(read.layout));
		const r = await run(async () =>
			act('importSheet')(
				await uploadEvent(
					a,
					'importSheet',
					{ file: xlsx(bytes), walletId: mine, ...fields },
					b.scope.spaceId
				)
			)
		);
		expect(r).toMatchObject({ kind: 'ok' });
		expect(await liveRows(b.scope.spaceId)).toEqual([]);

		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const shared = await wallet({ spaceId, userId: owner.user.id });
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		expect(
			await run(async () =>
				act('importSheet')(
					await uploadEvent(
						member,
						'importSheet',
						{ file: xlsx(bytes), walletId: shared, ...fields },
						spaceId
					)
				)
			)
		).toMatchObject({ kind: 'fail', status: 404 });
		const direct = await importSheet(
			db,
			{ spaceId, userId: member.user.id },
			{
				bytes,
				filename: null,
				mapping: mappingOf(read.layout),
				walletId: shared,
				skipPossibleDuplicates: false
			},
			NOW
		);
		expect(direct.ok).toBe(false);
		expect(await liveRows(spaceId)).toEqual([]);
		expect(await listImportBatches(db, spaceId)).toEqual([]);
	});

	it('refusals: CSV here, macros, legacy .xls, not a workbook, budget-only, tampered mapping', async () => {
		const a = await account();
		const cases: [Record<string, string | File>, string][] = [
			[
				{ file: new File(['tanggal,jumlah'], 'mutasi.csv') },
				'Ini berkas CSV. Impor lewat bagian Impor mutasi (CSV) atau Impor mutasi (PDF/CSV).'
			],
			[
				{ file: xlsx(small(), 'makro.xlsm') },
				'Berkas berisi makro (.xlsm) tidak dibaca. Simpan ulang sebagai .xlsx tanpa makro atau CSV.'
			],
			[
				{ file: xlsx(small(), 'lama.xls') },
				'Format .xls, .xlsb, .ods dan .numbers belum didukung. Simpan ulang sebagai .xlsx atau CSV.'
			],
			[
				{ file: xlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])) },
				'Format .xls, .xlsb, .ods dan .numbers belum didukung. Simpan ulang sebagai .xlsx atau CSV.'
			],
			[
				{ file: xlsx(new TextEncoder().encode('bukan zip')) },
				'Berkas ini bukan spreadsheet .xlsx yang bisa dibaca.'
			],
			[
				{ file: xlsx(budgetOnlyXlsx()) },
				'Berkas ini tampak seperti anggaran atau daftar aset, bukan catatan transaksi.'
			],
			[
				{ file: xlsx(small()), step: 'apply', 'tab.0.use': 'on', 'tab.0.col.0': 'formula' },
				'Pemetaan kolom tidak valid. Baca berkas lagi lalu pilih ulang.'
			],
			[
				{ file: xlsx(small()), step: 'apply', 'tab.9.use': 'on', 'tab.9.col.0': 'date' },
				'Pemetaan kolom tidak valid. Baca berkas lagi lalu pilih ulang.'
			],
			[{}, 'Pilih berkas .xlsx dulu.']
		];
		for (const [fields, message] of cases)
			expect(
				await run(async () => act('previewSheet')(await uploadEvent(a, 'previewSheet', fields)))
			).toEqual({
				kind: 'fail',
				status: 400,
				data: { section: 'spreadsheet', sheetError: message }
			});
	});

	it(`throttles: past ${STATEMENT_UPLOADS_PER_WINDOW} uploads a user gets 429 before the body is read; 503 + Retry-After in the lane`, async () => {
		const a = await account();
		const now = pinThrottleWindow();
		await d1
			.prepare(
				`insert into auth_attempts (client_hash, window_start, count) values (?, ?, ?)
				on conflict (client_hash) do update set window_start = excluded.window_start, count = excluded.count`
			)
			.bind(
				await sha256Hex(`spreadsheet-upload:user:${a.user.id}`),
				now - (now % THROTTLE_WINDOW_MS),
				STATEMENT_UPLOADS_PER_WINDOW
			)
			.run();
		for (const action of ['previewSheet', 'suggestMapping', 'importSheet']) {
			const event = (await uploadEvent(a, action, { file: xlsx(small()) })) as unknown as {
				request: Request;
			};
			expect(await run(() => act(action)(event as never))).toEqual({
				kind: 'fail',
				status: 429,
				data: {
					section: 'spreadsheet',
					sheetError: 'Terlalu banyak unggahan spreadsheet. Coba lagi dalam beberapa menit.'
				}
			});
			expect(event.request.bodyUsed).toBe(false);
		}
		const b = await account();
		const held = reserveSheetRead(b.user.id)!;
		try {
			const event = (await uploadEvent(b, 'previewSheet', { file: xlsx(small()) })) as unknown as {
				request: Request;
				setHeaders: (h: Record<string, string>) => void;
			};
			const headers: Record<string, string> = {};
			event.setHeaders = (h) => Object.assign(headers, h);
			expect(await run(() => act('previewSheet')(event as never))).toMatchObject({
				kind: 'fail',
				status: 503
			});
			expect(headers['retry-after']).toBe('30');
			expect(event.request.bodyUsed).toBe(false);
		} finally {
			held();
		}
	});

	it('probe: 20 concurrent upload counts at the limit — the cap holds exactly', async () => {
		const a = await account();
		const results = await Promise.all(
			Array.from({ length: STATEMENT_UPLOADS_PER_WINDOW + 20 }, () =>
				overUserAttemptLimit(db, a.user.id, NOW, 'spreadsheet-upload', STATEMENT_UPLOADS_PER_WINDOW)
			)
		);
		expect(results.filter((over) => !over)).toHaveLength(STATEMENT_UPLOADS_PER_WINDOW);
	});

	it('an import counts as one creating action: 429 at the per-user limit, nothing written', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const now = pinThrottleWindow();
		await d1
			.prepare(
				`insert into auth_attempts (client_hash, window_start, count) values (?, ?, ?)
				on conflict (client_hash) do update set window_start = excluded.window_start, count = excluded.count`
			)
			.bind(
				await sha256Hex(`transaction-create:user:${a.user.id}`),
				now - (now % THROTTLE_WINDOW_MS),
				TRANSACTION_CREATES_MAX
			)
			.run();
		const read = await previewSheet(db, a.scope.spaceId, { bytes: small(), mapping: null });
		if (!read.ok) throw new Error(read.error);
		expect(
			await run(async () =>
				act('importSheet')(
					await uploadEvent(a, 'importSheet', {
						file: xlsx(small()),
						walletId: w,
						...fieldsOf(mappingOf(read.layout))
					})
				)
			)
		).toMatchObject({ kind: 'fail', status: 429 });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	});

	it('a D1 failure answers 503 content-free and logs a fixed line, never a cell', async () => {
		const a = await account();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const failing = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'all')
					return async () => {
						throw new Error('Kopi fiktif 28000 Makan & Minum');
					};
				return Reflect.get(target, prop, receiver);
			}
		});
		const read = await previewSheet(db, a.scope.spaceId, { bytes: small(), mapping: null });
		if (!read.ok) throw new Error(read.error);
		const r = await run(async () =>
			act('previewSheet')(
				await uploadEvent(
					a,
					'previewSheet',
					{ file: xlsx(small()), step: 'apply', ...fieldsOf(mappingOf(read.layout)) },
					undefined,
					failing
				)
			)
		);
		expect(r).toMatchObject({ kind: 'fail', status: 503 });
		expect(inspect(log.mock.calls)).not.toMatch(/Kopi|28000|Makan/);
		log.mockRestore();
	});
});

describe('AI mapping suggestion through the action (stubbed provider)', () => {
	it('gateway not configured: "Belum dikonfigurasi"; no key: the key hint; the layout and manual picker stay', async () => {
		const a = await account();
		const bytes = unlabeledXlsx(ROWS.slice(0, 20));
		configure({ gateway: false });
		expect(
			await run(async () =>
				act('suggestMapping')(
					await uploadEvent(a, 'suggestMapping', { file: xlsx(bytes), aiTab: '0' })
				)
			)
		).toMatchObject({
			kind: 'ok',
			value: {
				sheet: {
					aiError: 'Belum dikonfigurasi',
					ai: { configured: false },
					layout: { unmapped: [0] }
				}
			}
		});
		configure();
		expect(
			await run(async () =>
				act('suggestMapping')(
					await uploadEvent(a, 'suggestMapping', { file: xlsx(bytes), aiTab: '0' })
				)
			)
		).toMatchObject({
			kind: 'ok',
			value: {
				sheet: {
					aiError: 'Tambahkan kunci Anthropic di Pengaturan › Integrasi AI',
					ai: { hasKey: false }
				}
			}
		});
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('L4: the reader slot is free during the provider call, and free again after it', async () => {
		const a = await account();
		const key = 'sk-ant-api03-synthetic-0003-AbCdEfGh';
		await saveKey(db, a.user.id, 'anthropic', key, binding as never, NOW);
		const bytes = unlabeledXlsx(ROWS.slice(0, 20));
		let duringCall: (() => void) | null | undefined;
		fakeFetch.mockImplementationOnce(async () => {
			// The same user (and so any other) can take a slot while the provider is still answering.
			duringCall = reserveSheetRead(a.user.id);
			duringCall?.();
			return messagesResponse('bukan json');
		});
		const r = await run(async () =>
			act('suggestMapping')(
				await uploadEvent(a, 'suggestMapping', { file: xlsx(bytes), aiTab: '0' })
			)
		);
		expect(r).toMatchObject({ kind: 'ok', value: { sheet: { aiTab: 0 } } });
		expect(fakeFetch).toHaveBeenCalledTimes(1);
		expect(duringCall).not.toBeNull();
		// Released on exit too: a new read takes the slot.
		const after = reserveSheetRead(a.user.id);
		expect(after).not.toBeNull();
		after!();
	});

	it('invalid output keeps the picker with the error; a valid one only pre-fills; the key never shows', async () => {
		const a = await account();
		const key = 'sk-ant-api03-synthetic-0002-AbCdEfGh';
		await saveKey(db, a.user.id, 'anthropic', key, binding as never, NOW);
		const bytes = unlabeledXlsx(ROWS.slice(0, 20));
		for (const bad of [
			'bukan json',
			JSON.stringify({ header_row: 0, kind: 'both', columns: [{ index: 9, role: 'date' }] })
		]) {
			fakeFetch.mockImplementationOnce(async () => messagesResponse(bad));
			const r = await run(async () =>
				act('suggestMapping')(
					await uploadEvent(a, 'suggestMapping', { file: xlsx(bytes), aiTab: '0' })
				)
			);
			expect(r).toMatchObject({
				kind: 'ok',
				value: {
					sheet: { aiError: 'Saran AI tidak bisa dipakai, pilih kolom manual', review: null }
				}
			});
			expect(inspect(r)).not.toContain(key);
		}
		fakeFetch.mockImplementationOnce(async () =>
			messagesResponse(
				JSON.stringify({
					header_row: 0,
					kind: 'both',
					columns: [
						{ index: 0, role: 'date' },
						{ index: 1, role: 'title' },
						{ index: 2, role: 'amount' }
					]
				})
			)
		);
		const ok = await run(async () =>
			act('suggestMapping')(
				await uploadEvent(a, 'suggestMapping', { file: xlsx(bytes), aiTab: '0' })
			)
		);
		expect(ok).toMatchObject({ kind: 'ok', value: { sheet: { aiError: null, review: null } } });
		const tab = (ok as unknown as { value: { sheet: { layout: SheetLayout } } }).value.sheet.layout
			.tabs[0]!;
		expect(tab.columns.map((c) => c.role)).toEqual(['date', 'title', 'amount']);
		expect(tab.status).toBe('ready');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listWallets(db, a.scope.spaceId)).toEqual([]);
	});
});
