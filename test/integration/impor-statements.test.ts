import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { listImportBatches, undoImportBatch } from '#lib/server/imports/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	importStatement,
	previewStatement,
	type ImportStatementInput
} from '#lib/server/statements/statement-import';
import { PDF_READ_BUFFER_BYTES, reservePdfRead } from '#lib/server/statements/pdf-text';
import { STATEMENT_MAX_BYTES } from '#lib/server/statements/read';
import { STATEMENT_UPLOADS_PER_WINDOW } from '#lib/server/statements/validation';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { TRANSACTION_CREATES_MAX } from '#lib/server/transactions/create-limit';
import { TRANSACTION_RATE_LIMITED } from '#lib/server/transactions/messages';
import { createTransaction } from '#lib/server/transactions/repo';
import { sha256Hex } from '#lib/server/util';
import { createWallet } from '#lib/server/wallets/repo';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import {
	FICTIONAL_BANK,
	fictionalStatementCsv,
	fictionalStatementPdf
} from '../fixtures/statements/fictional-bank';
import { BCA_SEPTEMBER, BCA_SEPTEMBER_ROWS, bcaPdf } from '../fixtures/statements/bca';
import { BCA_CSV_SEPTEMBER, BCA_CSV_SEPTEMBER_ROWS, bcaCsv } from '../fixtures/statements/bca-csv';
import { exportTransactionsCsv } from '#lib/server/imports/csv-export';
import { BCA } from '#lib/shared/statements/bca';
import { BNI } from '#lib/shared/statements/bni';
import { BNI_JUNE, BNI_JUNE_ROWS, bniPdf, bniRow } from '../fixtures/statements/bni';
import { MANDIRI } from '#lib/shared/statements/mandiri';
import {
	MANDIRI_AUGUST,
	MANDIRI_AUGUST_ROWS,
	MANDIRI_SINGLE,
	mandiriForgedSectionRemarks,
	mandiriPdf,
	mandiriWithLastRemarks
} from '../fixtures/statements/mandiri';
import { OCBC } from '#lib/shared/statements/ocbc';
import {
	OCBC_JULY,
	OCBC_JULY_ROWS,
	OCBC_SINGLE,
	ocbcPdf,
	ocbcWithLastRemarks
} from '../fixtures/statements/ocbc';
import {
	RK_JULY,
	RK_JULY_ROWS,
	rkPdf,
	rkWithAfter
} from '../fixtures/statements/ocbc-rekening-koran';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { buildPdf, deflateStream } from '../helpers/pdf';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
// The shipped registry is empty (no real sample yet); route tests that need a parser put the fictional one in.
const registry = vi.hoisted(() => [] as unknown[]);
vi.mock('#lib/shared/statements/parsers', () => ({ STATEMENT_PARSERS: registry }));

const impor = await import('../../src/routes/(app)/impor/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = 1_800_000_000_000;
const PARSERS = [FICTIONAL_BANK];

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());
afterEach(() => {
	registry.length = 0;
	vi.restoreAllMocks();
});

let n = 0;
async function account() {
	const email = `mutasi${++n}@contoh.id`;
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

async function wallet(scope: SpaceScope, name = 'Rekening Fiktif') {
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

const input = (
	bytes: Uint8Array,
	walletId: string | null,
	over: Partial<ImportStatementInput> = {}
): ImportStatementInput => ({
	// A fresh buffer per read: the PDF reader hands its buffer to PDF.js, which may detach it.
	bytes: bytes.slice(),
	password: null,
	institution: null,
	filename: 'mutasi-fiktif.pdf',
	defaultWalletId: walletId,
	skipPossibleDuplicates: false,
	...over
});

async function liveRows(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select type, amount_minor, title, occurred_on, source, dedupe_key, import_batch_id
			from transactions where space_id = ? and deleted_at is null order by occurred_on, title`
		)
		.bind(spaceId)
		.all<Record<string, string | number | null>>();
	return results;
}

describe('importStatement (fictional institution)', () => {
	it('writes source statement rows with masked text, statement dedupe keys and a statement batch', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const r = await importStatement(db, a.scope, input(fictionalStatementPdf(), w), NOW, PARSERS);
		expect(r).toMatchObject({
			ok: true,
			summary: { institution: { id: 'fiktif' }, format: 'pdf_text', balance: { status: 'pass' } },
			counts: { rows: 5, imported: 4, skipped: 1, already: 0 }
		});
		const rows = await liveRows(a.scope.spaceId);
		expect(rows.map((x) => [x.occurred_on, x.type, x.amount_minor, x.title])).toEqual([
			['2025-12-01', 'expense', 2_500_000, 'KOPI CONTOH'],
			['2025-12-15', 'income', 500_000_000, 'GAJI PT CONTOH FIKTIF'],
			['2025-12-31', 'expense', 20_000_000, 'LISTRIK CONTOH'],
			// The account number in the description is cut to its last 4 digits before storage.
			['2026-01-02', 'expense', 10_000_000, 'TRANSFER KE ••••0987']
		]);
		expect(rows.every((x) => x.source === 'statement')).toBe(true);
		expect(rows.every((x) => /^statement:[0-9a-f]{32}:\d+$/.test(String(x.dedupe_key)))).toBe(true);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(batch).toMatchObject({
			source: 'statement',
			format: null,
			filename: 'mutasi-fiktif.pdf',
			importedCount: 4,
			skippedCount: 1
		});
		expect(rows.every((x) => x.import_batch_id === batch!.id)).toBe(true);
	});

	it('FN-39/FN-20: a statement row naming a ride, food or kopi word goes to that preset', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const csv = [
			'tanggal_fiktif,uraian_fiktif,debet_fiktif,kredit_fiktif',
			'2025-12-01,GOJEK*JAKARTA,"15.000,00",',
			'2025-12-02,GRABFOOD JKT,"45.000,00",',
			'2025-12-03,KOPI CONTOH,"25.000,00",'
		].join('\n');
		const r = await importStatement(
			db,
			a.scope,
			input(new TextEncoder().encode(csv), w, { filename: 'mutasi.csv' }),
			NOW,
			PARSERS
		);
		expect(r).toMatchObject({ ok: true, counts: { imported: 3 } });
		const { results } = await d1
			.prepare(
				`select t.title, c.name, c.is_preset from transactions t join categories c on c.id = t.category_id
				where t.space_id = ? and t.deleted_at is null order by t.occurred_on`
			)
			.bind(a.scope.spaceId)
			.all<{ title: string; name: string; is_preset: number }>();
		expect(results).toEqual([
			{ title: 'GOJEK*JAKARTA', name: 'Ojek Online', is_preset: 1 },
			{ title: 'GRABFOOD JKT', name: 'Pesan Antar Makanan', is_preset: 1 },
			// FN-20 owner decision 3 lifted FN-39's decision 7: every keyword group now guesses from a description.
			{ title: 'KOPI CONTOH', name: 'Kopi', is_preset: 1 }
		]);
	});

	it('the same file twice: every row is "already imported", nothing new, no error', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const file = fictionalStatementPdf();
		await importStatement(db, a.scope, input(file, w), NOW, PARSERS);
		const again = await importStatement(db, a.scope, input(file, w), NOW, PARSERS);
		expect(again).toMatchObject({ ok: true, batchId: null, counts: { imported: 0, already: 4 } });
		expect(await liveRows(a.scope.spaceId)).toHaveLength(4);
		expect(await listImportBatches(db, a.scope.spaceId)).toHaveLength(1);
	});

	it('undo tombstones every row of a statement batch; the same file never re-creates them', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const file = fictionalStatementPdf();
		await importStatement(db, a.scope, input(file, w), NOW, PARSERS);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 1)).toBe('ok');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		const again = await importStatement(db, a.scope, input(file, w), NOW + 2, PARSERS);
		expect(again).toMatchObject({ ok: true, counts: { imported: 0, already: 4 } });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	});

	it('preview writes nothing and lists a possible duplicate of a live transaction', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		await ensurePresetCategories(db, a.scope.spaceId, NOW);
		const category = (await listCategories(db, a.scope.spaceId)).find((c) => c.kind === 'expense')!;
		await createTransaction(
			db,
			a.scope,
			{
				type: 'expense',
				amountMinor: 2_500_000,
				currency: 'IDR',
				walletId: w,
				transferToWalletId: null,
				categoryId: category.id,
				title: 'Kopi Contoh',
				note: null,
				occurredOn: '2025-12-01',
				occurredTime: null
			},
			NOW
		);
		const p = await previewStatement(
			db,
			a.scope.spaceId,
			input(fictionalStatementPdf(), w),
			PARSERS
		);
		expect(p).toMatchObject({
			ok: true,
			counts: { imported: 4, possibleDuplicates: 1 },
			duplicates: [{ line: 1, date: '2025-12-01', amountMinor: 2_500_000 }]
		});
		expect(await liveRows(a.scope.spaceId)).toHaveLength(1);
		const skip = await importStatement(
			db,
			a.scope,
			input(fictionalStatementPdf(), w, { skipPossibleDuplicates: true }),
			NOW,
			PARSERS
		);
		expect(skip).toMatchObject({ ok: true, counts: { imported: 3 } });
	});

	it('20 concurrent imports of the same statement create each row exactly once, never an error', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const file = fictionalStatementPdf();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => importStatement(db, a.scope, input(file, w), NOW, PARSERS))
		);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.reduce((s, r) => s + (r.ok ? r.counts.imported : 0), 0)).toBe(4);
		expect(await liveRows(a.scope.spaceId)).toHaveLength(4);
		expect(await listImportBatches(db, a.scope.spaceId)).toHaveLength(1);
	}, 120_000);

	it('another space’s wallet is not found before the file is read; a removed member writes nothing', async () => {
		const a = await account();
		const b = await account();
		const theirs = await wallet(b.scope);
		expect(
			await importStatement(db, a.scope, input(fictionalStatementPdf(), theirs), NOW, PARSERS)
		).toEqual({ ok: false, error: 'wallet_not_found' });
		expect(await liveRows(b.scope.spaceId)).toEqual([]);

		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const shared = await wallet({ spaceId, userId: owner.user.id });
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const r = await importStatement(
			db,
			{ spaceId, userId: member.user.id },
			input(fictionalStatementPdf(), shared),
			NOW,
			PARSERS
		);
		expect(r.ok).toBe(false);
		expect(await liveRows(spaceId)).toEqual([]);
		expect(await listImportBatches(db, spaceId)).toEqual([]);
	});

	it('a statement with no readable row is refused, never a zero-row success', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pdf = buildPdf([
			{
				content:
					'BT /F1 10 Tf 40 800 Td 14 TL (BANK CONTOH FIKTIF) Tj T* (PERIODE 01/12/2025 - 31/12/2025) Tj T* (01/12 X ?? DB) Tj ET'
			}
		]);
		expect(await importStatement(db, a.scope, input(pdf, w), NOW, PARSERS)).toEqual({
			ok: false,
			error: 'no_rows',
			hints: null
		});
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
	});
});

// ---- Routes: /impor ?/previewStatement and ?/importStatement --------------------------------------

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

const file = (
	bytes: Uint8Array | string,
	name = 'mutasi 1234567890123.pdf',
	type = 'application/pdf'
) => new File([bytes as BlobPart], name, { type });

describe('/impor statement actions', () => {
	it('with no institution registered, a readable statement answers "format belum didukung" with hints only', async () => {
		const a = await account();
		const r = await run(async () =>
			act('previewStatement')(
				await uploadEvent(a, 'previewStatement', { file: file(fictionalStatementPdf()) })
			)
		);
		expect(r).toEqual({
			kind: 'fail',
			status: 400,
			data: {
				section: 'statement',
				error: 'Format mutasi ini belum didukung.',
				hints: { format: 'pdf_text', pages: 3, columns: null, montraCsv: null },
				needsAi: false,
				needsPassword: false,
				needsInstitution: false
			}
		});
	});

	it('refuses scanned, locked, spreadsheet, empty, missing, oversized and unknown-field uploads with 400, never a 500', async () => {
		const a = await account();
		const scanned = buildPdf([{ content: '', image: true }]);
		const locked = fictionalStatementPdf({ password: 'sandi-fiktif' });
		const cases: [Record<string, string | File>, string, Record<string, unknown>?][] = [
			[
				{ file: file(scanned) },
				'PDF ini berupa gambar (hasil pindai). Baca di perangkat lewat bagian "Baca dari foto atau tangkapan layar".',
				{ needsAi: true }
			],
			[
				{ file: file(locked) },
				'PDF ini dikunci sandi. Isi sandi PDF lalu coba lagi. Sandi hanya dipakai untuk membuka berkas ini dan tidak disimpan.',
				{ needsPassword: true }
			],
			[{ file: file(locked), pdfPassword: 'salah' }, 'Sandi PDF salah. Periksa lalu coba lagi.'],
			[
				{ file: file(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), 'mutasi.xlsx') },
				// FN-17 AC 5: the statement section points to the spreadsheet section.
				'Spreadsheet (.xlsx) diimpor lewat bagian Impor spreadsheet. Untuk mutasi bank, unduh sebagai PDF atau CSV.'
			],
			[
				{ file: file('%PDF-1.4 rusak', 'x.pdf') },
				'PDF rusak atau tidak lengkap. Unduh ulang mutasi dari bank lalu coba lagi.'
			],
			// A PDF-named Windows-1252 text file: never read as mojibake.
			[
				{ file: file(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x31]), 'x.pdf') },
				'Berkas tidak dikenali sebagai PDF atau CSV. Untuk CSV, simpan ulang sebagai UTF-8.'
			],
			[{ file: file('') }, 'Berkas mutasi kosong.'],
			[{}, 'Pilih berkas mutasi (PDF atau CSV) dulu.'],
			[
				{ file: file(new Uint8Array(STATEMENT_MAX_BYTES + 1)) },
				'Berkas lebih dari 15 MB. Unduh mutasi per bulan lalu impor satu per satu.'
			],
			[
				{ file: file(fictionalStatementPdf()), institution: 'bank-lain' },
				'Pilih institusi dari daftar.'
			],
			[
				{ file: file(fictionalStatementPdf()), pdfPassword: 'x'.repeat(129) },
				'Pilih institusi dari daftar.'
			]
		];
		for (const action of ['previewStatement', 'importStatement']) {
			for (const [fields, error, extra] of cases) {
				const r = await run(async () => act(action)(await uploadEvent(a, action, fields)));
				expect(r, error).toMatchObject({
					kind: 'fail',
					status: 400,
					data: { section: 'statement', error, ...extra }
				});
				// User copy never carries the file name, a path or an internal id.
				expect(JSON.stringify(r)).not.toMatch(/1234567890123|mutasi\.xlsx|x\.pdf|\/src\//);
			}
		}
	}, 120_000);

	it('a body past the 15 MB cap is refused 400 before parsing; a non-form body 415', async () => {
		const a = await account();
		const big = file(new Uint8Array(STATEMENT_MAX_BYTES + 128 * 1024));
		expect(
			await run(async () =>
				act('importStatement')(await uploadEvent(a, 'importStatement', { file: big }))
			)
		).toMatchObject({ kind: 'error', status: 400 });
		const { event } = fakeEvent({
			url: 'http://localhost/impor?/importStatement',
			routeId: '/(app)/impor',
			db,
			user: a.user,
			space: await resolveCurrentSpace(db, a.user.id, undefined)
		});
		(event as unknown as { request: Request }).request = new Request(
			'http://localhost/impor?/importStatement',
			{ method: 'POST', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' }
		);
		expect(await run(() => act('importStatement')(event as never))).toMatchObject({
			kind: 'error',
			status: 415
		});
	});

	it('preview, import, already-imported and undo through the actions (fictional parser registered)', async () => {
		registry.push(FICTIONAL_BANK);
		const a = await account();
		const w = await wallet(a.scope);
		const log = vi.spyOn(console, 'error');
		const fields = { file: file(fictionalStatementPdf()), defaultWalletId: w };
		const preview = await run(async () =>
			act('previewStatement')(await uploadEvent(a, 'previewStatement', fields))
		);
		expect(preview).toMatchObject({
			kind: 'ok',
			value: {
				section: 'statement',
				done: 'statementPreviewed',
				statement: { institution: { id: 'fiktif' }, balance: { status: 'pass' }, pages: 3 },
				counts: { imported: 4, skipped: 1 }
			}
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		const done = await run(async () =>
			act('importStatement')(await uploadEvent(a, 'importStatement', fields))
		);
		expect(done).toMatchObject({
			kind: 'ok',
			value: { done: 'statementImported', counts: { imported: 4 } }
		});
		const again = await run(async () =>
			act('importStatement')(await uploadEvent(a, 'importStatement', fields))
		);
		expect(again).toMatchObject({ kind: 'ok', value: { counts: { imported: 0, already: 4 } } });
		// A CSV export of the same statement has other bytes: its own keys, flagged as possible duplicates.
		const csvPreview = await run(async () =>
			act('previewStatement')(
				await uploadEvent(a, 'previewStatement', {
					file: file(fictionalStatementCsv(), 'mutasi.csv', 'text/csv'),
					defaultWalletId: w
				})
			)
		);
		expect(csvPreview).toMatchObject({ kind: 'ok', value: { counts: { possibleDuplicates: 4 } } });

		const load = (await impor.load(
			fakeEvent({
				url: 'http://localhost/impor',
				routeId: '/(app)/impor',
				db,
				user: a.user,
				space: await resolveCurrentSpace(db, a.user.id, undefined)
			}).event as never
		)) as {
			batches: { id: string; source: string; updatedAt: number }[];
			statementInstitutions: unknown;
		};
		expect(load.statementInstitutions).toEqual([{ id: 'fiktif', label: 'Bank Contoh Fiktif' }]);
		expect(load.batches.map((b) => b.source)).toEqual(['statement']);
		const { event: undoEv } = fakeEvent({
			url: 'http://localhost/impor?/undo',
			routeId: '/(app)/impor',
			db,
			user: a.user,
			space: await resolveCurrentSpace(db, a.user.id, undefined),
			form: { id: load.batches[0]!.id, updatedAt: String(load.batches[0]!.updatedAt) }
		});
		expect(await run(() => act('undo')(undoEv as never))).toMatchObject({
			kind: 'ok',
			value: { done: 'undone' }
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		// Nothing of the file (text, names, account numbers) is ever logged.
		expect(inspect(log.mock.calls)).not.toMatch(/KOPI|GAJI|9876543210987|CONTOH/);
	}, 120_000);

	it('cross-space: another space’s wallet gets the uniform not-found; non-members and removed members write nothing there', async () => {
		registry.push(FICTIONAL_BANK);
		const a = await account();
		const b = await account();
		const theirs = await wallet(b.scope);
		const pdf = fictionalStatementPdf();
		expect(
			await run(async () =>
				act('importStatement')(
					await uploadEvent(a, 'importStatement', { file: file(pdf), defaultWalletId: theirs })
				)
			)
		).toEqual({
			kind: 'fail',
			status: 404,
			data: { section: 'statement', error: 'Dompet tidak ditemukan.' }
		});
		// A non-member naming b's space id is answered in their own space (never b's).
		const mine = await wallet(a.scope);
		const r = await run(async () =>
			act('importStatement')(
				await uploadEvent(
					a,
					'importStatement',
					{ file: file(pdf), defaultWalletId: mine },
					b.scope.spaceId
				)
			)
		);
		expect(r).toMatchObject({ kind: 'ok' });
		expect(await liveRows(b.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, b.scope.spaceId)).toEqual([]);

		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const shared = await wallet({ spaceId, userId: owner.user.id });
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		// The removed member is answered in their own space: the shared wallet is not found there.
		expect(
			await run(async () =>
				act('importStatement')(
					await uploadEvent(
						member,
						'importStatement',
						{ file: file(pdf), defaultWalletId: shared },
						spaceId
					)
				)
			)
		).toMatchObject({ kind: 'fail', status: 404 });
		expect(
			await run(async () =>
				act('previewStatement')(
					await uploadEvent(member, 'previewStatement', { file: file(pdf) }, spaceId)
				)
			)
		).toMatchObject({ kind: 'ok', value: { counts: { possibleDuplicates: 0, already: 0 } } });
		expect(await liveRows(spaceId)).toEqual([]);
		expect(await listImportBatches(db, spaceId)).toEqual([]);
	}, 120_000);

	it('red team H1: a hex-escaped Flate bomb is refused through the action with the "too complex" message', async () => {
		const a = await account();
		const data = await deflateStream(300 * 1024 * 1024, 'BT (Contoh fiktif satu dua) Tj ET ');
		const pdf = buildPdf([{ content: '', raw: { dict: '/Filter /Flate#44ecode', data } }]);
		for (const action of ['previewStatement', 'importStatement'])
			expect(
				await run(async () => act(action)(await uploadEvent(a, action, { file: file(pdf) })))
			).toMatchObject({
				kind: 'fail',
				status: 400,
				data: {
					section: 'statement',
					error: 'PDF terlalu berat untuk dibaca di sini. Unduh mutasi per bulan lalu coba lagi.'
				}
			});
	}, 120_000);

	it(`red team M1: past ${STATEMENT_UPLOADS_PER_WINDOW} uploads per window a user is refused 429 before the body is read`, async () => {
		const a = await account();
		for (let i = 0; i < STATEMENT_UPLOADS_PER_WINDOW; i++) {
			const action = i % 2 ? 'importStatement' : 'previewStatement';
			const r = await run(async () =>
				act(action)(await uploadEvent(a, action, { file: file('') }))
			);
			expect(r).toMatchObject({ kind: 'fail', status: 400 });
		}
		expect(
			await run(async () =>
				act('previewStatement')(
					await uploadEvent(a, 'previewStatement', { file: file(fictionalStatementPdf()) })
				)
			)
		).toEqual({
			kind: 'fail',
			status: 429,
			data: {
				section: 'statement',
				error: 'Terlalu banyak unggahan mutasi. Coba lagi dalam beberapa menit.'
			}
		});
		// Another user keeps their own budget.
		const b = await account();
		expect(
			await run(async () =>
				act('previewStatement')(await uploadEvent(b, 'previewStatement', { file: file('') }))
			)
		).toMatchObject({ kind: 'fail', status: 400 });
	}, 120_000);

	it(`red team L5: ${STATEMENT_UPLOADS_PER_WINDOW} uploads just before a window edge leave none just after it`, async () => {
		const a = await account();
		const edge = 1_900_000_200_000; // a multiple of the 10-minute window
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(edge - 20_000);
			for (let i = 0; i < STATEMENT_UPLOADS_PER_WINDOW; i++) {
				const r = await run(async () =>
					act('previewStatement')(await uploadEvent(a, 'previewStatement', { file: file('') }))
				);
				expect(r).toMatchObject({ kind: 'fail', status: 400 });
			}
			vi.setSystemTime(edge + 20_000);
			expect(
				await run(async () =>
					act('importStatement')(await uploadEvent(a, 'importStatement', { file: file('') }))
				)
			).toMatchObject({ kind: 'fail', status: 429 });
		} finally {
			vi.useRealTimers();
		}
	}, 120_000);

	it('red team L4: slow uploads of other users never block an upload; a full byte budget answers 503', async () => {
		const a = await account();
		// Three (and more) other users trickling their bodies hold a place and a few bytes each.
		const slow = Array.from({ length: 5 }, (_, i) => reservePdfRead(`pelan-${i}`)!);
		try {
			for (const p of slow) expect(p.charge(64 * 1024)).toBe(true);
			expect(
				await run(async () =>
					act('previewStatement')(await uploadEvent(a, 'previewStatement', { file: file('') }))
				)
			).toMatchObject({ kind: 'fail', status: 400 });
			// Bytes actually held fill the budget: the next body read stops at once with 503 + Retry-After.
			expect(slow[0]!.charge(PDF_READ_BUFFER_BYTES - 5 * 64 * 1024)).toBe(true);
			const event = (await uploadEvent(a, 'previewStatement', {
				file: file(fictionalStatementPdf())
			})) as unknown as { setHeaders: (h: Record<string, string>) => void };
			const headers: Record<string, string> = {};
			event.setHeaders = (h) => Object.assign(headers, h);
			expect(await run(() => act('previewStatement')(event as never))).toMatchObject({
				kind: 'fail',
				status: 503,
				data: { section: 'statement' }
			});
			expect(headers['retry-after']).toBe('30');
		} finally {
			slow.forEach((p) => p.release());
		}
		// Released: read normally again.
		expect(
			await run(async () =>
				act('previewStatement')(await uploadEvent(a, 'previewStatement', { file: file('') }))
			)
		).toMatchObject({ kind: 'fail', status: 400 });
	});

	it('red team N2: with the user already in the statement lane, 503 + Retry-After before the body is read', async () => {
		const a = await account();
		const held = reservePdfRead(a.user.id)!;
		try {
			for (const action of ['previewStatement', 'importStatement']) {
				const event = (await uploadEvent(a, action, {
					file: file(fictionalStatementPdf())
				})) as unknown as {
					request: Request;
					setHeaders: (h: Record<string, string>) => void;
				};
				const headers: Record<string, string> = {};
				event.setHeaders = (h) => Object.assign(headers, h);
				expect(await run(() => act(action)(event as never))).toEqual({
					kind: 'fail',
					status: 503,
					data: {
						section: 'statement',
						error: 'Sedang membaca mutasi lain. Coba lagi dalam setengah menit.'
					}
				});
				expect(headers['retry-after']).toBe('30');
				expect(event.request.bodyUsed).toBe(false);
			}
		} finally {
			held.release();
		}
		// Released: the next upload is read normally.
		expect(
			await run(async () =>
				act('previewStatement')(await uploadEvent(a, 'previewStatement', { file: file('') }))
			)
		).toMatchObject({ kind: 'fail', status: 400 });
	});

	it('a statement import counts as one creating action and is refused with 429 at the per-user limit', async () => {
		const a = await account();
		const now = Date.now();
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
		const r = await run(async () =>
			act('importStatement')(
				await uploadEvent(a, 'importStatement', { file: file(fictionalStatementPdf()) })
			)
		);
		expect(r).toMatchObject({
			kind: 'fail',
			status: 429,
			data: { section: 'statement', error: TRANSACTION_RATE_LIMITED }
		});
	});
});

describe('BCA e-statement (synthetic three-page PDF)', () => {
	it('reads, reconciles and imports through the shared path: masked text, statement keys, dedupe, undo', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pdf = bcaPdf(BCA_SEPTEMBER);
		const preview = await previewStatement(db, a.scope.spaceId, input(pdf, w), [BCA]);
		expect(preview).toMatchObject({
			ok: true,
			summary: {
				institution: { id: 'bca', label: 'BCA' },
				format: 'pdf_text',
				manual: false,
				pages: 3,
				balance: { status: 'pass' }
			},
			counts: { rows: 7, imported: 7, skipped: 0 }
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);

		const r = await importStatement(db, a.scope, input(pdf, w), NOW, [BCA]);
		expect(r).toMatchObject({ ok: true, counts: { imported: 7, skipped: 0, already: 0 } });
		const rows = await liveRows(a.scope.spaceId);
		// A date right before a card number is masked with it (more hidden, never less).
		const mask = (t: string) =>
			t.replace('02/09 1234567890123456', '02/••••3456').replace('1234567890123456', '••••3456');
		expect(rows.map((x) => [x.occurred_on, x.type, x.amount_minor, x.title])).toEqual(
			[...BCA_SEPTEMBER_ROWS]
				.map(([d, t, m, title]) => [d, t, m, mask(title)])
				.sort((p, q) => `${p[0]}${p[3]}`.localeCompare(`${q[0]}${q[3]}`))
		);
		expect(rows.every((x) => x.source === 'statement')).toBe(true);
		expect(rows.every((x) => /^statement:[0-9a-f]{32}:[0-6]$/.test(String(x.dedupe_key)))).toBe(
			true
		);

		const again = await importStatement(db, a.scope, input(pdf, w), NOW + 1, [BCA]);
		expect(again).toMatchObject({ ok: true, batchId: null, counts: { imported: 0, already: 7 } });
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(batch).toMatchObject({ source: 'statement' });
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 2)).toBe('ok');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 60_000);

	it('a statement that does not check out (a page lost) is refused whole: nothing previewed or written', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pdf = bcaPdf({
			...BCA_SEPTEMBER,
			pages: [BCA_SEPTEMBER.pages[0]!, [], BCA_SEPTEMBER.pages[2]!]
		});
		expect(await previewStatement(db, a.scope.spaceId, input(pdf, null), [BCA])).toMatchObject({
			ok: false,
			error: 'inconsistent'
		});
		expect(await importStatement(db, a.scope, input(pdf, w), NOW, [BCA])).toMatchObject({
			ok: false,
			error: 'inconsistent'
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
	}, 60_000);

	it('red team L4: a long description is masked before it is cut, so no card-number prefix survives', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		// The 16-digit number straddles the 80-character title limit: cut first, 7 digits would stay visible.
		const pdf = bcaPdf({
			period: 'SEPTEMBER 2026',
			opening: '1,000,000.00',
			closing: '990,000.00',
			pages: [[`02/09 KARTU DEBIT ${'X'.repeat(60)} 1234567890123456`, '10,000.00 DB 990,000.00']]
		});
		const r = await importStatement(db, a.scope, input(pdf, w), NOW, [BCA]);
		expect(r).toMatchObject({ ok: true, counts: { imported: 1 } });
		const [row] = await liveRows(a.scope.spaceId);
		expect(String(row!.title)).not.toMatch(/\d{5}/);
		expect(String(row!.title)).toMatch(/ ••••\d{0,3}$/);
	}, 60_000);

	it('the /impor preview action detects BCA on its own and never logs statement text', async () => {
		registry.push(BCA);
		const a = await account();
		const w = await wallet(a.scope);
		const log = vi.spyOn(console, 'error');
		const preview = await run(async () =>
			act('previewStatement')(
				await uploadEvent(a, 'previewStatement', {
					file: file(bcaPdf(BCA_SEPTEMBER)),
					defaultWalletId: w
				})
			)
		);
		expect(preview).toMatchObject({
			kind: 'ok',
			value: {
				done: 'statementPreviewed',
				statement: { institution: { id: 'bca' }, balance: { status: 'pass' }, pages: 3 },
				counts: { imported: 7 }
			}
		});
		expect(inspect(log.mock.calls)).not.toMatch(/CONTOH|FIKTIF|1234567890/);
	}, 60_000);

	it('the /impor actions refuse an inconsistent BCA statement with 400 and the "does not match" message', async () => {
		registry.push(BCA);
		const a = await account();
		const w = await wallet(a.scope);
		const forged = bcaPdf({
			period: 'SEPTEMBER 2026',
			opening: '1,000,000.00',
			closing: '1,000,020.00',
			pages: [
				[
					'10/09 BI-FAST CR TRANSFER DR',
					'1,000,010.00',
					'10.00 1,000,010.00',
					'11/09 BI-FAST CR TRANSFER DR',
					'999,990.00 DB',
					'10.00 1,000,020.00'
				]
			]
		});
		for (const action of ['previewStatement', 'importStatement']) {
			const r = await run(async () =>
				act(action)(await uploadEvent(a, action, { file: file(forged), defaultWalletId: w }))
			);
			expect(r).toMatchObject({
				kind: 'fail',
				status: 400,
				data: {
					error:
						'Isi mutasi ini tidak cocok dengan saldo yang tercetak, jadi tidak ada yang diimpor. Unduh ulang mutasinya dari bank lalu coba lagi.'
				}
			});
		}
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 60_000);
});

describe('BCA mutation CSV (synthetic KlikBCA/myBCA export, FN-16c)', () => {
	const csvBytes = (text: string) => new TextEncoder().encode(text);
	const csvInput = (text: string, walletId: string | null) =>
		input(csvBytes(text), walletId, { filename: 'mutasi-bca-fiktif.csv' });

	it('reads, reconciles and imports through the shared path: masked text, statement keys, dedupe, undo', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const text = bcaCsv(BCA_CSV_SEPTEMBER);
		const preview = await previewStatement(db, a.scope.spaceId, csvInput(text, w), [BCA]);
		expect(preview).toMatchObject({
			ok: true,
			summary: {
				institution: { id: 'bca', label: 'BCA' },
				format: 'csv',
				manual: false,
				pages: null,
				balance: { status: 'pass' }
			},
			counts: { rows: 7, imported: 7, skipped: 0 }
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);

		const r = await importStatement(db, a.scope, csvInput(text, w), NOW, [BCA]);
		expect(r).toMatchObject({ ok: true, counts: { imported: 7, skipped: 0, already: 0 } });
		const rows = await liveRows(a.scope.spaceId);
		// A date right before a card number is masked with it (more hidden, never less).
		const mask = (t: string) => t.replace('02/09 1234567890123456', '02/••••3456');
		expect(rows.map((x) => [x.occurred_on, x.type, x.amount_minor, x.title])).toEqual(
			[...BCA_CSV_SEPTEMBER_ROWS]
				.map(([d, t, m, title]) => [d, t, m, mask(title)])
				.sort((p, q) => `${p[0]}${p[3]}`.localeCompare(`${q[0]}${q[3]}`))
		);
		expect(rows.every((x) => x.source === 'statement')).toBe(true);
		expect(rows.every((x) => /^statement:[0-9a-f]{32}:[0-6]$/.test(String(x.dedupe_key)))).toBe(
			true
		);

		const again = await importStatement(db, a.scope, csvInput(text, w), NOW + 1, [BCA]);
		expect(again).toMatchObject({ ok: true, batchId: null, counts: { imported: 0, already: 7 } });
		// The same rows as a semicolon file are other bytes: flagged as possible duplicates, never silently doubled.
		const semi = await previewStatement(
			db,
			a.scope.spaceId,
			csvInput(text.replaceAll(',', ';'), w),
			[BCA]
		);
		expect(semi).toMatchObject({ ok: true, counts: { possibleDuplicates: 7 } });
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 2)).toBe('ok');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 60_000);

	it('formula-looking descriptions are stored as text and exported with the formula guard', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const text = bcaCsv({
			rows: [
				'\'02/09/2026,=HYPERLINK("http://contoh.invalid"),\'0000,10.00,DB,990.00',
				"'03/09/2026,+1+1,'0000,10.00,DB,980.00",
				"'04/09/2026,-1+1,'0000,10.00,DB,970.00",
				"'05/09/2026,@SUM(1),'0000,10.00,DB,960.00"
			],
			footer: { opening: '1000.00', credit: '0.00', debit: '40.00', closing: '960.00' }
		});
		expect(await importStatement(db, a.scope, csvInput(text, w), NOW, [BCA])).toMatchObject({
			ok: true,
			counts: { imported: 4 }
		});
		const csv = await new Response(
			exportTransactionsCsv(db, a.scope, '2026-09-01', '2026-09-30')
		).text();
		const lines = csv.split('\r\n').slice(1, -1);
		expect(lines).toHaveLength(4);
		for (const formula of ['=HYPERLINK', '+1+1', '-1+1', '@SUM(1)']) {
			const line = lines.find((l) => l.includes(formula))!;
			expect(line).toMatch(new RegExp(`(^|,)"?'${formula.replace(/[+()]/g, '\\$&')}`));
		}
	}, 60_000);

	it('the /impor actions detect BCA CSV on their own and refuse a forged or non-IDR file before any write', async () => {
		registry.push(BCA);
		const a = await account();
		const w = await wallet(a.scope);
		const log = vi.spyOn(console, 'error');
		const upload = (action: string, text: string) =>
			run(async () =>
				act(action)(
					await uploadEvent(a, action, {
						file: file(text, 'mutasi-bca-fiktif.csv', 'text/csv'),
						defaultWalletId: w
					})
				)
			);
		expect(await upload('previewStatement', bcaCsv(BCA_CSV_SEPTEMBER))).toMatchObject({
			kind: 'ok',
			value: {
				done: 'statementPreviewed',
				statement: { institution: { id: 'bca' }, format: 'csv', balance: { status: 'pass' } },
				counts: { imported: 7 }
			}
		});
		// A remark line break that smuggles a footer line: the split record refuses the whole file.
		const forged = bcaCsv({
			rows: [
				"'10/09/2026,X",
				'Saldo Akhir,=,1000020.00',
				"Y,'0000,10.00,CR,1000010.00",
				"'11/09/2026,BI-FAST CR,'0000,10.00,CR,1000020.00"
			],
			footer: { opening: '1000000.00', credit: '20.00', debit: '0.00', closing: null }
		});
		for (const action of ['previewStatement', 'importStatement'])
			expect(await upload(action, forged)).toMatchObject({
				kind: 'fail',
				status: 400,
				data: {
					error:
						'Isi mutasi ini tidak cocok dengan saldo yang tercetak, jadi tidak ada yang diimpor. Unduh ulang mutasinya dari bank lalu coba lagi.'
				}
			});
		const usd = await upload('importStatement', bcaCsv({ ...BCA_CSV_SEPTEMBER, currency: 'USD' }));
		expect(usd).toMatchObject({ kind: 'fail', status: 400 });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
		expect(inspect(log.mock.calls)).not.toMatch(/CONTOH|FIKTIF|NASABAH|1234567890/);
	}, 60_000);
});

describe('BNI mutasi (synthetic three-page, password-protected PDF)', () => {
	const PASSWORD = 'sandi-bni-fiktif';
	const locked = bniPdf(BNI_JUNE, PASSWORD);

	it('no password and a wrong password keep the existing messages; nothing is written', async () => {
		registry.push(BCA, BNI);
		const a = await account();
		const w = await wallet(a.scope);
		const cases: [Record<string, string | File>, string, Record<string, unknown>][] = [
			[
				{ file: file(locked), defaultWalletId: w },
				'PDF ini dikunci sandi. Isi sandi PDF lalu coba lagi. Sandi hanya dipakai untuk membuka berkas ini dan tidak disimpan.',
				{ needsPassword: true }
			],
			[
				{ file: file(locked), defaultWalletId: w, pdfPassword: 'bukan-sandinya' },
				'Sandi PDF salah. Periksa lalu coba lagi.',
				{}
			]
		];
		for (const action of ['previewStatement', 'importStatement'])
			for (const [fields, error, extra] of cases) {
				const r = await run(async () => act(action)(await uploadEvent(a, action, fields)));
				expect(r, error).toMatchObject({
					kind: 'fail',
					status: 400,
					data: { section: 'statement', error, ...extra }
				});
				expect(JSON.stringify(r)).not.toContain(PASSWORD);
			}
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 60_000);

	it('with the password: detected, reconciled, imported once with masked text, then undone', async () => {
		registry.push(BCA, BNI);
		const a = await account();
		const w = await wallet(a.scope);
		const log = vi.spyOn(console, 'error');
		const fields = { file: file(locked), defaultWalletId: w, pdfPassword: PASSWORD };
		const preview = await run(async () =>
			act('previewStatement')(await uploadEvent(a, 'previewStatement', fields))
		);
		expect(preview).toMatchObject({
			kind: 'ok',
			value: {
				done: 'statementPreviewed',
				statement: {
					institution: { id: 'bni', label: 'BNI' },
					balance: { status: 'pass' },
					pages: 3
				},
				counts: { imported: 7, skipped: 0 }
			}
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		const done = await run(async () =>
			act('importStatement')(await uploadEvent(a, 'importStatement', fields))
		);
		expect(done).toMatchObject({
			kind: 'ok',
			value: { done: 'statementImported', counts: { imported: 7 } }
		});
		const rows = await liveRows(a.scope.spaceId);
		const mask = (t: string) =>
			t.replace('8808123456789012', '••••9012').replace('1234567890123', '••••0123');
		expect(rows.map((x) => [x.occurred_on, x.type, x.amount_minor, x.title])).toEqual(
			[...BNI_JUNE_ROWS]
				.map(([d, t, m, title]) => [d, t, m, mask(title)])
				.sort((p, q) => `${p[0]}${p[3]}`.localeCompare(`${q[0]}${q[3]}`))
		);
		expect(rows.every((x) => x.source === 'statement')).toBe(true);
		const again = await run(async () =>
			act('importStatement')(await uploadEvent(a, 'importStatement', fields))
		);
		expect(again).toMatchObject({ kind: 'ok', value: { counts: { imported: 0, already: 7 } } });
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 2)).toBe('ok');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		// Neither statement text nor the password is ever logged.
		expect(inspect(log.mock.calls)).not.toMatch(/FIKTIF|CONTOH|1234567890|sandi-bni/);
	}, 120_000);

	it('a forged or tampered BNI statement is refused whole with the "does not match" message', async () => {
		registry.push(BCA, BNI);
		const a = await account();
		const w = await wallet(a.scope);
		const forged = bniPdf({
			period: '1 - 30 Juni 2026',
			opening: '1,000,000',
			closing: '1,000,020',
			totals: { credit: '20', debit: '0' },
			pages: [
				[
					...bniRow('10 Jun 2026', 'Transfer', '- PENGIRIM +1,000,010 2,000,010'),
					'- PENGIRIM +10 1,000,010',
					...bniRow('11 Jun 2026', 'Transfer', '- PENGIRIM -999,990 1,000,020'),
					'- PENGIRIM +10 1,000,020'
				]
			]
		});
		for (const action of ['previewStatement', 'importStatement']) {
			const r = await run(async () =>
				act(action)(await uploadEvent(a, action, { file: file(forged), defaultWalletId: w }))
			);
			expect(r).toMatchObject({
				kind: 'fail',
				status: 400,
				data: {
					error:
						'Isi mutasi ini tidak cocok dengan saldo yang tercetak, jadi tidak ada yang diimpor. Unduh ulang mutasinya dari bank lalu coba lagi.'
				}
			});
		}
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
	}, 60_000);

	it('picking BNI by hand reads it; picking BCA for a BNI file is refused, never guessed', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pdf = bniPdf(BNI_JUNE);
		expect(
			await previewStatement(db, a.scope.spaceId, input(pdf, w, { institution: 'bni' }), [BCA, BNI])
		).toMatchObject({ ok: true, summary: { manual: true, institution: { id: 'bni' } } });
		expect(
			await previewStatement(db, a.scope.spaceId, input(pdf, w, { institution: 'bca' }), [BCA, BNI])
		).toMatchObject({ ok: false, error: 'institution_mismatch' });
	}, 60_000);
});

describe('Mandiri consolidated e-statement (synthetic multi-account PDF)', () => {
	const CHOICES = [
		{ index: 0, label: 'Tabungan Fiktif', accountLast4: '6543', rows: 4, importable: true },
		{ index: 1, label: 'Giro Fiktif', accountLast4: '6667', rows: 2, importable: true }
	];

	it('two accounts: asks which one, then imports each into its wallet with file-unique keys', async () => {
		const a = await account();
		const tabungan = await wallet(a.scope, 'Tabungan');
		const giro = await wallet(a.scope, 'Giro');
		const pdf = mandiriPdf(MANDIRI_AUGUST);
		// No account picked: nothing is guessed, the accounts are listed (labels and last 4 digits only).
		expect(await previewStatement(db, a.scope.spaceId, input(pdf, giro), [MANDIRI])).toEqual({
			ok: false,
			error: 'section_required',
			hints: { format: 'pdf_text', pages: 4, columns: null, montraCsv: null },
			sections: CHOICES
		});
		expect(await importStatement(db, a.scope, input(pdf, giro), NOW, [MANDIRI])).toMatchObject({
			ok: false,
			error: 'section_required'
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);

		const preview = await previewStatement(db, a.scope.spaceId, input(pdf, giro, { section: 1 }), [
			MANDIRI
		]);
		expect(preview).toMatchObject({
			ok: true,
			summary: {
				institution: { id: 'mandiri', label: 'Mandiri' },
				balance: { status: 'pass' },
				section: CHOICES[1],
				sections: CHOICES
			},
			counts: { rows: 2, imported: 2, skipped: 0 }
		});
		const r = await importStatement(db, a.scope, input(pdf, giro, { section: 1 }), NOW, [MANDIRI]);
		expect(r).toMatchObject({
			ok: true,
			counts: { imported: 2 },
			summary: { section: CHOICES[1] }
		});
		const first = await importStatement(db, a.scope, input(pdf, tabungan, { section: 0 }), NOW, [
			MANDIRI
		]);
		expect(first).toMatchObject({ ok: true, counts: { imported: 4 } });
		const rows = await liveRows(a.scope.spaceId);
		expect(rows.map((x) => [x.occurred_on, x.type, x.amount_minor]).sort()).toEqual(
			MANDIRI_AUGUST_ROWS.flat()
				.map(([d, t, m]) => [d, t, m])
				.sort()
		);
		// The account number in a remark is masked before storage.
		expect(rows.map((x) => String(x.title)).join(' ')).not.toMatch(/\d{5}/);
		const keys = rows.map((x) => String(x.dedupe_key).split(':')[2]).sort();
		expect(keys).toEqual(['0', '1', '2', '3', '4', '5']);
		const { results: walletOf } = await d1
			.prepare(
				'select wallet_id, count(*) as n from transactions where space_id = ? group by wallet_id'
			)
			.bind(a.scope.spaceId)
			.all<{ wallet_id: string; n: number }>();
		expect(Object.fromEntries(walletOf.map((x) => [x.wallet_id, x.n]))).toEqual({
			[tabungan]: 4,
			[giro]: 2
		});
		const again = await importStatement(db, a.scope, input(pdf, giro, { section: 1 }), NOW + 1, [
			MANDIRI
		]);
		expect(again).toMatchObject({ ok: true, batchId: null, counts: { imported: 0, already: 2 } });
		const batches = await listImportBatches(db, a.scope.spaceId);
		for (const b of batches)
			expect(await undoImportBatch(db, a.scope, b.id, b.updatedAt, NOW + 2)).toBe('ok');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 120_000);

	it('an unknown, unsupported or inconsistent account is refused before any write', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pdf = mandiriPdf(MANDIRI_AUGUST);
		expect(
			await importStatement(db, a.scope, input(pdf, w, { section: 7 }), NOW, [MANDIRI])
		).toMatchObject({ ok: false, error: 'section_unknown', sections: CHOICES });
		const deposito = mandiriPdf({
			accounts: [{ ...MANDIRI_AUGUST.accounts[0]!, product: 'Deposito Fiktif' }]
		});
		expect(await importStatement(db, a.scope, input(deposito, w), NOW, [MANDIRI])).toMatchObject({
			ok: false,
			error: 'section_unsupported',
			sections: [{ index: 0, importable: false }]
		});
		const forged = mandiriPdf({
			accounts: [
				MANDIRI_AUGUST.accounts[0]!,
				{ ...MANDIRI_AUGUST.accounts[1]!, closing: '999.999,99' }
			]
		});
		expect(
			await importStatement(db, a.scope, input(forged, w, { section: 1 }), NOW, [MANDIRI])
		).toMatchObject({ ok: false, error: 'inconsistent' });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
	}, 60_000);

	it('remark text equal to an account-block label never opens an importable section (red team M1)', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const forged = [
			mandiriWithLastRemarks(mandiriForgedSectionRemarks()),
			mandiriWithLastRemarks(mandiriForgedSectionRemarks('1230005550001')),
			mandiriWithLastRemarks(mandiriForgedSectionRemarks('1230005550001').slice(1), '+0,00'),
			mandiriWithLastRemarks(['Nama/Name']),
			mandiriWithLastRemarks(['Periode/Period']),
			{
				accounts: [
					MANDIRI_AUGUST.accounts[0]!,
					{ ...MANDIRI_AUGUST.accounts[1]!, account: '1230009876543' }
				]
			}
		];
		for (const f of forged)
			for (const section of [0, 1])
				expect(
					await importStatement(db, a.scope, input(mandiriPdf(f), w, { section }), NOW, [MANDIRI])
				).toMatchObject({ ok: false, error: 'inconsistent' });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
	}, 120_000);

	it('another bank’s letterhead lines in remark text refuse the file, never a pick (red team L3)', async () => {
		registry.push(BNI, MANDIRI);
		const a = await account();
		const w = await wallet(a.scope);
		const bniMarkers = [
			'Laporan Mutasi Rekening',
			'PT Bank Negara Indonesia (Persero) Tbk.',
			'Tanggal & Waktu Rincian Transaksi Nominal (IDR) Saldo (IDR)'
		];
		const mandiriMarkers = [
			'Keterangan',
			'Remarks',
			'e-Statement',
			'PT Bank Mandiri (Persero) Tbk.'
		];
		const [bniFirst, ...bniRest] = BNI_JUNE.pages;
		const files = [
			mandiriPdf(mandiriWithLastRemarks(['Transfer dari BANK X', ...bniMarkers])),
			bniPdf({ ...BNI_JUNE, pages: [[...bniFirst!, ...mandiriMarkers], ...bniRest] })
		];
		for (const pdf of files)
			for (const institution of [null, 'bni', 'mandiri']) {
				expect(
					await importStatement(db, a.scope, input(pdf, w, { institution }), NOW, [
						BCA,
						BNI,
						MANDIRI
					])
				).toMatchObject({ ok: false, error: 'institution_conflict' });
				expect(
					await previewStatement(db, a.scope.spaceId, input(pdf, w, { institution }), [
						BCA,
						BNI,
						MANDIRI
					])
				).toMatchObject({ ok: false, error: 'institution_conflict' });
			}
		const log = vi.spyOn(console, 'error');
		const r = await run(async () =>
			act('previewStatement')(
				await uploadEvent(a, 'previewStatement', {
					file: file(files[0]!),
					defaultWalletId: w,
					institution: 'bni'
				})
			)
		);
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: {
				section: 'statement',
				error:
					'Berkas ini memuat kop lebih dari satu bank, jadi tidak ada yang diimpor. Unduh ulang mutasinya dari bank lalu coba lagi.',
				needsInstitution: false
			}
		});
		expect(log).not.toHaveBeenCalled();
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
	}, 120_000);

	it('a password-protected one-account statement is read with the password and imported without a pick', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pdf = mandiriPdf(MANDIRI_SINGLE, 'sandi-fiktif');
		expect(await importStatement(db, a.scope, input(pdf, w), NOW, [MANDIRI])).toMatchObject({
			ok: false,
			error: 'encrypted'
		});
		const r = await importStatement(db, a.scope, input(pdf, w, { password: 'sandi-fiktif' }), NOW, [
			MANDIRI
		]);
		expect(r).toMatchObject({
			ok: true,
			counts: { imported: 4 },
			summary: { section: { index: 0, accountLast4: '6543' }, balance: { status: 'pass' } }
		});
	}, 60_000);

	it('the /impor actions list the accounts, take the picked one and refuse a malformed pick', async () => {
		registry.push(MANDIRI);
		const a = await account();
		const w = await wallet(a.scope);
		const log = vi.spyOn(console, 'error');
		const fields = { file: file(mandiriPdf(MANDIRI_AUGUST)), defaultWalletId: w };
		const ask = await run(async () =>
			act('previewStatement')(await uploadEvent(a, 'previewStatement', fields))
		);
		expect(ask).toMatchObject({
			kind: 'fail',
			status: 400,
			data: {
				section: 'statement',
				error:
					'Berkas ini berisi beberapa rekening. Pilih satu rekening untuk diimpor ke dompet ini.',
				sections: CHOICES
			}
		});
		const bad = await run(async () =>
			act('importStatement')(
				await uploadEvent(a, 'importStatement', { ...fields, statementSection: '-1' })
			)
		);
		expect(bad).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { error: 'Pilih rekening dari daftar.' }
		});
		const done = await run(async () =>
			act('importStatement')(
				await uploadEvent(a, 'importStatement', { ...fields, statementSection: '0' })
			)
		);
		expect(done).toMatchObject({
			kind: 'ok',
			value: {
				done: 'statementImported',
				statement: { section: CHOICES[0] },
				counts: { imported: 4 }
			}
		});
		expect(await liveRows(a.scope.spaceId)).toHaveLength(4);
		expect(inspect(log.mock.calls)).not.toMatch(/FIKTIF|Fiktif|1230009876543|6543/);
	}, 120_000);
});

describe('OCBC consolidated statement (synthetic multi-account PDF)', () => {
	const CHOICES = [
		{ index: 0, label: 'Tabungan Fiktif', accountLast4: '0300', rows: 5, importable: true },
		{ index: 1, label: 'Tabungan Fiktif', accountLast4: '0300', rows: 0, importable: false },
		{ index: 2, label: 'Giro Fiktif', accountLast4: '0999', rows: 2, importable: true }
	];

	it('asks which account, imports each into its wallet, dedupes a re-import and refuses the USD one', async () => {
		const a = await account();
		const tabungan = await wallet(a.scope, 'Tabungan');
		const giro = await wallet(a.scope, 'Giro');
		const pdf = ocbcPdf(OCBC_JULY);
		expect(await previewStatement(db, a.scope.spaceId, input(pdf, giro), [OCBC])).toEqual({
			ok: false,
			error: 'section_required',
			hints: { format: 'pdf_text', pages: 7, columns: null, montraCsv: null },
			sections: CHOICES
		});
		expect(
			await importStatement(db, a.scope, input(pdf, giro, { section: 1 }), NOW, [OCBC])
		).toMatchObject({ ok: false, error: 'section_unsupported' });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);

		const first = await importStatement(db, a.scope, input(pdf, tabungan, { section: 0 }), NOW, [
			OCBC
		]);
		expect(first).toMatchObject({
			ok: true,
			counts: { imported: 5 },
			summary: {
				institution: { id: 'ocbc', label: 'OCBC' },
				balance: { status: 'pass' },
				section: CHOICES[0]
			}
		});
		expect(
			await importStatement(db, a.scope, input(pdf, giro, { section: 2 }), NOW, [OCBC])
		).toMatchObject({ ok: true, counts: { imported: 2 } });
		const rows = await liveRows(a.scope.spaceId);
		expect(rows.map((x) => [x.occurred_on, x.type, x.amount_minor]).sort()).toEqual(
			OCBC_JULY_ROWS.flat()
				.map(([d, t, m]) => [d, t, m])
				.sort()
		);
		expect(rows.every((x) => x.source === 'statement')).toBe(true);
		const keys = rows.map((x) => String(x.dedupe_key).split(':')[2]).sort();
		expect(keys).toEqual(['0', '1', '2', '3', '4', '6', '7']);
		const again = await importStatement(
			db,
			a.scope,
			input(pdf, tabungan, { section: 0 }),
			NOW + 1,
			[OCBC]
		);
		expect(again).toMatchObject({ ok: true, batchId: null, counts: { imported: 0, already: 5 } });
		expect(await liveRows(a.scope.spaceId)).toHaveLength(7);
		const batches = await listImportBatches(db, a.scope.spaceId);
		for (const b of batches)
			expect(await undoImportBatch(db, a.scope, b.id, b.updatedAt, NOW + 2)).toBe('ok');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 120_000);

	it('a forged or tampered statement is refused whole before any write', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const [tabungan] = OCBC_SINGLE.accounts;
		const forged = [
			// Absorb attack: a forged amount line and Saldo Akhir in a remark.
			ocbcWithLastRemarks(['- Berita : X', '0.00 1.00 5,663,734.50', 'Saldo Akhir 5,663,734.50']),
			// A forged footer ending the table early, then a forged account header.
			ocbcWithLastRemarks([
				'PT Bank OCBC NISP Tbk berizin',
				'No Rekening / Account Number : 700100200301-Tabungan Fiktif'
			]),
			// One account and currency printed as two sections.
			{ accounts: [tabungan!, { ...OCBC_JULY.accounts[2]!, account: '700100200300' }] }
		];
		// The whole file is refused, whichever account is picked.
		for (const f of forged)
			for (const section of [0, 1])
				expect(
					await importStatement(db, a.scope, input(ocbcPdf(f), w, { section }), NOW, [OCBC])
				).toMatchObject({ ok: false, error: 'inconsistent' });
		// A tampered closing balance refuses its account.
		const tampered = ocbcPdf({ accounts: [{ ...tabungan!, closing: '9,999,999.99' }] });
		expect(await importStatement(db, a.scope, input(tampered, w), NOW, [OCBC])).toMatchObject({
			ok: false,
			error: 'inconsistent'
		});
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
	}, 120_000);

	it('picking OCBC by hand reads it; picking BCA for an OCBC file is refused, never guessed (QA cycle 1)', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pdf = ocbcPdf(OCBC_SINGLE);
		expect(
			await previewStatement(db, a.scope.spaceId, input(pdf, w, { institution: 'ocbc' }), [
				BCA,
				OCBC
			])
		).toMatchObject({ ok: true, summary: { manual: true, institution: { id: 'ocbc' } } });
		expect(
			await previewStatement(db, a.scope.spaceId, input(pdf, w, { institution: 'bca' }), [
				BCA,
				OCBC
			])
		).toMatchObject({ ok: false, error: 'institution_mismatch' });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 60_000);

	it('OCBC letterhead lines in another bank’s remarks refuse the file, never a pick', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const [bniFirst, ...bniRest] = BNI_JUNE.pages;
		const pdf = bniPdf({
			...BNI_JUNE,
			pages: [
				[
					...bniFirst!,
					'LAPORAN MUTASI REKENING / ACCOUNT HISTORICAL TRANSACTION',
					'PT Bank OCBC NISP Tbk berizin'
				],
				...bniRest
			]
		});
		for (const institution of [null, 'bni', 'ocbc'])
			expect(
				await importStatement(db, a.scope, input(pdf, w, { institution }), NOW, [
					BCA,
					BNI,
					MANDIRI,
					OCBC
				])
			).toMatchObject({ ok: false, error: 'institution_conflict' });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
	}, 60_000);
});

describe('OCBC Rekening Koran (synthetic single-account PDF, FN-16h)', () => {
	const CHOICES = [
		{ index: 0, label: 'Tabungan Fiktif IDR', accountLast4: '0300', rows: 6, importable: true },
		{ index: 1, label: 'Tabungan Fiktif SGD', accountLast4: '0300', rows: 0, importable: false }
	];

	it('is detected and read (was institution_unknown / inconsistent), imports IDR once and refuses SGD', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const pdf = rkPdf(RK_JULY);
		for (const institution of [null, 'ocbc'])
			expect(
				await previewStatement(db, a.scope.spaceId, input(pdf, w, { institution }), [
					BCA,
					BNI,
					MANDIRI,
					OCBC
				])
			).toEqual({
				ok: false,
				error: 'section_required',
				hints: { format: 'pdf_text', pages: 3, columns: null, montraCsv: null },
				sections: CHOICES
			});
		expect(
			await importStatement(db, a.scope, input(pdf, w, { section: 1 }), NOW, [OCBC])
		).toMatchObject({ ok: false, error: 'section_unsupported' });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);

		const first = await importStatement(db, a.scope, input(pdf, w, { section: 0 }), NOW, [OCBC]);
		expect(first).toMatchObject({
			ok: true,
			counts: { imported: 6 },
			summary: {
				institution: { id: 'ocbc', label: 'OCBC' },
				balance: { status: 'pass' },
				section: CHOICES[0]
			}
		});
		const rows = await liveRows(a.scope.spaceId);
		expect(rows.map((x) => [x.occurred_on, x.type, x.amount_minor]).sort()).toEqual(
			RK_JULY_ROWS.map(([d, t, m]) => [d, t, m]).sort()
		);
		expect(rows.every((x) => x.source === 'statement')).toBe(true);
		const again = await importStatement(db, a.scope, input(pdf, w, { section: 0 }), NOW + 1, [
			OCBC
		]);
		expect(again).toMatchObject({ ok: true, batchId: null, counts: { imported: 0, already: 6 } });
		expect(await liveRows(a.scope.spaceId)).toHaveLength(6);
	}, 120_000);

	it('a forged or tampered statement is refused whole before any write', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const forged = [
			// A second amount line in a note after the real one.
			rkWithAfter(0, 2, ['Berita : TOKO', '1.00 0.00 3,849,999.00']),
			// A forged currency block inside a note.
			rkWithAfter(0, 1, ['Currency Code : USD', 'Beginning Balance 4,000,000.00']),
			// A summary total that is not its IDR column.
			{ ...RK_JULY, total: '1.00' }
		];
		for (const f of forged)
			expect(
				await importStatement(db, a.scope, input(rkPdf(f), w, { section: 0 }), NOW, [OCBC])
			).toMatchObject({ ok: false, error: 'inconsistent' });
		expect(await liveRows(a.scope.spaceId)).toEqual([]);
		expect(await listImportBatches(db, a.scope.spaceId)).toEqual([]);
	}, 120_000);
});
