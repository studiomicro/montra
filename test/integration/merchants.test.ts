import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveKey } from '#lib/server/ai-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import {
	ensurePresetCategories,
	listCategories,
	setCategoryHidden
} from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { listPendingDrafts, setDraftsCategory } from '#lib/server/drafts/repo';
import { importCsv } from '#lib/server/imports/csv-import';
import { captureDraft, type Capture } from '#lib/server/inbound/draft';
import { draftHints } from '#lib/server/merchants/drafts';
import { learnFromCorrection } from '#lib/server/merchants/learn';
import { deleteRule, listRules } from '#lib/server/merchants/repo';
import {
	MERCHANT_AI_CALLS_PER_HOUR,
	resolveMerchants,
	RESOLVE_BATCH_MAX
} from '#lib/server/merchants/resolve';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { createTransaction, deleteTransaction } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { base64urlEncode } from '#lib/shared/base64url';
import { TEMPLATE_COLUMNS } from '#lib/shared/csv';
import { wibTodayString } from '#lib/shared/dates';
import type { CategoryKind } from '#lib/shared/transactions';
import { applyMigration, openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-20 merchant recognition against a local D1. The AI step only ever meets an injected fetch double (the
 * merchants/ai module's fetch is replaced below): these tests prove ordering, scoping, caching, limits and
 * privacy; they never count as a working AI path (PRD AC-25 stays NOT verified).
 */

const { fakeFetch } = vi.hoisted(() => ({
	fakeFetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
}));
vi.mock('#lib/server/merchants/ai', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/merchants/ai')>();
	return {
		...actual,
		classifyMerchants: (
			env: Parameters<typeof actual.classifyMerchants>[0],
			key: string,
			kind: CategoryKind,
			keys: readonly string[],
			categories: Parameters<typeof actual.classifyMerchants>[4],
			_fetch?: typeof fetch,
			timeoutMs?: number
		) =>
			actual.classifyMerchants(
				env,
				key,
				kind,
				keys,
				categories,
				fakeFetch as unknown as typeof fetch,
				timeoutMs
			)
	};
});

const ENC = base64urlEncode(new Uint8Array(32).fill(23));
const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const pedagang = await import('../../src/routes/(app)/pengaturan/pedagang/+page.server');
const saran = await import('../../src/routes/(app)/riwayat/saran/+server');
const periksa = await import('../../src/routes/(app)/kotak-masuk/periksa/+page.server');
const suara = await import('../../src/routes/(app)/riwayat/suara/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'pedagang-pagi-2026';
const GATEWAY = { AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', AI_GATEWAY_ID: 'gw' };

function configure(o: { gateway?: boolean } = {}) {
	for (const k of Object.keys(binding)) delete binding[k];
	binding.DB = d1;
	binding.AI_KEYS_ENCRYPTION_KEY = ENC;
	if (o.gateway !== false) Object.assign(binding, GATEWAY);
}

/** A Messages answer classifying every key the request named into the first offered category ref. */
function answerAll(categoryRef: string | null = 'c1') {
	return async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
		const prompt = JSON.parse(body.messages[0]!.content) as { descriptors: string[] };
		const results = prompt.descriptors.map((key) => ({
			key,
			category: categoryRef,
			merchant_name: null
		}));
		return new Response(
			JSON.stringify({
				content: [{ type: 'text', text: JSON.stringify({ results }) }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 1, output_tokens: 1 }
			}),
			{ status: 200 }
		);
	};
}

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());
beforeEach(() => {
	configure();
	fakeFetch.mockReset();
	fakeFetch.mockImplementation(answerAll());
});

let n = 0;
async function person(o: { key?: boolean } = {}) {
	const email = `pedagang${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const user = { id: r.userId, email, name: 'Uji', createdAt: 0 };
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope = { spaceId: space.id, userId: r.userId };
	await ensurePresetCategories(db, space.id);
	const wallet = await createWallet(
		db,
		scope,
		{
			name: 'Tunai',
			type: 'tunai',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		Date.now()
	);
	if (!wallet.ok) throw new Error('wallet failed');
	if (o.key !== false)
		await saveKey(
			db,
			r.userId,
			'anthropic',
			`sk-ant-api03-synthetic-${String(n).padStart(4, '0')}-AbCdEfGh`,
			binding as never,
			Date.now()
		);
	const cats = await listCategories(db, space.id);
	const cat = (tile: string) => cats.find((c) => c.tileKey === tile)!.id;
	return { user, scope, space, walletId: wallet.id, cat };
}
type Person = Awaited<ReturnType<typeof person>>;

const resolve = (p: Person, items: { rawText: string; type?: CategoryKind }[], allowAi = false) =>
	resolveMerchants(
		db,
		p.scope,
		items.map((i) => ({ rawText: i.rawText, type: i.type ?? 'expense' })),
		{ userId: p.user.id, allowAi, env: binding as never }
	);

async function spend(p: Person, title: string, categoryId: string, type: CategoryKind = 'expense') {
	const r = await createTransaction(
		db,
		p.scope,
		{
			type,
			amountMinor: 2_500_000,
			currency: 'IDR',
			walletId: p.walletId,
			transferToWalletId: null,
			categoryId,
			title,
			note: null,
			occurredOn: wibTodayString(),
			occurredTime: '12:00'
		},
		Date.now()
	);
	if (!r.ok) throw new Error('tx failed');
	return r.id;
}

const ruleCount = async (spaceId: string) =>
	(
		await db.all<{ n: number }>(
			sql`select count(*) as n from merchant_rules where space_id = ${spaceId} and deleted_at is null`
		)
	)[0]!.n;
const cacheCount = async (spaceId: string) =>
	(
		await db.all<{ n: number }>(
			sql`select count(*) as n from merchant_cache where space_id = ${spaceId}`
		)
	)[0]!.n;

describe('layer order and reasons (AC-2, AC-3, AC-4, AC-7)', () => {
	it('dictionary and keyword layers; income words only for income rows', async () => {
		const p = await person();
		const { items } = await resolve(p, [
			{ rawText: 'QRIS*KOPI KENANGAN JKT 0812 3456 7890' },
			{ rawText: 'GOPAY-GOJEK 5/10' },
			{ rawText: 'TRSF E-BANKING DB 1234/FTSCY/WS95031 GAJI OKT', type: 'income' },
			{ rawText: 'TRSF E-BANKING DB 1234/FTSCY/WS95031 GAJI OKT', type: 'expense' },
			{ rawText: 'KOPITIAM SENJA' },
			{ rawText: 'GRABBER SHOP' }
		]);
		expect(items.map((i) => [i.merchant, i.categoryId, i.reason])).toEqual([
			['Kopi Kenangan', p.cat('kopi'), 'keyword'],
			['Gojek', p.cat('ojek-online'), 'keyword'],
			['Gaji Okt', p.cat('gaji'), 'dictionary'],
			// FN-48: no salary word for an expense, but the bank code says it is a transfer.
			['Gaji Okt', p.cat('transfer'), 'narrative'],
			['Kopitiam Senja', p.cat('kopi'), 'dictionary'],
			['Grabber Shop', null, 'none']
		]);
	});

	it('Ojek Online falls back to Transportasi when the space hides that preset', async () => {
		const p = await person();
		await setCategoryHidden(db, p.scope, p.cat('ojek-online'), true, Date.now());
		const { items } = await resolve(p, [{ rawText: 'GOJEK' }]);
		expect(items[0]).toMatchObject({ categoryId: p.cat('transportasi'), reason: 'keyword' });
	});

	it('rule beats history beats cache beats keyword (each layer removed in turn)', async () => {
		const p = await person();
		const raw = 'QRIS*KOPI KENANGAN JKT';
		const now = Date.now();
		await d1
			.prepare(
				`insert into merchant_cache (space_id, match_key, kind, merchant_name, category_id, reason, created_at, expires_at)
				values (?, 'kopi kenangan', 'expense', null, ?, 'ai', ?, ?)`
			)
			.bind(p.scope.spaceId, p.cat('belanja'), now, now + 1e9)
			.run();
		expect((await resolve(p, [{ rawText: raw }])).items[0]).toMatchObject({
			categoryId: p.cat('belanja'),
			reason: 'cache'
		});
		await spend(p, 'Kopi Kenangan', p.cat('makan'));
		expect((await resolve(p, [{ rawText: raw }])).items[0]).toMatchObject({
			categoryId: p.cat('makan'),
			reason: 'history'
		});
		await learnFromCorrection(
			db,
			p.scope,
			{ descriptor: raw, kind: 'expense', categoryId: p.cat('hiburan') },
			now
		);
		expect((await resolve(p, [{ rawText: raw }])).items[0]).toMatchObject({
			categoryId: p.cat('hiburan'),
			reason: 'rule',
			confidence: 1
		});
	});

	it('history: most frequent category, ties to the most recent; tombstones, transfers and other spaces ignored', async () => {
		const p = await person();
		const other = await person();
		await spend(p, 'QRIS*TOKO SENJA 123456', p.cat('belanja'));
		await spend(p, 'Toko Senja', p.cat('belanja'));
		await spend(p, 'TOKO SENJA JKT', p.cat('belanja'));
		const gone = await spend(p, 'Toko Senja', p.cat('makan'));
		await spend(p, 'Toko Senja', p.cat('makan'));
		const tx = await d1
			.prepare('select updated_at from transactions where id = ?')
			.bind(gone)
			.first<{ updated_at: number }>();
		await deleteTransaction(db, p.scope, gone, tx!.updated_at, Date.now(), binding as never);
		// The other space's frequent use of another category never leaks in.
		for (let i = 0; i < 5; i++) await spend(other, 'Toko Senja', other.cat('hiburan'));
		expect((await resolve(p, [{ rawText: 'TOKO SENJA' }])).items[0]).toMatchObject({
			categoryId: p.cat('belanja'),
			reason: 'history'
		});
		// A tie (one each) goes to the most recent row.
		const q = await person();
		await spend(q, 'Warung Sore', q.cat('makan'));
		await spend(q, 'Warung Sore', q.cat('belanja'));
		expect((await resolve(q, [{ rawText: 'Warung Sore' }])).items[0]).toMatchObject({
			categoryId: q.cat('belanja'),
			reason: 'history'
		});
	});

	it('a rule whose category was hidden is skipped and listed as unavailable (AC-7)', async () => {
		const p = await person();
		await learnFromCorrection(
			db,
			p.scope,
			{ descriptor: 'KOPI SENJA', kind: 'expense', categoryId: p.cat('hiburan') },
			Date.now()
		);
		await setCategoryHidden(db, p.scope, p.cat('hiburan'), true, Date.now());
		expect((await resolve(p, [{ rawText: 'KOPI SENJA' }])).items[0]).toMatchObject({
			categoryId: p.cat('kopi'),
			reason: 'keyword'
		});
		const [rule] = await listRules(db, p.scope.spaceId);
		expect(rule).toMatchObject({ merchantName: 'Kopi Senja', category: null });
	});
});

describe('learning (AC-5, AC-6)', () => {
	it('a draft correction creates the rule; a second one updates it (hits + 1), never a duplicate', async () => {
		const p = await person();
		const capture = (merchant: string): Capture => ({
			recipient: p.scope,
			direction: 'expense',
			amountMinor: 1_500_000,
			merchant,
			occurredOn: wibTodayString(),
			occurredAt: Date.now(),
			reference: null,
			trust: 'verified',
			parser: 'ai',
			dedupeKey: `mail:m:${crypto.randomUUID()}`
		});
		const ledger = () => ({ kind: 'queued' as const, mailId: 'none', now: Date.now() });
		await captureDraft(db, capture('QRIS*TOKO BUKU PELANGI 0812345678'), ledger());
		const [draft] = await listPendingDrafts(db, p.scope.spaceId);
		expect(draft).toMatchObject({ title: 'Toko Buku Pelangi', categoryId: null });
		const r = await setDraftsCategory(
			db,
			p.scope,
			[{ id: draft!.id, updatedAt: draft!.updatedAt }],
			p.cat('pendidikan'),
			Date.now()
		);
		expect(r).toMatchObject({ ok: true });
		const rules = await listRules(db, p.scope.spaceId);
		expect(rules).toMatchObject([{ merchantName: 'Toko Buku Pelangi', hits: 1 }]);
		// The next capture of that descriptor shows "Dari aturanmu".
		await captureDraft(db, capture('POS TOKO BUKU PELANGI JKT'), ledger());
		const drafts = await listPendingDrafts(db, p.scope.spaceId);
		const next = drafts.find((d) => d.id !== draft!.id)!;
		expect(next.categoryId).toBe(p.cat('pendidikan'));
		expect((await draftHints(db, p.scope, drafts)).reasons).toMatchObject({ [next.id]: 'rule' });
		// A second correction to another category updates the same rule.
		await setDraftsCategory(
			db,
			p.scope,
			[{ id: next.id, updatedAt: next.updatedAt }],
			p.cat('belanja'),
			Date.now()
		);
		expect(await listRules(db, p.scope.spaceId)).toMatchObject([
			{ hits: 2, category: { id: p.cat('belanja') } }
		]);
		expect(await ruleCount(p.scope.spaceId)).toBe(1);
	});

	it('20 concurrent corrections of one merchant leave exactly one live rule', async () => {
		const p = await person();
		const cats = ['kopi', 'makan', 'belanja', 'hiburan'];
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				learnFromCorrection(
					db,
					p.scope,
					{ descriptor: 'KEDAI SENJA', kind: 'expense', categoryId: p.cat(cats[i % 4]!) },
					Date.now()
				)
			)
		);
		expect(await ruleCount(p.scope.spaceId)).toBe(1);
		expect((await listRules(db, p.scope.spaceId))[0]!.hits).toBe(20);
	});

	it("A's correction never changes B's resolution; another space's category is refused", async () => {
		const a = await person();
		const b = await person();
		await learnFromCorrection(
			db,
			a.scope,
			{ descriptor: 'KEDAI PAGI', kind: 'expense', categoryId: a.cat('hiburan') },
			Date.now()
		);
		expect((await resolve(b, [{ rawText: 'KEDAI PAGI' }])).items[0]).toMatchObject({
			categoryId: null,
			reason: 'none'
		});
		// B cannot teach its space a category of A's space.
		expect(
			await learnFromCorrection(
				db,
				b.scope,
				{ descriptor: 'KEDAI PAGI', kind: 'expense', categoryId: a.cat('hiburan') },
				Date.now()
			)
		).toBe(false);
		expect(await ruleCount(b.scope.spaceId)).toBe(0);
	});
});

describe('AI step with a stubbed provider (AC-8 – AC-11; MOCKED, never counts as working)', () => {
	it('no key, unreadable key or no gateway: no network call, deterministic layers still work', async () => {
		const p = await person({ key: false });
		const r = await resolve(p, [{ rawText: 'TOKO ANEH' }, { rawText: 'KOPI SENJA' }], true);
		expect(r.ai).toBe('no_key');
		expect(r.items.map((i) => i.reason)).toEqual(['none', 'keyword']);
		const q = await person();
		configure({ gateway: false });
		expect((await resolve(q, [{ rawText: 'TOKO ANEH' }], true)).ai).toBe('not_configured');
		configure();
		binding.AI_KEYS_ENCRYPTION_KEY = base64urlEncode(new Uint8Array(32).fill(99));
		expect((await resolve(q, [{ rawText: 'TOKO ANEH' }], true)).ai).toBe('no_key');
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('60 distinct descriptors: 2 requests (≤ 40 each), duplicates sent once, cached; a repeat makes no call', async () => {
		const p = await person();
		const descriptors = Array.from(
			{ length: 60 },
			(_, i) =>
				`QRIS*TOKO ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))} 081234567890 28.000`
		);
		const items = [...descriptors, ...descriptors.slice(0, 5)].map((rawText) => ({ rawText }));
		const r = await resolve(p, items, true);
		expect(r.ai).toBe('used');
		expect(fakeFetch).toHaveBeenCalledTimes(2);
		const sent = fakeFetch.mock.calls.map(([, init]) => {
			const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
			return JSON.parse(body.messages[0]!.content) as { descriptors: string[] };
		});
		expect(sent.map((s) => s.descriptors.length)).toEqual([40, 20]);
		expect(new Set(sent.flatMap((s) => s.descriptors)).size).toBe(60);
		for (const [, init] of fakeFetch.mock.calls) {
			const body = String(init.body);
			expect(body).not.toMatch(/\d{6,}/);
			expect(body).not.toContain('28.000');
			// The wallet's name ("Tunai"), never a category name that contains it ("Tarik Tunai").
			expect(body).not.toContain('"Tunai"');
			expect(body).not.toContain(wibTodayString());
			expect(body).not.toContain(p.walletId);
		}
		expect(r.items.every((i) => i.reason === 'ai' && i.categoryId === p.cat('kopi'))).toBe(true);
		expect(await cacheCount(p.scope.spaceId)).toBe(60);
		fakeFetch.mockClear();
		const again = await resolve(p, items, true);
		expect(fakeFetch).not.toHaveBeenCalled();
		expect(again.items.every((i) => i.reason === 'cache')).toBe(true);
		// The cache holds only cleaned keys: no digits runs, no amounts.
		const keys = await db.all<{ k: string }>(
			sql`select match_key as k from merchant_cache where space_id = ${p.scope.spaceId}`
		);
		expect(keys.every(({ k }) => !/\d{3}/.test(k))).toBe(true);
	});

	it('an unknown ref, invalid JSON, 5xx or a timeout: none, nothing cached, nothing crashes (AC-10)', async () => {
		const p = await person();
		fakeFetch.mockImplementation(answerAll('c999'));
		const unknown = await resolve(p, [{ rawText: 'TOKO SATU' }], true);
		expect(unknown.items[0]).toMatchObject({ categoryId: null, reason: 'none' });
		fakeFetch.mockImplementation(async () => new Response('{"type":"error"}', { status: 500 }));
		const failed = await resolve(p, [{ rawText: 'TOKO DUA' }], true);
		expect(failed).toMatchObject({ ai: 'failed', items: [{ categoryId: null, reason: 'none' }] });
		fakeFetch.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ content: [{ type: 'text', text: '{oops' }], stop_reason: 'end_turn' })
				)
		);
		expect((await resolve(p, [{ rawText: 'TOKO TIGA' }], true)).ai).toBe('failed');
		// Only the valid (unknown-ref → null) answer was cached; the failures were not.
		const rows = await db.all<{ k: string; c: string | null }>(
			sql`select match_key as k, category_id as c from merchant_cache where space_id = ${p.scope.spaceId}`
		);
		expect(rows).toEqual([{ k: 'toko satu', c: null }]);
		const categories = await listCategories(db, p.scope.spaceId, { includeHidden: true });
		expect(categories).toHaveLength(24);
	});

	it(`the ${MERCHANT_AI_CALLS_PER_HOUR + 1}st AI call in an hour makes no provider call and falls back (AC-11)`, async () => {
		const p = await person();
		for (let i = 0; i < MERCHANT_AI_CALLS_PER_HOUR; i++)
			expect(
				(await resolve(p, [{ rawText: `TOKO NOMOR ${String.fromCharCode(65 + i)}` }], true)).ai
			).toBe('used');
		expect(fakeFetch).toHaveBeenCalledTimes(MERCHANT_AI_CALLS_PER_HOUR);
		const over = await resolve(p, [{ rawText: 'TOKO TERAKHIR' }, { rawText: 'KOPI SORE' }], true);
		expect(over.ai).toBe('rate_limited');
		expect(over.items.map((i) => i.reason)).toEqual(['none', 'keyword']);
		expect(fakeFetch).toHaveBeenCalledTimes(MERCHANT_AI_CALLS_PER_HOUR);
	});

	it('an accepted AI suggestion writes no rule (owner decision 5)', async () => {
		const p = await person();
		await resolve(p, [{ rawText: 'TOKO EMPAT' }], true);
		expect(await ruleCount(p.scope.spaceId)).toBe(0);
	});
});

describe('bounds (AC-18, AC-19)', () => {
	it('150 distinct keys resolve in one call (json_each binding, no 100-parameter failure)', async () => {
		const p = await person();
		const items = Array.from({ length: 150 }, (_, i) => ({
			rawText: `KEDAI ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`
		}));
		for (const it of items.slice(0, 101))
			await learnFromCorrection(
				db,
				p.scope,
				{ descriptor: it.rawText, kind: 'expense', categoryId: p.cat('makan') },
				Date.now()
			);
		const { items: out } = await resolve(p, items);
		expect(out.filter((i) => i.reason === 'rule')).toHaveLength(101);
	});

	it(`item ${RESOLVE_BATCH_MAX + 1} is not resolved`, async () => {
		const p = await person();
		const items = Array.from({ length: RESOLVE_BATCH_MAX + 1 }, () => ({ rawText: 'KOPI SENJA' }));
		const { items: out } = await resolve(p, items);
		expect(out).toHaveLength(RESOLVE_BATCH_MAX + 1);
		expect(out[RESOLVE_BATCH_MAX - 1]!.reason).toBe('keyword');
		expect(out[RESOLVE_BATCH_MAX]).toMatchObject({ reason: 'none', categoryId: null });
	});

	it('a 60-character search uses instr, not LIKE', async () => {
		const p = await person();
		await learnFromCorrection(
			db,
			p.scope,
			{ descriptor: 'KEDAI KOPI SENJA', kind: 'expense', categoryId: p.cat('kopi') },
			Date.now()
		);
		expect(await listRules(db, p.scope.spaceId, 'x'.repeat(60))).toEqual([]);
		expect(await listRules(db, p.scope.spaceId, 'senja')).toHaveLength(1);
	});
});

describe('captures and imports (AC-13, AC-14)', () => {
	it('CSV: an explicit category cell wins; else the resolver; else the old fallback', async () => {
		const p = await person();
		await learnFromCorrection(
			db,
			p.scope,
			{ descriptor: 'TOKO PELANGI', kind: 'expense', categoryId: p.cat('hiburan') },
			Date.now()
		);
		const today = wibTodayString();
		const file = [
			TEMPLATE_COLUMNS.join(','),
			`${today},expense,TOKO PELANGI,25000,IDR,Kantor,,,,,Tunai,`,
			`${today},expense,QRIS*TOKO PELANGI JKT,25000,IDR,,,,,,Tunai,`,
			`${today},expense,INDOMARET 1234,25000,IDR,,,,,,Tunai,`,
			`${today},expense,TOKO ANEH,25000,IDR,,,,,,Tunai,`,
			`${today},income,PAYROLL PT CONTOH,25000,IDR,,,,,,Tunai,`
		].join('\n');
		const r = await importCsv(
			db,
			p.scope,
			{
				fileText: file,
				filename: 'f.csv',
				format: null,
				defaultWalletId: p.walletId,
				skipPossibleDuplicates: false
			},
			Date.now()
		);
		expect(r).toMatchObject({ ok: true, counts: { imported: 5 } });
		const { results } = await d1
			.prepare(
				`select t.title, c.name from transactions t join categories c on c.id = t.category_id
				where t.space_id = ? and t.deleted_at is null order by t.created_at, t.rowid`
			)
			.bind(p.scope.spaceId)
			.all<{ title: string; name: string }>();
		expect(results.map((x) => [x.title, x.name])).toEqual([
			['TOKO PELANGI', 'Kantor'],
			['QRIS*TOKO PELANGI JKT', 'Hiburan'],
			['INDOMARET 1234', 'Belanja Harian'],
			['TOKO ANEH', 'Lainnya'],
			['PAYROLL PT CONTOH', 'Gaji']
		]);
		// No AI env was given: no call.
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('forwarded capture: cleaned title, resolved category, the original text in the note; unknown gets none', async () => {
		const p = await person();
		const base = {
			recipient: p.scope,
			direction: 'expense' as const,
			amountMinor: 2_800_000,
			occurredOn: wibTodayString(),
			occurredAt: Date.now(),
			reference: null,
			trust: 'verified' as const,
			parser: 'bank-qris' as Capture['parser']
		};
		const ledger = () => ({ kind: 'queued' as const, mailId: 'none', now: Date.now() });
		await captureDraft(
			db,
			{ ...base, merchant: 'QRIS*KOPI KENANGAN JKT', dedupeKey: 'mail:m:a' },
			ledger()
		);
		await captureDraft(db, { ...base, merchant: 'TOKO ANEH', dedupeKey: 'mail:m:b' }, ledger());
		const drafts = await listPendingDrafts(db, p.scope.spaceId);
		const kopi = drafts.find((d) => d.title === 'Kopi Kenangan')!;
		expect(kopi.categoryId).toBe(p.cat('kopi'));
		expect(kopi.note).toContain('QRIS*KOPI KENANGAN JKT');
		const aneh = drafts.find((d) => d.title === 'Toko Aneh')!;
		expect(aneh.categoryId).toBeNull();
		// Replay: same dedupe key, no second draft.
		await captureDraft(
			db,
			{ ...base, merchant: 'QRIS*KOPI KENANGAN JKT', dedupeKey: 'mail:m:a' },
			ledger()
		);
		expect(await listPendingDrafts(db, p.scope.spaceId)).toHaveLength(2);
	});
});

type Action = (e: never) => Promise<unknown>;
async function run(fn: () => Promise<unknown>) {
	try {
		const value = await fn();
		if (isActionFailure(value)) return { kind: 'fail', status: value.status, data: value.data };
		return { kind: 'ok', value };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect', location: e.location };
		if (isHttpError(e)) return { kind: 'error', status: e.status, body: e.body };
		throw e;
	}
}
const spaceOf = (p: Person) =>
	({
		id: p.space.id,
		name: p.space.name,
		kind: p.space.kind,
		role: p.space.role
	}) as App.Locals['space'];

describe('routes (AC-6, AC-8, AC-15, AC-17)', () => {
	it('settings: lists only this space, searches, deletes one (stale and foreign ids refused alike), deletes all', async () => {
		const a = await person();
		const b = await person();
		for (const d of ['KEDAI SATU', 'KEDAI DUA'])
			await learnFromCorrection(
				db,
				a.scope,
				{ descriptor: d, kind: 'expense', categoryId: a.cat('makan') },
				Date.now()
			);
		await learnFromCorrection(
			db,
			b.scope,
			{ descriptor: 'KEDAI LAIN', kind: 'expense', categoryId: b.cat('makan') },
			Date.now()
		);
		const load = (p: Person, q = '') => {
			const { event } = fakeEvent({
				url: `http://localhost/pengaturan/pedagang${q ? `?q=${q}` : ''}`,
				db,
				user: p.user,
				space: spaceOf(p)
			});
			return pedagang.load(event as never) as Promise<{
				rules: { id: string; updatedAt: number }[];
			}>;
		};
		expect((await load(a)).rules).toHaveLength(2);
		expect((await load(a, 'dua')).rules).toHaveLength(1);
		const [bRule] = (await load(b)).rules;
		const del = (p: Person, form: Record<string, string>) => {
			const { event } = fakeEvent({
				url: 'http://localhost/pengaturan/pedagang?/hapus',
				db,
				user: p.user,
				space: spaceOf(p),
				form
			});
			return run(() => (pedagang.actions as Record<string, Action>).hapus!(event as never));
		};
		// B's rule id from A's session: the same 404 as an unknown id.
		const foreign = await del(a, { id: bRule!.id, updatedAt: String(bRule!.updatedAt) });
		const unknown = await del(a, { id: crypto.randomUUID(), updatedAt: '1' });
		expect(foreign).toEqual(unknown);
		expect(foreign).toMatchObject({ kind: 'fail', status: 404 });
		const [first] = (await load(a)).rules;
		expect(await del(a, { id: first!.id, updatedAt: '1' })).toMatchObject({
			kind: 'fail',
			status: 409
		});
		expect(await del(a, { id: first!.id, updatedAt: String(first!.updatedAt) })).toMatchObject({
			kind: 'ok'
		});
		expect((await load(a)).rules).toHaveLength(1);
		const all = (form: Record<string, string>) => {
			const { event } = fakeEvent({
				url: 'http://localhost/pengaturan/pedagang?/hapusSemua',
				db,
				user: a.user,
				space: spaceOf(a),
				form
			});
			return run(() => (pedagang.actions as Record<string, Action>).hapusSemua!(event as never));
		};
		expect(await all({ x: '1' })).toMatchObject({ kind: 'fail', status: 400 });
		expect(await all({ confirm: '1' })).toEqual({
			kind: 'redirect',
			location: '/pengaturan/pedagang?dihapus=1'
		});
		expect((await load(a)).rules).toEqual([]);
		expect((await load(b)).rules).toHaveLength(1);
		// A deleted rule no longer answers; the same key may be learned again after the tombstone.
		expect((await resolve(a, [{ rawText: 'KEDAI SATU' }])).items[0]!.reason).toBe('none');
		expect(
			await learnFromCorrection(
				db,
				a.scope,
				{ descriptor: 'KEDAI SATU', kind: 'expense', categoryId: a.cat('makan') },
				Date.now()
			)
		).toBe(true);
	});

	it('a removed member gets the same 404 as a stranger on the page, delete and suggestion routes', async () => {
		const owner = await person();
		const member = await person();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const memberRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(
			db,
			{ spaceId, actorUserId: owner.user.id, memberId: memberRow.id },
			Date.now()
		);
		const space = {
			id: spaceId,
			name: 'Keluarga',
			kind: 'shared',
			role: 'member'
		} as App.Locals['space'];
		const pageEvent = fakeEvent({
			url: 'http://localhost/pengaturan/pedagang',
			db,
			user: member.user,
			space
		});
		expect(
			await run(() => pedagang.load(pageEvent.event as never) as Promise<unknown>)
		).toMatchObject({
			kind: 'error',
			status: 404
		});
		const delEvent = fakeEvent({
			url: 'http://localhost/pengaturan/pedagang?/hapus',
			db,
			user: member.user,
			space,
			form: { id: crypto.randomUUID(), updatedAt: '1' }
		});
		expect(
			await run(() => (pedagang.actions as Record<string, Action>).hapus!(delEvent.event as never))
		).toMatchObject({ kind: 'error', status: 404 });
		const sugEvent = fakeEvent({
			url: 'http://localhost/riwayat/saran',
			db,
			user: member.user,
			space,
			form: { title: 'kopi', type: 'expense' }
		});
		expect(await run(async () => saran.POST(sugEvent.event as never))).toMatchObject({
			kind: 'error',
			status: 404
		});
	});

	it('voice without JavaScript: cleaned merchant, resolved category with its reason, amount unchanged (AC-12)', async () => {
		const p = await person();
		const { event } = fakeEvent({
			url: 'http://localhost/riwayat/suara?/parse',
			db,
			user: p.user,
			space: spaceOf(p),
			form: { sentence: 'beli kopi kenangan 25rb' }
		});
		const r = (await (suara.actions as Record<string, Action>).parse!(event as never)) as {
			candidates: { title: string; amountMinor: number }[];
			resolved: { merchant: string; categoryId: string | null; reason: string }[];
		};
		expect(r.candidates).toMatchObject([{ title: 'beli kopi kenangan', amountMinor: 2_500_000 }]);
		expect(r.resolved).toEqual([
			{ merchant: 'Beli Kopi Kenangan', categoryId: p.cat('kopi'), reason: 'keyword' }
		]);
		// Typed through the suggestion endpoint (the JavaScript path), the same sentence gives the same answer.
		const typed = fakeEvent({
			url: 'http://localhost/riwayat/saran',
			db,
			user: p.user,
			space: spaceOf(p),
			form: { title: 'beli kopi kenangan', type: 'expense' }
		});
		const res = (await saran.POST(typed.event as never)) as Response;
		expect(((await res.json()) as { items: unknown[] }).items).toEqual(r.resolved);
	});

	it('suggestion endpoint: deterministic only, the session space, at most 20 items', async () => {
		const p = await person();
		await spend(p, 'Warung Bu Sri', p.cat('makan'));
		const { event } = fakeEvent({
			url: 'http://localhost/riwayat/saran',
			db,
			user: p.user,
			space: spaceOf(p),
			form: [
				['title', 'warung bu sri'],
				['type', 'expense'],
				['title', 'toko aneh'],
				['type', 'expense'],
				...Array.from({ length: 30 }, (): [string, string] => ['title', 'kopi'])
			]
		});
		const res = (await saran.POST(event as never)) as Response;
		const body = (await res.json()) as {
			items: { merchant: string; categoryId: string; reason: string }[];
		};
		expect(body.items).toHaveLength(20);
		expect(body.items[0]).toEqual({
			merchant: 'Warung Bu Sri',
			categoryId: p.cat('makan'),
			reason: 'history'
		});
		expect(body.items[1]).toMatchObject({ categoryId: null, reason: 'none' });
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('"Isi kategori otomatis" without a key fills deterministic categories and returns the key hint', async () => {
		const p = await person({ key: false });
		const base = {
			recipient: p.scope,
			direction: 'expense' as const,
			amountMinor: 1_000_000,
			occurredOn: wibTodayString(),
			occurredAt: Date.now(),
			reference: null,
			trust: 'verified' as const,
			parser: 'ai' as Capture['parser']
		};
		const ledger = () => ({ kind: 'queued' as const, mailId: 'none', now: Date.now() });
		await captureDraft(db, { ...base, merchant: 'TOKO ANEH', dedupeKey: 'mail:m:x' }, ledger());
		// A rule learned after the capture: the action picks it up.
		await learnFromCorrection(
			db,
			p.scope,
			{ descriptor: 'TOKO ANEH', kind: 'expense', categoryId: p.cat('belanja') },
			Date.now()
		);
		await captureDraft(db, { ...base, merchant: 'TOKO LAIN', dedupeKey: 'mail:m:y' }, ledger());
		const { event } = fakeEvent({
			url: 'http://localhost/kotak-masuk/periksa?/suggest',
			db,
			user: p.user,
			space: spaceOf(p),
			form: { x: '1' }
		});
		const r = await run(() => (periksa.actions as Record<string, Action>).suggest!(event as never));
		expect(r).toMatchObject({
			kind: 'ok',
			value: {
				done: 'suggested',
				updated: 1,
				aiNotice: 'Tambahkan kunci Anthropic di Pengaturan › Integrasi'
			}
		});
		expect(fakeFetch).not.toHaveBeenCalled();
		const drafts = await listPendingDrafts(db, p.scope.spaceId);
		expect(drafts.find((d) => d.title === 'Toko Aneh')!.categoryId).toBe(p.cat('belanja'));
		expect(drafts.find((d) => d.title === 'Toko Lain')!.categoryId).toBeNull();
	});

	it('AC-16: the per-row category change posts ?/setCategory for one draft, teaches the space and leaves the others', async () => {
		const p = await person({ key: false });
		const base = {
			recipient: p.scope,
			direction: 'expense' as const,
			amountMinor: 1_000_000,
			occurredOn: wibTodayString(),
			occurredAt: Date.now(),
			reference: null,
			trust: 'verified' as const,
			parser: 'ai' as Capture['parser']
		};
		const ledger = () => ({ kind: 'queued' as const, mailId: 'none', now: Date.now() });
		await captureDraft(
			db,
			{ ...base, merchant: 'TOKO ANEH BARU', dedupeKey: 'mail:m:r1' },
			ledger()
		);
		await captureDraft(
			db,
			{ ...base, merchant: 'TOKO LAIN LAGI', dedupeKey: 'mail:m:r2' },
			ledger()
		);
		const [one, two] = (await listPendingDrafts(db, p.scope.spaceId)).sort((a, b) =>
			String(a.title).localeCompare(String(b.title))
		);
		const post = (draft: typeof one, categoryId: string) => {
			const { event } = fakeEvent({
				url: 'http://localhost/kotak-masuk/periksa?/setCategory',
				db,
				user: p.user,
				space: spaceOf(p),
				// exactly what a row's own form posts: its one token and the tapped category
				form: { d: `${draft!.id}:${draft!.updatedAt}`, categoryId }
			});
			return run(() => (periksa.actions as Record<string, Action>).setCategory!(event as never));
		};
		expect(await post(one, p.cat('hiburan'))).toMatchObject({
			kind: 'ok',
			value: { done: 'category', updated: 1 }
		});
		const after = await listPendingDrafts(db, p.scope.spaceId);
		expect(after.find((d) => d.id === one!.id)!.categoryId).toBe(p.cat('hiburan'));
		expect(after.find((d) => d.id === two!.id)!.categoryId).toBeNull();
		const rules = await listRules(db, p.scope.spaceId);
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({ merchantName: one!.title, hits: 1 });
		// the same token again is stale (the page reloads): refused, no second hit
		expect(await post(one, p.cat('belanja'))).toMatchObject({ kind: 'fail', status: 409 });
		// another member of nobody's space cannot reach it: a draft id of this space through a stranger is 404-class
		const stranger = await person({ key: false });
		const { event } = fakeEvent({
			url: 'http://localhost/kotak-masuk/periksa?/setCategory',
			db,
			user: stranger.user,
			space: spaceOf(stranger),
			form: { d: `${two!.id}:${two!.updatedAt}`, categoryId: stranger.cat('belanja') }
		});
		const r = await run(() =>
			(periksa.actions as Record<string, Action>).setCategory!(event as never)
		);
		expect(r).toMatchObject({ kind: 'fail' });
		expect(
			(await listPendingDrafts(db, p.scope.spaceId)).find((d) => d.id === two!.id)!.categoryId
		).toBeNull();
	});
});

describe('privacy and migration (AC-21, AC-22)', () => {
	it('deleting the account removes its space rules and cache', async () => {
		const p = await person();
		await learnFromCorrection(
			db,
			p.scope,
			{ descriptor: 'KEDAI HAPUS', kind: 'expense', categoryId: p.cat('kopi') },
			Date.now()
		);
		await resolve(p, [{ rawText: 'TOKO CACHE' }], true);
		expect(await cacheCount(p.scope.spaceId)).toBe(1);
		const proof = await signInWithPassword(db, p.user.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof');
		expect(await deleteAccount(db, p.user.id, proof.hash)).toBe(true);
		const left = await db.all<{ n: number }>(
			sql`select (select count(*) from merchant_rules where space_id = ${p.scope.spaceId})
				+ (select count(*) from merchant_cache where space_id = ${p.scope.spaceId}) as n`
		);
		expect(left[0]!.n).toBe(0);
	});

	it('migration 0034 re-runs harmlessly; the unique index refuses a second live rule but allows one after a tombstone', async () => {
		await applyMigration(d1, '0034_merchant_rules.sql');
		const p = await person();
		const insert = (id: string) =>
			d1
				.prepare(
					`insert into merchant_rules (id, space_id, match_key, merchant_name, category_id, kind, hits, source,
						created_by, created_at, updated_at, deleted_at, seq)
					values (?, ?, 'toko uji', 'Toko Uji', ?, 'expense', 1, 'correction', ?, 1, 1, null, 1)`
				)
				.bind(id, p.scope.spaceId, p.cat('kopi'), p.user.id)
				.run();
		await insert('r1');
		await expect(insert('r2')).rejects.toThrow(/UNIQUE/);
		expect(await deleteRule(db, p.scope, 'r1', 1, Date.now())).toBe('ok');
		await insert('r3');
		expect(await ruleCount(p.scope.spaceId)).toBe(1);
		const tomb = await d1
			.prepare('select merchant_name, category_id from merchant_rules where id = ?')
			.bind('r1')
			.first();
		expect(tomb).toEqual({ merchant_name: null, category_id: null });
	});
});
