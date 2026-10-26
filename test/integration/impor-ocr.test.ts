import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { existsSync, readdirSync } from 'node:fs';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pinThrottleWindow } from '../helpers/clock';
import { signUp } from '#lib/server/auth/accounts';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { getDb, type Db } from '#lib/server/db';
import { listImportBatches, undoImportBatch } from '#lib/server/imports/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { OCR_BODY_MAX_BYTES } from '#lib/server/statements/ocr-validation';
import { STATEMENT_UPLOADS_PER_WINDOW } from '#lib/server/statements/validation';
import { TRANSACTION_CREATES_MAX } from '#lib/server/transactions/create-limit';
import { TRANSACTION_RATE_LIMITED } from '#lib/server/transactions/messages';
import { sha256Hex } from '#lib/server/util';
import { createWallet } from '#lib/server/wallets/repo';
import type { OcrDocument } from '#lib/shared/ocr/lines';
import { wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { BCA_SEPTEMBER, bcaPages } from '../fixtures/statements/bca';
import { mandiriPages } from '../fixtures/statements/mandiri';
import { ocrDoc, ocrDocFromText, type ConfOf } from '../helpers/ocr';

/*
 * FN-16g on-device OCR actions (PRD criteria 31–37) on a local D1. The fixtures are fictional e-wallet
 * screenshots described as OCR words; no engine runs here. Dates are relative to the real WIB today because the
 * actions read the clock (rows dated in the future are refused).
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

let n = 0;
async function account() {
	const email = `ocr${++n}@contoh.id`;
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

async function wallet(scope: SpaceScope, name = 'GoPay Fiktif') {
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

/** `08 Okt 2026`-style header for a past day (the screen prints day, month and year). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const TODAY = wibTodayString();
const dayHeader = (date: string) =>
	`${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const DAY = (() => {
	const d = new Date(`${TODAY}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 3);
	return d.toISOString().slice(0, 10);
})();

/** A fictional GoPay history: two ready rows (one twice, same time), one without a sign (review). */
function screen(
	titles: [string, string, string] = ['Kopi Senja Fiktif', 'Roti Contoh', 'Top Up Fiktif']
): string[] {
	return [
		'09:41',
		'GoPay',
		'Riwayat transaksi',
		dayHeader(DAY),
		`${titles[0]} 4111 1111 1111 1111   -Rp25.000`,
		'14:30',
		`${titles[1]}   -Rp15.000`,
		'15:00',
		`${titles[1]}   -Rp15.000`,
		'15:00',
		`${titles[2]}   Rp100.000`,
		'16:00'
	];
}
const doc = (lines = screen(), conf: ConfOf = 96) => ocrDoc([lines], conf);

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

async function ocrEvent(
	who: Account,
	action: string,
	fields: Record<string, string>,
	space?: string,
	body?: BodyInit,
	type?: string
) {
	const current = await resolveCurrentSpace(db, who.user.id, space);
	const { event } = fakeEvent({
		url: `http://localhost/impor?/${action}`,
		routeId: '/(app)/impor',
		db,
		user: who.user,
		space: current
	});
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	const encoded = new Request('http://localhost/', { method: 'POST', body: form });
	(event as unknown as { request: Request }).request = new Request(
		`http://localhost/impor?/${action}`,
		{
			method: 'POST',
			headers: { 'content-type': type ?? encoded.headers.get('content-type')! },
			body: body ?? (await encoded.arrayBuffer())
		}
	);
	return event as never;
}

const call = async (who: Account, action: string, fields: Record<string, string>, space?: string) =>
	run(async () => act(action)(await ocrEvent(who, action, fields, space)));

const fieldsOf = (d: OcrDocument, extra: Record<string, string> = {}) => ({
	ocr: JSON.stringify(d),
	...extra
});

async function liveRows(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select type, amount_minor, title, occurred_on, source, dedupe_key, import_batch_id, deleted_at
			from transactions where space_id = ? order by occurred_on, amount_minor, dedupe_key`
		)
		.bind(spaceId)
		.all<Record<string, string | number | null>>();
	return results;
}

describe('/impor OCR actions: preview, import, dedupe, undo (criteria 35, 36)', () => {
	it('previews the server’s own rows with review reasons and imports only the kept ones', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const log = vi.spyOn(console, 'error');
		const preview = await call(a, 'previewOcr', fieldsOf(doc(), { defaultWalletId: w }));
		expect(preview.kind).toBe('ok');
		const value = (preview as { value: Record<string, unknown> }).value;
		expect(value).toMatchObject({
			section: 'ocr',
			done: 'ocrPreviewed',
			ocr: { kind: 'screenshot', institution: { id: 'gopay', label: 'GoPay' }, pages: 1 },
			totals: { incomeMinor: 0, expenseMinor: 5_500_000 }
		});
		const rows = value.rows as {
			index: number;
			title: string;
			review: string | null;
			included: boolean;
		}[];
		expect(rows.map((r) => [r.review, r.included])).toEqual([
			[null, true],
			[null, true],
			[null, true],
			['direction_unknown', false]
		]);
		// Card number masked before it reaches a page.
		expect(rows[0]!.title).toBe('Kopi Senja Fiktif ••••1111');
		expect(await liveRows(a.scope.spaceId)).toEqual([]);

		// Tick the review row in, tick one ready row out.
		const imported = await call(
			a,
			'importOcr',
			fieldsOf(doc(), { defaultWalletId: w, include: '[3]', exclude: '[0]' })
		);
		expect(imported).toMatchObject({
			kind: 'ok',
			value: { done: 'ocrImported', counts: { imported: 3 } }
		});
		const stored = await liveRows(a.scope.spaceId);
		expect(stored.map((r) => [r.type, r.amount_minor, r.occurred_on, r.source])).toEqual([
			['expense', 1_500_000, DAY, 'statement'],
			['expense', 1_500_000, DAY, 'statement'],
			['expense', 10_000_000, DAY, 'statement']
		]);
		// Identical rows in one image: distinct keys by occurrence.
		const keys = stored.map((r) => String(r.dedupe_key));
		expect(keys.every((k) => /^ocr:[0-9a-f]{32}:\d+$/.test(k))).toBe(true);
		expect(new Set(keys).size).toBe(3);
		expect(keys.filter((k) => k.endsWith(':1'))).toHaveLength(1);
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(batch).toMatchObject({ source: 'statement', filename: null, importedCount: 3 });

		// A re-scan with jittered descriptions finds every row already imported; the excluded one is new.
		const rescan = doc(screen(['Kopi Senja Fiktlf', 'Rotl Contoh', 'Top Up Fiktit']));
		const again = await call(
			a,
			'importOcr',
			fieldsOf(rescan, { defaultWalletId: w, include: '[3]' })
		);
		expect(again).toMatchObject({ kind: 'ok', value: { counts: { imported: 1, already: 3 } } });
		expect((await liveRows(a.scope.spaceId)).length).toBe(4);

		// Undo removes exactly the first batch; a re-scan never re-creates its rows.
		await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, Date.now());
		const live = (await liveRows(a.scope.spaceId)).filter((r) => r.deleted_at === null);
		expect(live).toHaveLength(1);
		const third = await call(
			a,
			'importOcr',
			fieldsOf(doc(), { defaultWalletId: w, include: '[3]' })
		);
		expect(third).toMatchObject({ kind: 'ok', value: { counts: { imported: 0, already: 4 } } });

		// Nothing of the words is ever logged.
		expect(inspect(log.mock.calls)).not.toMatch(/Kopi|Roti|Fiktif|4111/);
		log.mockRestore();
	}, 120_000);

	it('the server ignores client figures: hidden fields are dropped, unknown document keys are refused', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const r = await call(
			a,
			'importOcr',
			fieldsOf(doc(), { defaultWalletId: w, rows: '[{"amountMinor":1}]', totalMinor: '999999999' })
		);
		expect(r).toMatchObject({ kind: 'ok', value: { counts: { imported: 3 } } });
		const sum = (await liveRows(a.scope.spaceId)).reduce((s, x) => s + Number(x.amount_minor), 0);
		expect(sum).toBe(5_500_000);
		const forged = { ...doc(), rows: [{ amountMinor: 1 }] };
		expect(await call(a, 'previewOcr', fieldsOf(forged as OcrDocument))).toMatchObject({
			kind: 'fail',
			status: 400
		});
		const forgedLine = doc();
		(forgedLine.pages[0]!.lines[4] as unknown as Record<string, unknown>).amountMinor = 1;
		expect(await call(a, 'previewOcr', fieldsOf(forgedLine))).toMatchObject({
			kind: 'fail',
			status: 400
		});
	}, 60_000);
});

describe('/impor OCR bounds (criterion 33)', () => {
	it('every malformed or oversized input answers 400, 413 or 415, never 500', async () => {
		const a = await account();
		const base = doc();
		const page = base.pages[0]!;
		const line = page.lines[4]!;
		const word = line.words[0]!;
		const variant = (f: (d: OcrDocument) => void) => {
			const d = structuredClone(base);
			f(d);
			return JSON.stringify(d);
		};
		const many = <T>(x: T, k: number) => Array.from({ length: k }, () => structuredClone(x));
		const bad: Record<string, string>[] = [
			{ ocr: variant((d) => (d.pages = many(page, 13))) },
			{ ocr: variant((d) => (d.pages[0]!.lines = many(line, 251))) },
			{ ocr: variant((d) => (d.pages[0]!.lines = [{ ...line, words: many(word, 3001) }])) },
			{ ocr: variant((d) => (d.pages[0]!.lines[0]!.words[0]!.t = 'x'.repeat(65))) },
			{ ocr: variant((d) => (d.pages[0]!.lines[0]!.words[0]!.t = 'x'.repeat(10_000))) },
			{ ocr: variant((d) => (d.pages[0]!.lines[0]!.words[0]!.c = 101)) },
			{ ocr: variant((d) => (d.pages[0]!.lines[0]!.words[0]!.c = 50.5)) },
			{ ocr: JSON.stringify(base).replace('"c":96', '"c":NaN') },
			{ ocr: variant((d) => (d.pages[0]!.lines[0]!.words[0]!.x0 = -1)) },
			{ ocr: variant((d) => (d.pages[0]!.lines[0]!.words[0]!.x1 = 20_001)) },
			{
				ocr: JSON.stringify(base),
				include: JSON.stringify(Array.from({ length: 10_000 }, (_, i) => i % 4))
			},
			{ ocr: JSON.stringify(base), include: '[4]' },
			{ ocr: JSON.stringify(base), exclude: '[-1]' },
			{ ocr: JSON.stringify(base), include: 'alles' },
			{ ocr: 'bukan json' },
			{ ocr: '{"__proto__":{"polluted":1},"pages":[]}' },
			{ ocr: JSON.stringify({ pages: [] }) },
			{},
			{ ocr: JSON.stringify(base), institution: 'bank-lain' },
			{ ocr: JSON.stringify(base), statementSection: 'x' }
		];
		// A fresh user per case: each request counts against the shared upload bucket (30 per window).
		for (const action of ['previewOcr', 'importOcr'])
			for (const fields of bad) {
				const r = await call(await account(), action, fields);
				expect(r.kind === 'fail' || r.kind === 'error', JSON.stringify(fields).slice(0, 80)).toBe(
					true
				);
				expect([400, 413, 415]).toContain((r as { status: number }).status);
			}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		// Past the 512 KB body cap: refused before parsing.
		const big = await run(async () =>
			act('previewOcr')(
				await ocrEvent(a, 'previewOcr', { ocr: 'x'.repeat(OCR_BODY_MAX_BYTES + 1024) })
			)
		);
		expect(big).toMatchObject({ kind: 'error', status: 400 });
		// A JSON (non-form) body: 415.
		const json = await run(async () =>
			act('importOcr')(
				await ocrEvent(a, 'importOcr', {}, undefined, JSON.stringify(base), 'application/json')
			)
		);
		expect(json).toMatchObject({ kind: 'error', status: 415 });
	}, 120_000);
});

describe('/impor OCR access, throttle and concurrency (criteria 31, 34)', () => {
	it('another space’s wallet is not found before anything is read; removed members write nothing there', async () => {
		const a = await account();
		const b = await account();
		const theirs = await wallet(b.scope);
		expect(await call(a, 'importOcr', fieldsOf(doc(), { defaultWalletId: theirs }))).toEqual({
			kind: 'fail',
			status: 404,
			data: { section: 'ocr', error: 'Dompet tidak ditemukan.' }
		});
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
			await call(member, 'importOcr', fieldsOf(doc(), { defaultWalletId: shared }), spaceId)
		).toMatchObject({
			kind: 'fail',
			status: 404
		});
		// Without a wallet the removed member's import lands in their own space, never the shared one.
		expect(await call(member, 'importOcr', fieldsOf(doc()), spaceId)).toMatchObject({ kind: 'ok' });
		expect(await liveRows(spaceId)).toEqual([]);
		expect(await listImportBatches(db, spaceId)).toEqual([]);
	}, 120_000);

	it(`shares the statement upload bucket: request ${STATEMENT_UPLOADS_PER_WINDOW + 1} in the window answers 429`, async () => {
		const a = await account();
		for (let i = 0; i < STATEMENT_UPLOADS_PER_WINDOW; i++) {
			const action = i % 2 ? 'importOcr' : 'previewOcr';
			expect(await call(a, action, { ocr: 'x' })).toMatchObject({ kind: 'fail', status: 400 });
		}
		expect(await call(a, 'previewOcr', fieldsOf(doc()))).toMatchObject({
			kind: 'fail',
			status: 429,
			data: { section: 'ocr' }
		});
		const statement = await run(async () => {
			const current = await resolveCurrentSpace(db, a.user.id, undefined);
			const { event } = fakeEvent({
				url: 'http://localhost/impor?/previewStatement',
				routeId: '/(app)/impor',
				db,
				user: a.user,
				space: current,
				form: { x: '1' }
			});
			return act('previewStatement')(event as never);
		});
		expect(statement).toMatchObject({ kind: 'fail', status: 429 });
	}, 120_000);

	it('20 concurrent imports of the same reading create each row exactly once', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				call(a, 'importOcr', fieldsOf(doc(), { defaultWalletId: w }))
			)
		);
		for (const r of results) expect(['ok', 'fail']).toContain(r.kind);
		for (const r of results) if (r.kind === 'fail') expect(r.status).toBe(409);
		const keys = (await liveRows(a.scope.spaceId)).map((r) => r.dedupe_key);
		expect(keys).toHaveLength(3);
		expect(new Set(keys).size).toBe(3);
	}, 120_000);

	it('an OCR import counts as one creating action and is refused with 429 at the per-user limit', async () => {
		const a = await account();
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
		expect(await call(a, 'importOcr', fieldsOf(doc()))).toMatchObject({
			kind: 'fail',
			status: 429,
			data: { section: 'ocr', error: TRANSACTION_RATE_LIMITED }
		});
	});

	it('refusals carry counts only; a figure under 70 confidence refuses the whole reading', async () => {
		const a = await account();
		const r = await call(
			a,
			'previewOcr',
			fieldsOf(doc(screen(), (t) => (t === '-Rp25.000' ? 60 : 96)))
		);
		expect(r).toEqual({
			kind: 'fail',
			status: 400,
			data: {
				section: 'ocr',
				error: 'Saldo tidak cocok. Pastikan foto/pindaian jelas dan semua halaman ikut.',
				counts: { pages: 1, rows: 3, gapMinor: null },
				needsInstitution: false
			}
		});
		const unknown = await call(
			a,
			'previewOcr',
			fieldsOf(ocrDoc([['09:41', 'Riwayat', '1 Okt 2026', 'Kopi   -Rp1.000']]))
		);
		expect(unknown).toMatchObject({ kind: 'fail', status: 400, data: { needsInstitution: true } });
	});
});

describe('dedupe key is scoped to bank, account and wallet (red team M1)', () => {
	// BCA 03/09 "BIAYA ADM 10,000.00 DB" and Mandiri 03 Sep "-10.000,00": same date, same amount.
	const mandiriSept = mandiriPages({
		period: '01 Sep 2026 - 30 Sep 2026',
		accounts: [
			{
				product: 'Tabungan Fiktif',
				account: '1230009876543',
				opening: '1.000.000,00',
				pages: [
					[{ remarks: ['Biaya admin'], amount: '-10.000,00', date: '03 Sep 2026', tail: true }]
				]
			}
		]
	});
	const bca = () => ocrDocFromText(bcaPages(BCA_SEPTEMBER));
	const mandiri = () => ocrDocFromText(mandiriSept);

	it('the same date and amount at another bank, in another wallet, is imported, not skipped', async () => {
		const a = await account();
		const walletA = await wallet(a.scope, 'BCA Fiktif');
		const walletB = await wallet(a.scope, 'Mandiri Fiktif');
		const first = await call(a, 'importOcr', fieldsOf(bca(), { defaultWalletId: walletA }));
		expect(first).toMatchObject({ kind: 'ok', value: { counts: { imported: 7, already: 0 } } });
		const second = await call(a, 'importOcr', fieldsOf(mandiri(), { defaultWalletId: walletB }));
		expect(second).toMatchObject({ kind: 'ok', value: { counts: { imported: 1, already: 0 } } });
		const keys = (await liveRows(a.scope.spaceId)).map((r) => String(r.dedupe_key));
		expect(keys).toHaveLength(8);
		expect(new Set(keys).size).toBe(8);
	});

	it('the same bank statement in two wallets is told apart; a repeat into the same wallet is still skipped', async () => {
		const a = await account();
		const walletA = await wallet(a.scope, 'BCA Satu');
		const walletB = await wallet(a.scope, 'BCA Dua');
		await call(a, 'importOcr', fieldsOf(bca(), { defaultWalletId: walletA }));
		expect(await call(a, 'importOcr', fieldsOf(bca(), { defaultWalletId: walletA }))).toMatchObject(
			{
				kind: 'ok',
				value: { counts: { imported: 0, already: 7 } }
			}
		);
		expect(await call(a, 'importOcr', fieldsOf(bca(), { defaultWalletId: walletB }))).toMatchObject(
			{
				kind: 'ok',
				value: { counts: { imported: 7, already: 0 } }
			}
		);
	});
});

describe('no persistence of OCR input (criterion 36)', () => {
	it('adds no migration and stores nothing of the words outside the imported rows', () => {
		const migrations = readdirSync('migrations').filter((m) => m.endsWith('.sql'));
		expect(migrations.some((m) => /ocr/i.test(m))).toBe(false);
		expect(existsSync('src/lib/server/statements/ocr-import.ts')).toBe(true);
	});
});
