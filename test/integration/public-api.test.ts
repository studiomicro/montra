import type { RequestHandler } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ENDPOINTS, type ApiEndpoint } from '#lib/server/api/endpoints';
import { isBearerApiRoute } from '#lib/server/csrf';
import { signUp } from '#lib/server/auth/accounts';
import {
	API_TOKEN_TOUCH_MS,
	createApiToken,
	resolveApiToken,
	revokeApiToken
} from '#lib/server/auth/api-tokens';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { setBudget } from '#lib/server/budgets/repo';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { listTransactionsByDay, periodTotals } from '#lib/server/transactions/aggregate';
import {
	AMOUNT_INVALID,
	AMOUNT_TOO_LARGE,
	REFS_GONE,
	TRANSACTION_CHANGED,
	TRANSFER_CURRENCY,
	TYPE_INVALID,
	WALLET_NOT_FOUND
} from '#lib/server/transactions/messages';
import { createTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { API_REQUESTS_PER_WINDOW, type ApiTokenScope } from '#lib/shared/api-tokens';
import { addDays, monthOf, shiftMonth, wibTodayString } from '#lib/shared/dates';
import { createTranslator } from '#lib/shared/i18n';
import { sha256Hex } from '#lib/server/util';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const spacesRoute = await import('../../src/routes/api/v1/spaces/+server');
const walletsRoute = await import('../../src/routes/api/v1/wallets/+server');
const categoriesRoute = await import('../../src/routes/api/v1/categories/+server');
const transactionsRoute = await import('../../src/routes/api/v1/transactions/+server');
const transactionRoute = await import('../../src/routes/api/v1/transactions/[id]/+server');
const budgetsRoute = await import('../../src/routes/api/v1/budgets/+server');
const laporanRoute = await import('../../src/routes/api/v1/laporan/ringkasan/+server');
const syncPush = await import('../../src/routes/api/v1/sync/push/+server');
const { handle } = await import('../../src/hooks.server');

const en = createTranslator('en');
let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

/** D1 with a statement counter and optional fault injection (a statement whose SQL matches `fail` throws). */
let statements = 0;
let fail: RegExp | null = null;
let counted: Db;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
	const proxy = new Proxy(d1, {
		get(target, prop) {
			if (prop === 'prepare')
				return (query: string) => {
					statements++;
					if (fail?.test(query)) throw new Error('D1_ERROR: injected failure select * from secret');
					return target.prepare(query);
				};
			const value = Reflect.get(target, prop) as unknown;
			return typeof value === 'function'
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		}
	});
	counted = getDb(proxy);
});
afterAll(() => dispose());

let n = 0;
async function person(name = 'Uji') {
	const email = `api${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { id: r.userId, email, name, sessionToken: r.token, createdAt: 0 };
}
type Person = Awaited<ReturnType<typeof person>>;

async function setup(who?: Person, space?: string) {
	const p = who ?? (await person());
	const spaceId = (await resolveCurrentSpace(db, p.id, space))!.id;
	await ensurePresetCategories(db, spaceId);
	const scope = { spaceId, userId: p.id };
	const wallet = async (name: string, currency: 'IDR' | 'USD' = 'IDR') => {
		const w = await createWallet(
			db,
			scope,
			{
				name,
				type: 'bank',
				currency,
				openingBalanceMinor: 0,
				isFavourite: name === 'BCA',
				lastFour: null
			},
			Date.now()
		);
		if (!w.ok) throw new Error('wallet failed');
		return w.id;
	};
	const bca = await wallet('BCA');
	const cats = await listCategories(db, spaceId);
	const cat = (key: string) => cats.find((c) => c.tileKey === key)!.id;
	return { p, spaceId, scope, bca, wallet, kopi: cat('kopi'), gaji: cat('gaji') };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** The stored password hash, standing in for a re-entered password (the page proves it; tested there). */
const provenHash = async (userId: string) =>
	(await db.get<{ hash: string }>(sql`select hash from user_passwords where user_id = ${userId}`))!
		.hash;

async function token(
	userId: string,
	scope: ApiTokenScope = 'read_write',
	space: string | null = null
) {
	const t = await createApiToken(
		db,
		userId,
		{ name: 'Skrip', scope, restrictedSpaceId: space, lifetimeDays: 90 },
		await provenHash(userId),
		Date.now()
	);
	if (!t.ok) throw new Error('token failed');
	return t;
}

interface Call {
	method?: string;
	path?: string;
	query?: Record<string, string>;
	bearer?: string | null;
	authorization?: string;
	json?: unknown;
	rawBody?: string;
	contentType?: string;
	params?: Record<string, string>;
	/** A signed-in session as the hook would set it (the API must ignore it). */
	user?: Person;
	viaCounted?: boolean;
	/** The client address (CF-Connecting-IP); a fresh one per call unless given. */
	ip?: string;
}

const randomIp = () => `10.${Array.from(crypto.getRandomValues(new Uint8Array(3))).join('.')}`;

async function call(handler: RequestHandler, c: Call = {}) {
	const url = new URL(`http://localhost${c.path ?? '/api/v1/x'}`);
	for (const [k, v] of Object.entries(c.query ?? {})) url.searchParams.set(k, v);
	const headers: Record<string, string> = {};
	headers['cf-connecting-ip'] = c.ip ?? randomIp();
	if (c.authorization !== undefined) headers.authorization = c.authorization;
	else if (c.bearer) headers.authorization = `Bearer ${c.bearer}`;
	const body = c.rawBody ?? (c.json === undefined ? undefined : JSON.stringify(c.json));
	if (body !== undefined) headers['content-type'] = c.contentType ?? 'application/json';
	const { event } = fakeEvent({
		url: url.href,
		routeId: '/api/v1/x',
		db: c.viaCounted ? counted : db,
		user: c.user ?? null,
		sessionToken: c.user?.sessionToken ?? null,
		cookies: c.user ? { financer_session: c.user.sessionToken } : {},
		params: c.params
	});
	(event as { request: Request }).request = new Request(url, {
		method: c.method ?? 'GET',
		headers,
		body
	});
	const res = (await handler(event as never)) as Response;
	const text = await res.text();
	return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
}

const rows = async (spaceId: string) =>
	(
		await db.all<{ n: number }>(
			sql`select count(*) as n from transactions where space_id = ${spaceId}`
		)
	)[0]!.n;

const input = (s: Setup, o: Partial<TransactionInput> = {}): TransactionInput => ({
	type: 'expense',
	amountMinor: 2_500_000,
	currency: 'IDR',
	walletId: s.bca,
	transferToWalletId: null,
	categoryId: s.kopi,
	title: 'Kopi susu',
	note: null,
	occurredOn: wibTodayString(),
	occurredTime: null,
	...o
});

const createBody = (s: Setup, o: Record<string, unknown> = {}) => ({
	client_id: crypto.randomUUID(),
	type: 'expense',
	amount_minor: 2_500_000,
	wallet_id: s.bca,
	category_id: s.kopi,
	title: 'Kopi',
	occurred_on: wibTodayString(),
	...o
});

/** Every FN-38 data route with the arguments that reach its handler. */
function everyRoute(s: Setup, txId: string = crypto.randomUUID()) {
	const q = { space_id: s.spaceId };
	return [
		{ h: spacesRoute.GET, c: {} },
		{ h: walletsRoute.GET, c: { query: q } },
		{ h: categoriesRoute.GET, c: { query: q } },
		{ h: transactionsRoute.GET, c: { query: q } },
		{ h: transactionsRoute.POST, c: { method: 'POST', query: q, json: createBody(s) } },
		{ h: transactionRoute.GET, c: { query: q, params: { id: txId } } },
		{
			h: transactionRoute.PATCH,
			c: { method: 'PATCH', query: q, params: { id: txId }, json: { expected_updated_at: 1 } }
		},
		{
			h: transactionRoute.DELETE,
			c: { method: 'DELETE', query: { ...q, expected_updated_at: '1' }, params: { id: txId } }
		},
		{ h: budgetsRoute.GET, c: { query: q } },
		{ h: laporanRoute.GET, c: { query: q } }
	] as { h: RequestHandler; c: Call }[];
}

describe('FN-38 auth: Bearer tokens only (criteria 1, 4, 5, 7, 9)', () => {
	it('answers 401 in the fixed shape without an Authorization header', async () => {
		const r = await call(spacesRoute.GET);
		expect(r.status).toBe(401);
		expect(r.body).toEqual({
			error: { code: 'unauthorized', message: 'A valid API token is required.' }
		});
		expect(r.headers.get('www-authenticate')).toBe('Bearer realm="montra"');
		expect(r.headers.get('cache-control')).toBe('no-store');
	});

	it('never accepts a session cookie: every route answers 401 to a signed-in browser request (criterion 5)', async () => {
		const s = await setup();
		for (const { h, c } of everyRoute(s)) {
			const r = await call(h, { ...c, user: s.p });
			expect(r.status, JSON.stringify(c)).toBe(401);
			expect(r.body.error.code).toBe('unauthorized');
		}
		expect(await rows(s.spaceId)).toBe(0);
	});

	it('gives unknown, malformed, revoked, expired and disabled-user tokens the same 401 (criterion 4)', async () => {
		const s = await setup();
		const live = await token(s.p.id);
		const revoked = await token(s.p.id);
		await revokeApiToken(db, s.p.id, revoked.id, Date.now());
		const expired = await createApiToken(
			db,
			s.p.id,
			{ name: 'Lama', scope: 'read', restrictedSpaceId: null, lifetimeDays: 30 },
			await provenHash(s.p.id),
			Date.now() - 31 * 24 * 60 * 60 * 1000
		);
		if (!expired.ok) throw new Error('setup');
		const other = await setup();
		const disabled = await token(other.p.id);
		await db.run(sql`update users set status = 'disabled' where id = ${other.p.id}`);

		const answers = [];
		for (const authorization of [
			'Bearer fin_' + 'A'.repeat(43),
			'Bearer nonsense',
			'Bearer ' + 'x'.repeat(5000),
			`Basic ${live.token}`,
			`Bearer ${revoked.token}`,
			`Bearer ${expired.token}`,
			`Bearer ${disabled.token}`
		]) {
			const r = await call(spacesRoute.GET, { authorization });
			answers.push({ status: r.status, text: r.text });
		}
		expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
		expect(answers[0]!.status).toBe(401);
		expect((await call(spacesRoute.GET, { bearer: live.token })).status).toBe(200);
	});

	it('refuses a token revoked after it was used (criterion 7)', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		expect(
			(await call(walletsRoute.GET, { bearer: t.token, query: { space_id: s.spaceId } })).status
		).toBe(200);
		expect(await revokeApiToken(db, s.p.id, t.id, Date.now())).toBe(true);
		const r = await call(walletsRoute.GET, { bearer: t.token, query: { space_id: s.spaceId } });
		expect(r.status).toBe(401);
	});

	it('touches last_used_at at most once per hour (criterion 9)', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const lastUsed = async () =>
			(await db.get<{ v: number | null }>(
				sql`select last_used_at as v from api_tokens where id = ${t.id}`
			))!.v;
		const t0 = Date.now() + 1000;
		const writes = async (at: number) => {
			const before = statements;
			await resolveApiToken(counted, t.token, at);
			return statements - before;
		};
		expect(await lastUsed()).toBeNull();
		expect(await writes(t0)).toBe(2); // lookup + the first touch
		expect(await lastUsed()).toBe(t0);
		expect(await writes(t0 + 1000)).toBe(1); // lookup only: no write
		expect(await lastUsed()).toBe(t0);
		expect(await writes(t0 + API_TOKEN_TOUCH_MS)).toBe(2);
		expect(await lastUsed()).toBe(t0 + API_TOKEN_TOUCH_MS);
	});

	it('does the same work for any presented value: one hash, one indexed lookup (timing probe)', async () => {
		const s = await setup();
		const t = await token(s.p.id, 'read');
		await resolveApiToken(db, t.token, Date.now()); // first touch done
		const work = async (raw: string) => {
			const before = statements;
			const started = performance.now();
			await resolveApiToken(counted, raw, Date.now());
			return { statements: statements - before, ms: performance.now() - started };
		};
		const cases = [t.token, 'fin_' + 'B'.repeat(43), 'not-a-token', ''];
		const results = [];
		for (const raw of cases) results.push(await work(raw));
		expect(results.map((r) => r.statements)).toEqual([1, 1, 1, 1]);
	});
});

describe('FN-38: guessing tokens is bounded per client (cycles 1b, 2)', () => {
	it('after 20 failed requests from a client, its next failure gets 429; a valid token there still works', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const ip = randomIp();
		const guess = (i: number) => `fin_${'Z'.repeat(42)}${i % 10}`;
		for (let i = 0; i < 20; i++)
			expect((await call(spacesRoute.GET, { bearer: guess(i), ip })).status).toBe(401);
		const blocked = await call(spacesRoute.GET, { bearer: guess(0), ip });
		expect(blocked.status).toBe(429);
		expect(blocked.body.error.code).toBe('rate_limited');
		expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
		expect((await call(spacesRoute.GET, { ip })).status).toBe(429);
		// Red team L1: a shared address never locks out a valid token (looked up first, never counted).
		expect((await call(spacesRoute.GET, { bearer: t.token, ip })).status).toBe(200);
		// Another client's failures are its own.
		expect((await call(spacesRoute.GET, { bearer: guess(1) })).status).toBe(401);
	});

	it('valid requests never spend the failure budget', async () => {
		const s = await setup();
		const t = await token(s.p.id, 'read');
		const ip = randomIp();
		for (let i = 0; i < 25; i++)
			expect((await call(spacesRoute.GET, { bearer: t.token, ip })).status).toBe(200);
		expect((await call(spacesRoute.GET, { bearer: 'fin_nope', ip })).status).toBe(401);
	});
});

describe('cross-site forms in hooks.server.ts (cycle 2: SvelteKit’s check moved, Bearer routes exempt)', () => {
	const through = vi.fn(async () => new Response('handled'));
	const viaHook = async (o: {
		routeId: string;
		method: string;
		headers?: Record<string, string>;
		body?: string;
		user?: Person;
	}) => {
		const url = 'http://localhost/x';
		const { event } = fakeEvent({
			url,
			routeId: o.routeId,
			db,
			cookies: o.user ? { financer_session: o.user.sessionToken } : {}
		});
		(event as { request: Request }).request = new Request(url, {
			method: o.method,
			headers: o.headers,
			body: o.body
		});
		through.mockClear();
		const res = await handle({ event, resolve: through } as never);
		return { res, reached: through.mock.calls.length > 0 };
	};

	it('still refuses a cross-site or Origin-less form POST to an app action, signed in or not', async () => {
		const p = await person();
		for (const headers of [
			{ 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
			{ 'content-type': 'multipart/form-data; boundary=b' },
			{}
		] as Record<string, string>[]) {
			const { res, reached } = await viaHook({
				routeId: '/(app)/pengaturan/api',
				method: 'POST',
				headers,
				body: 'name=x',
				user: p
			});
			expect(reached).toBe(false);
			expect(res.status).toBe(403);
			expect(await res.text()).toBe('Cross-site POST form submissions are forbidden');
		}
		const same = await viaHook({
			routeId: '/(app)/pengaturan/api',
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
			body: 'name=x',
			user: p
		});
		expect(same.reached).toBe(true);
	});

	it('keeps protecting the other /api/v1 routes', async () => {
		const { res, reached } = await viaHook({ routeId: '/api/v1/sync/push', method: 'POST' });
		expect(reached).toBe(false);
		expect(res.status).toBe(403);
	});

	it('lets a bodyless, Origin-less DELETE through to a Bearer-only route', async () => {
		for (const routeId of ['/api/v1/transactions/[id]', '/api/v1/transactions']) {
			const { reached } = await viaHook({
				routeId,
				method: routeId.endsWith('[id]') ? 'DELETE' : 'POST',
				headers: { authorization: 'Bearer fin_x' }
			});
			expect(reached).toBe(true);
		}
	});
});

describe('FN-38: a token never works anywhere else (criterion 6)', () => {
	it('an (app) page with only a Bearer token is treated as signed out', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const { event } = fakeEvent({
			url: 'http://localhost/riwayat',
			routeId: '/(app)/riwayat',
			db,
			headers: { authorization: `Bearer ${t.token}` }
		});
		const res = await handle({ event, resolve: vi.fn(async () => new Response('in')) } as never);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/masuk?next=%2Friwayat');
		expect(event.locals.user).toBeNull();
	});

	it('the internal /api/v1/sync/push answers a Bearer-only request as signed out', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const { event } = fakeEvent({
			url: 'http://localhost/api/v1/sync/push',
			routeId: '/api/v1/sync/push',
			db
		});
		(event as { request: Request }).request = new Request('http://localhost/api/v1/sync/push', {
			method: 'POST',
			headers: {
				origin: 'http://localhost',
				authorization: `Bearer ${t.token}`,
				'content-type': 'application/json'
			},
			body: '{}'
		});
		const res = (await syncPush.POST(event as never)) as Response;
		expect(res.status).toBe(401);
		expect(((await res.json()) as { result: string }).result).toBe('session');
	});
});

describe('FN-38 scopes (criterion 3)', () => {
	it('refuses a read token on every write route with 403 before anything is written', async () => {
		const s = await setup();
		const created = await createTransaction(db, s.scope, input(s), Date.now());
		if (!created.ok) throw new Error('setup');
		const t = await token(s.p.id, 'read');
		const seq = async () =>
			(await db.get<{ seq: number }>(sql`select seq from space_seq where space_id = ${s.spaceId}`))
				?.seq;
		const seqBefore = await seq();
		for (const { h, c } of everyRoute(s, created.id).filter((r) => r.c.method)) {
			const r = await call(h, { ...c, bearer: t.token });
			expect(r.status).toBe(403);
			expect(r.body.error.code).toBe('insufficient_scope');
		}
		expect(await rows(s.spaceId)).toBe(1);
		expect(await seq()).toBe(seqBefore);
	});
});

describe('FN-38 space access (criteria 2, 10, 11, 12)', () => {
	it('two users: A’s token reads B’s space as the same 404 a missing space gets (criterion 11)', async () => {
		const a = await setup();
		const b = await setup();
		const created = await createTransaction(db, b.scope, input(b), Date.now());
		if (!created.ok) throw new Error('setup');
		const t = await token(a.p.id);
		const missing = await call(walletsRoute.GET, {
			bearer: t.token,
			query: { space_id: crypto.randomUUID() }
		});
		expect(missing.status).toBe(404);
		for (const { h, c } of everyRoute(b, created.id).slice(1)) {
			const r = await call(h, { ...c, bearer: t.token });
			expect(r.status, JSON.stringify(c)).toBe(404);
			expect(r.text).toBe(missing.text);
		}
		expect(await rows(b.spaceId)).toBe(1);
	});

	it('a token restricted to one space gets the non-member 404 for the user’s other space (criterion 2)', async () => {
		const owner = await person();
		const personal = await setup(owner);
		const sharedId = (await createSharedSpace(db, owner.id, 'Keluarga', Date.now()))!;
		const shared = await setup(owner, sharedId);
		const t = await token(owner.id, 'read_write', personal.spaceId);
		const stranger = await call(walletsRoute.GET, {
			bearer: t.token,
			query: { space_id: crypto.randomUUID() }
		});
		for (const { h, c } of everyRoute(shared).slice(1)) {
			const r = await call(h, { ...c, bearer: t.token });
			expect(r.status).toBe(404);
			expect(r.text).toBe(stranger.text);
		}
		expect(await rows(sharedId)).toBe(0);
		const spaces = await call(spacesRoute.GET, { bearer: t.token });
		expect(spaces.body.data.map((x: { id: string }) => x.id)).toEqual([personal.spaceId]);
		expect(
			(await call(walletsRoute.GET, { bearer: t.token, query: { space_id: personal.spaceId } }))
				.status
		).toBe(200);
	});

	it('a removed member’s token is refused on that space like the removed member’s browser (criterion 12)', async () => {
		const owner = await person();
		const member = await person();
		const spaceId = (await createSharedSpace(db, owner.id, 'Rumah', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.id, Date.now());
		const s = await setup(owner, spaceId);
		const all = await token(member.id);
		const restricted = await token(member.id, 'read_write', spaceId);
		expect(
			(await call(walletsRoute.GET, { bearer: all.token, query: { space_id: spaceId } })).status
		).toBe(200);
		const row = (await listMembers(db, spaceId, owner.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.id, memberId: row.id }, Date.now());
		for (const t of [all, restricted]) {
			for (const { h, c } of everyRoute(s).slice(1)) {
				const r = await call(h, { ...c, bearer: t.token });
				expect(r.status).toBe(404);
			}
			const spaces = await call(spacesRoute.GET, { bearer: t.token });
			expect(spaces.body.data.map((x: { id: string }) => x.id)).not.toContain(spaceId);
		}
		expect(await rows(spaceId)).toBe(0);
	});
});

describe('FN-38 reads: same rows and totals as the app (criteria 13, 14, 15, 19, 21)', () => {
	it('lists wallets, categories, the budget and the spaces in the documented shapes', async () => {
		const s = await setup();
		await setBudget(db, s.scope, { amountMinor: 500_000_000, currency: 'IDR' }, null, Date.now());
		const t = await token(s.p.id, 'read');
		const q = { space_id: s.spaceId };
		const check = async (h: RequestHandler, e: ApiEndpoint, c: Call) => {
			const r = await call(h, { ...c, bearer: t.token });
			expect(r.status).toBe(e.success.status);
			(e.success.schema as z.ZodType).parse(r.body);
			return r.body;
		};
		const spaces = await check(spacesRoute.GET, ENDPOINTS.listSpaces, {});
		expect(spaces.data).toEqual([
			{ id: s.spaceId, kind: 'personal', name: expect.any(String), role: 'owner' }
		]);
		const wallets = await check(walletsRoute.GET, ENDPOINTS.listWallets, { query: q });
		expect(wallets.data[0]).toMatchObject({ id: s.bca, currency: 'IDR', opening_balance_minor: 0 });
		const cats = await check(categoriesRoute.GET, ENDPOINTS.listCategories, { query: q });
		expect(cats.data.length).toBeGreaterThanOrEqual(15);
		const budget = await check(budgetsRoute.GET, ENDPOINTS.getBudget, { query: q });
		expect(budget.data).toMatchObject({ amount_minor: 500_000_000, currency: 'IDR' });
	});

	it('filters and totals reconcile with Riwayat’s own aggregate; demo rows are listed but never summed', async () => {
		const s = await setup();
		const usd = await s.wallet('Dolar', 'USD');
		const day = addDays(wibTodayString(), -40);
		const month = monthOf(day);
		const add = (o: Partial<TransactionInput>, demo = false) =>
			createTransaction(db, s.scope, input(s, { occurredOn: day, ...o }), Date.now(), {
				source: 'manual',
				dedupeKey: null,
				isDemo: demo
			});
		await add({ amountMinor: 1_000_000, title: 'Kopi pagi' });
		await add({ amountMinor: 2_000_050, title: 'Makan siang', note: 'kopi juga' });
		await add({ type: 'income', amountMinor: 50_000_000, categoryId: s.gaji, title: 'Gaji' });
		await add({ amountMinor: 999, currency: 'USD', walletId: usd, title: 'Kopi USD' });
		await add({ amountMinor: 7_777_700, title: 'Kopi demo' }, true);
		const t = await token(s.p.id, 'read');
		const from = `${month}-01`;
		const to = addDays(`${shiftMonth(month, 1)}-01`, -1);
		for (const extra of [
			{},
			{ type: 'expense' },
			{ category_id: s.gaji },
			{ wallet_id: usd },
			{ q: 'kopi' }
		] as Record<string, string>[]) {
			const r = await call(transactionsRoute.GET, {
				bearer: t.token,
				query: { space_id: s.spaceId, from, to, ...extra }
			});
			expect(r.status).toBe(200);
			ENDPOINTS.listTransactions.success.schema.parse(r.body);
			const filter = {
				from,
				to,
				type: (extra.type as 'expense' | undefined) ?? null,
				categoryId: extra.category_id ?? null,
				walletId: extra.wallet_id ?? null,
				q: extra.q ?? null,
				recurringOnly: false
			};
			const page = await listTransactionsByDay(db, s.spaceId, filter);
			const totals = await periodTotals(db, s.spaceId, filter);
			expect(r.body.data.map((x: { id: string }) => x.id)).toEqual(
				page.days.flatMap((d) => d.rows.map((x) => x.id))
			);
			expect(r.body.totals.count).toBe(totals.count);
			expect(r.body.totals.by_currency).toEqual(
				totals.totals.map((c) => ({
					currency: c.currency,
					in_minor: c.inMinor,
					out_minor: c.outMinor
				}))
			);
			// The list a total links to: its real expense rows add up to the total (per currency).
			for (const c of r.body.totals.by_currency) {
				const listed = r.body.data
					.filter(
						(x: { is_demo: boolean; type: string; currency: string }) =>
							!x.is_demo && x.type === 'expense' && x.currency === c.currency
					)
					.reduce((sum: number, x: { amount_minor: number }) => sum + x.amount_minor, 0);
				expect(listed).toBe(c.out_minor);
			}
			for (const x of r.body.data) {
				expect(Number.isInteger(x.amount_minor)).toBe(true);
				expect(x.currency).toMatch(/^[A-Z]{3}$/);
			}
		}
		const all = await call(transactionsRoute.GET, {
			bearer: t.token,
			query: { space_id: s.spaceId, from, to }
		});
		expect(all.body.data.find((x: { title: string }) => x.title === 'Kopi demo').is_demo).toBe(
			true
		);
		expect(
			all.body.totals.by_currency.find((c: { currency: string }) => c.currency === 'IDR').out_minor
		).toBe(3_000_050);
	});

	it('a 23:30 WIB write on a month’s last day lands in that month, never the next (criterion 15)', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const month = shiftMonth(monthOf(wibTodayString()), -2);
		const lastDay = addDays(`${shiftMonth(month, 1)}-01`, -1);
		const r = await call(transactionsRoute.POST, {
			method: 'POST',
			bearer: t.token,
			query: { space_id: s.spaceId },
			json: createBody(s, { occurred_on: lastDay, occurred_time: '23:30', amount_minor: 1_234_500 })
		});
		expect(r.status).toBe(201);
		expect(r.body.data.occurred_on).toBe(lastDay);
		// 23:30 WIB is 16:30 UTC the same day.
		expect(new Date(r.body.data.occurred_at).toISOString()).toBe(`${lastDay}T16:30:00.000Z`);
		const summary = async (bulan: string) =>
			(await call(laporanRoute.GET, { bearer: t.token, query: { space_id: s.spaceId, bulan } }))
				.body.data;
		const inMonth = await summary(month);
		ENDPOINTS.laporanSummary.success.schema.parse({ data: inMonth });
		expect(inMonth.totals[0]).toMatchObject({ currency: 'IDR', out_minor: 1_234_500 });
		expect(inMonth.categories[0]).toMatchObject({
			category_id: s.kopi,
			amount_minor: 1_234_500,
			percent: 100
		});
		expect((await summary(shiftMonth(month, 1))).totals[0].out_minor).toBe(0);
		const list = await call(transactionsRoute.GET, {
			bearer: t.token,
			query: { space_id: s.spaceId, from: `${month}-01`, to: lastDay }
		});
		expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([r.body.data.id]);
	});

	it('pages never repeat or skip a row, also across an insert between pages (criterion 19)', async () => {
		const s = await setup();
		const day = addDays(wibTodayString(), -3);
		for (let i = 0; i < 7; i++)
			await createTransaction(
				db,
				s.scope,
				input(s, { occurredOn: day, occurredTime: `0${i}:00`, title: `r${i}` }),
				Date.now()
			);
		const t = await token(s.p.id, 'read');
		const q = { space_id: s.spaceId, from: addDays(day, -1), to: addDays(day, 1), limit: '3' };
		const first = await call(transactionsRoute.GET, { bearer: t.token, query: q });
		expect(first.body.data).toHaveLength(3);
		// A concurrent insert, newer than everything on page one.
		await createTransaction(
			db,
			s.scope,
			input(s, { occurredOn: day, occurredTime: '23:00', title: 'baru' }),
			Date.now()
		);
		const seen = first.body.data.map((x: { id: string }) => x.id);
		let cursor = first.body.next_cursor;
		while (cursor) {
			const page = await call(transactionsRoute.GET, { bearer: t.token, query: { ...q, cursor } });
			expect(page.status).toBe(200);
			seen.push(...page.body.data.map((x: { id: string }) => x.id));
			cursor = page.body.next_cursor;
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toHaveLength(7);
		for (const bad of [
			{ cursor: 'garbage' },
			{ limit: '0' },
			{ limit: '51' },
			{ from: day },
			{ from: '2026-02-30', to: '2026-03-01' },
			{ from: '2024-01-01', to: '2025-12-31' }
		] as Record<string, string>[]) {
			const r = await call(transactionsRoute.GET, {
				bearer: t.token,
				query: { space_id: s.spaceId, ...bad }
			});
			expect(r.status, JSON.stringify(bad)).toBe(400);
			expect(r.body.error.code).toBe('invalid_request');
		}
	});
});

describe('FN-38 writes reuse FN-05 validation and FN-02 idempotency (criteria 16, 17, 18)', () => {
	it('FN-47: amount_minor 1250 on a USD wallet is exactly $12.50 (never re-read from text)', async () => {
		const s = await setup();
		const usd = await s.wallet('Dolar', 'USD');
		const t = await token(s.p.id);
		const r = await call(transactionsRoute.POST, {
			method: 'POST',
			bearer: t.token,
			query: { space_id: s.spaceId },
			json: createBody(s, { wallet_id: usd, amount_minor: 1250 })
		});
		expect(r.status).toBe(201);
		expect(r.body.data).toMatchObject({ amount_minor: 1250, currency: 'USD' });
	});

	it('the same client_id twice writes one row and answers the same id; 20 concurrent resends too', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const body = createBody(s);
		const post = () =>
			call(transactionsRoute.POST, {
				method: 'POST',
				bearer: t.token,
				query: { space_id: s.spaceId },
				json: body
			});
		const a = await post();
		const b = await post();
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);
		expect(a.body.data.id).toBe(body.client_id);
		expect(b.body).toEqual(a.body);
		expect(await rows(s.spaceId)).toBe(1);
		const concurrent = createBody(s);
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				call(transactionsRoute.POST, {
					method: 'POST',
					bearer: t.token,
					query: { space_id: s.spaceId },
					json: concurrent
				})
			)
		);
		expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
		expect(await rows(s.spaceId)).toBe(2);
	});

	it('never recreates a row deleted since, nor writes into another space’s id', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const body = createBody(s);
		const q = { space_id: s.spaceId };
		const first = await call(transactionsRoute.POST, {
			method: 'POST',
			bearer: t.token,
			query: q,
			json: body
		});
		const del = await call(transactionRoute.DELETE, {
			method: 'DELETE',
			bearer: t.token,
			params: { id: body.client_id },
			query: { ...q, expected_updated_at: String(first.body.data.updated_at) }
		});
		expect(del.status).toBe(200);
		expect(del.body).toEqual({ data: { id: body.client_id, deleted: true } });
		const again = await call(transactionsRoute.POST, {
			method: 'POST',
			bearer: t.token,
			query: q,
			json: body
		});
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('gone');
		const live = await db.get<{ n: number }>(
			sql`select count(*) as n from transactions where id = ${body.client_id} and deleted_at is null`
		);
		expect(live!.n).toBe(0);
		const other = await setup();
		const t2 = await token(other.p.id);
		const cross = await call(transactionsRoute.POST, {
			method: 'POST',
			bearer: t2.token,
			query: { space_id: other.spaceId },
			json: createBody(other, { client_id: body.client_id })
		});
		expect(cross.status).toBe(409);
		expect(cross.body.error).toEqual({ code: 'gone', message: en.tr(REFS_GONE) });
	});

	it('PATCH and DELETE with a stale expected_updated_at answer 409 and change nothing (criterion 17)', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const q = { space_id: s.spaceId };
		const created = await call(transactionsRoute.POST, {
			method: 'POST',
			bearer: t.token,
			query: q,
			json: createBody(s)
		});
		const { id, updated_at } = created.body.data;
		const stale = await call(transactionRoute.PATCH, {
			method: 'PATCH',
			bearer: t.token,
			query: q,
			params: { id },
			json: { expected_updated_at: updated_at - 1, title: 'Diubah' }
		});
		expect(stale.status).toBe(409);
		expect(stale.body.error).toEqual({ code: 'stale', message: en.tr(TRANSACTION_CHANGED) });
		const staleDel = await call(transactionRoute.DELETE, {
			method: 'DELETE',
			bearer: t.token,
			params: { id },
			query: { ...q, expected_updated_at: String(updated_at - 1) }
		});
		expect(staleDel.status).toBe(409);
		const unchanged = await call(transactionRoute.GET, {
			bearer: t.token,
			query: q,
			params: { id }
		});
		expect(unchanged.body).toEqual(created.body);

		const ok = await call(transactionRoute.PATCH, {
			method: 'PATCH',
			bearer: t.token,
			query: q,
			params: { id },
			json: { expected_updated_at: updated_at, title: 'Diubah', amount_minor: 3_000_001 }
		});
		expect(ok.status).toBe(200);
		expect(ok.body.data).toMatchObject({
			title: 'Diubah',
			amount_minor: 3_000_001,
			wallet_id: s.bca,
			category_id: s.kopi
		});
		expect(ok.body.data.updated_at).toBeGreaterThan(updated_at);
		const missing = await call(transactionRoute.PATCH, {
			method: 'PATCH',
			bearer: t.token,
			query: q,
			params: { id: crypto.randomUUID() },
			json: { expected_updated_at: 1 }
		});
		expect(missing.status).toBe(404);
	});

	it('refuses balance adjustments: never created, never changed through the API', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const q = { space_id: s.spaceId };
		const create = await call(transactionsRoute.POST, {
			method: 'POST',
			bearer: t.token,
			query: q,
			json: createBody(s, { type: 'adjustment', category_id: null })
		});
		expect(create.status).toBe(400);
		expect(create.body.error.fields.type).toBe(en.tr(TYPE_INVALID));
		const adj = await createTransaction(
			db,
			s.scope,
			input(s, { type: 'adjustment', categoryId: null, adjustmentDirection: 'increase' }),
			Date.now()
		);
		if (!adj.ok) throw new Error('setup');
		const row = await call(transactionRoute.GET, {
			bearer: t.token,
			query: q,
			params: { id: adj.id }
		});
		const patch = await call(transactionRoute.PATCH, {
			method: 'PATCH',
			bearer: t.token,
			query: q,
			params: { id: adj.id },
			json: { expected_updated_at: row.body.data.updated_at, title: 'x' }
		});
		expect(patch.status).toBe(400);
	});

	it('answers value errors with the compose form’s own messages, keyed by API field (criterion 18)', async () => {
		const s = await setup();
		const usd = await s.wallet('Dolar', 'USD');
		const t = await token(s.p.id);
		const post = (o: Record<string, unknown>) =>
			call(transactionsRoute.POST, {
				method: 'POST',
				bearer: t.token,
				query: { space_id: s.spaceId },
				json: createBody(s, o)
			});
		const cases: [Record<string, unknown>, string, string][] = [
			[{ wallet_id: crypto.randomUUID() }, 'wallet_id', WALLET_NOT_FOUND],
			[{ amount_minor: 0 }, 'amount_minor', AMOUNT_INVALID],
			[{ amount_minor: 10_000_000_000_001 }, 'amount_minor', AMOUNT_TOO_LARGE],
			[
				{ type: 'transfer', transfer_to_wallet_id: usd, category_id: null },
				'transfer_to_wallet_id',
				TRANSFER_CURRENCY
			]
		];
		for (const [o, field, phrase] of cases) {
			const r = await post(o);
			expect(r.status, JSON.stringify(o)).toBe(400);
			expect(r.body.error.code).toBe('validation_failed');
			expect(r.body.error.fields[field]).toBe(en.tr(phrase));
		}
		// JSON types are checked before: a float or a string amount never reaches a parser.
		for (const amount of [12.5, '25000', null]) {
			const r = await post({ amount_minor: amount });
			expect(r.status).toBe(400);
			expect(r.body.error.fields).toEqual({ amount_minor: 'Invalid value.' });
		}
		const missing = await post({ amount_minor: undefined });
		expect(missing.body.error.fields).toEqual({ amount_minor: 'Required.' });
		const noSpace = await call(walletsRoute.GET, { bearer: t.token });
		expect(noSpace.status).toBe(400);
		expect(noSpace.body.error).toEqual({
			code: 'invalid_request',
			message: 'Invalid query parameters.',
			fields: { space_id: 'Required.' }
		});
		expect(await rows(s.spaceId)).toBe(0);
	});
});

/**
 * The most D1 statements one call may run (criterion 21), kept here and out of the public OpenAPI document (red
 * team L3). Base 8: the hook's session lookup (2, only with a cookie), the token lookup and its hourly touch
 * (2), the per-token throttle (≤ 3) and the space check (1); then each route's own work.
 */
const D1_BUDGET: Record<string, number> = {
	listSpaces: 8,
	listWallets: 9,
	listCategories: 12,
	listTransactions: 11,
	getTransaction: 9,
	createTransaction: 16,
	updateTransaction: 16,
	deleteTransaction: 12,
	getBudget: 9,
	laporanSummary: 14
};

describe('FN-38 bodies, errors, limits (criteria 20, 21, 22)', () => {
	it('refuses malformed and oversized bodies with 400/413/415 in the fixed shape', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const q = { space_id: s.spaceId };
		const post = (c: Partial<Call>) =>
			call(transactionsRoute.POST, { method: 'POST', bearer: t.token, query: q, ...c });
		const cases: [Partial<Call>, number, string][] = [
			[
				{ rawBody: 'type=expense', contentType: 'application/x-www-form-urlencoded' },
				415,
				'unsupported_media_type'
			],
			[{ rawBody: '{"a":', contentType: 'application/json' }, 400, 'invalid_json'],
			[{ rawBody: '[1,2]' }, 400, 'validation_failed'],
			[
				{ rawBody: JSON.stringify({ ...createBody(s), note: 'x'.repeat(9000) }) },
				413,
				'payload_too_large'
			],
			[
				{ rawBody: '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}' },
				400,
				'validation_failed'
			]
		];
		for (const [c, status, code] of cases) {
			const r = await post(c);
			expect(r.status, code).toBe(status);
			expect(r.body.error.code).toBe(code);
			expect(r.text).not.toMatch(/at |\.ts|select |insert |stack/i);
		}
		expect(({} as Record<string, unknown>).admin).toBeUndefined();
		expect(await rows(s.spaceId)).toBe(0);
	});

	it('an unexpected D1 failure answers a generic 500 without SQL, paths or a stack', async () => {
		const s = await setup();
		const t = await token(s.p.id, 'read');
		fail = /from "?wallets"?/i;
		vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const r = await call(walletsRoute.GET, {
				bearer: t.token,
				query: { space_id: s.spaceId },
				viaCounted: true
			});
			expect(r.status).toBe(500);
			expect(r.body).toEqual({
				error: { code: 'internal_error', message: 'Something went wrong. Try again later.' }
			});
		} finally {
			fail = null;
			vi.mocked(console.error).mockRestore();
		}
	});

	it('limits each token to its own budget: request 301 in a window gets 429 + Retry-After (criterion 20)', async () => {
		const s = await setup();
		const t = await token(s.p.id, 'read');
		const other = await token(s.p.id, 'read');
		const now = Date.now();
		const windowStart = now - (now % THROTTLE_WINDOW_MS);
		const key = await sha256Hex(`api-request:token:${t.id}`);
		await db.run(sql`insert into auth_attempts (client_hash, window_start, count)
			values (${key}, ${windowStart}, ${API_REQUESTS_PER_WINDOW - 1})`);
		expect((await call(spacesRoute.GET, { bearer: t.token })).status).toBe(200);
		const over = await call(spacesRoute.GET, { bearer: t.token });
		expect(over.status).toBe(429);
		expect(over.body.error.code).toBe('rate_limited');
		const wait = Number(over.headers.get('retry-after'));
		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThanOrEqual(THROTTLE_WINDOW_MS / 1000);
		expect((await call(spacesRoute.GET, { bearer: other.token })).status).toBe(200);
	});

	it('fails closed: a throttle that cannot count refuses the request (criterion 20)', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		fail = /auth_attempts/;
		vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const r = await call(transactionsRoute.POST, {
				method: 'POST',
				bearer: t.token,
				query: { space_id: s.spaceId },
				json: createBody(s),
				viaCounted: true
			});
			expect(r.status).toBe(429);
		} finally {
			fail = null;
			vi.mocked(console.error).mockRestore();
		}
		expect(await rows(s.spaceId)).toBe(0);
	});

	it('keeps every route within its documented D1 statement budget (criterion 21)', async () => {
		const s = await setup();
		const t = await token(s.p.id);
		const created = await call(transactionsRoute.POST, {
			method: 'POST',
			bearer: t.token,
			query: { space_id: s.spaceId },
			json: createBody(s)
		});
		const { id, updated_at } = created.body.data;
		const fresh = await setup();
		const t2 = await token(fresh.p.id);
		const measured: [ApiEndpoint, RequestHandler, Call][] = [
			[ENDPOINTS.listSpaces, spacesRoute.GET, {}],
			[ENDPOINTS.listWallets, walletsRoute.GET, { query: { space_id: s.spaceId } }],
			[ENDPOINTS.listTransactions, transactionsRoute.GET, { query: { space_id: s.spaceId } }],
			[
				ENDPOINTS.getTransaction,
				transactionRoute.GET,
				{ query: { space_id: s.spaceId }, params: { id } }
			],
			[ENDPOINTS.getBudget, budgetsRoute.GET, { query: { space_id: s.spaceId } }],
			[ENDPOINTS.laporanSummary, laporanRoute.GET, { query: { space_id: s.spaceId } }],
			[
				ENDPOINTS.createTransaction,
				transactionsRoute.POST,
				{ method: 'POST', query: { space_id: s.spaceId }, json: createBody(s) }
			],
			[
				ENDPOINTS.updateTransaction,
				transactionRoute.PATCH,
				{
					method: 'PATCH',
					query: { space_id: s.spaceId },
					params: { id },
					json: { expected_updated_at: updated_at, title: 'baru' }
				}
			],
			[
				ENDPOINTS.deleteTransaction,
				transactionRoute.DELETE,
				{
					method: 'DELETE',
					query: { space_id: s.spaceId, expected_updated_at: '1' },
					params: { id }
				}
			]
		];
		for (const [endpoint, h, c] of measured) {
			const before = statements;
			await call(h, { ...c, bearer: t.token, viaCounted: true });
			// The hook's session lookup (2) is not part of this call; the budget includes it.
			expect(statements - before, endpoint.operationId).toBeLessThanOrEqual(
				D1_BUDGET[endpoint.operationId]! - 2
			);
		}
		// A space read for the first time seeds its preset categories: the costliest category call.
		await db.run(sql`delete from categories where space_id = ${fresh.spaceId}`);
		const before = statements;
		const cats = await call(categoriesRoute.GET, {
			bearer: t2.token,
			query: { space_id: fresh.spaceId },
			viaCounted: true
		});
		expect(cats.status).toBe(200);
		expect(statements - before).toBeLessThanOrEqual(D1_BUDGET.listCategories! - 2);
	});
});

describe('FN-38 red team L6: every handler in a CSRF-exempt route file checks the Bearer token', () => {
	// Found from the file tree, not from a list, so a handler added to one of these files later is covered.
	const modules = import.meta.glob<Record<string, unknown>>(
		'../../src/routes/api/v1/**/+server.ts',
		{
			eager: true
		}
	);
	const routeIdOf = (file: string) =>
		file.replace('../../src/routes', '').replace(/\/\+server\.ts$/, '');
	const exempt = Object.keys(modules).filter((file) => isBearerApiRoute(routeIdOf(file)));

	it('the exempt files are exactly the ENDPOINTS routes, each exporting only its declared methods', () => {
		const declared = new Map<string, string[]>();
		for (const e of Object.values(ENDPOINTS) as ApiEndpoint[]) {
			const id = e.path.replace('{id}', '[id]');
			declared.set(id, [...(declared.get(id) ?? []), e.method]);
		}
		expect(exempt.map(routeIdOf).sort()).toEqual([...declared.keys()].sort());
		for (const file of exempt)
			expect(Object.keys(modules[file]!).sort(), file).toEqual(
				declared.get(routeIdOf(file))!.sort()
			);
	});

	it('answers a signed-in, cross-site form request to every exported handler with 401', async () => {
		const s = await setup();
		let handlers = 0;
		for (const file of exempt)
			for (const [method, handler] of Object.entries(modules[file]!)) {
				handlers++;
				const r = await call(handler as RequestHandler, {
					method,
					user: s.p,
					query: { space_id: s.spaceId, expected_updated_at: '1' },
					params: { id: crypto.randomUUID() },
					...(method === 'GET'
						? {}
						: { rawBody: 'title=x', contentType: 'application/x-www-form-urlencoded' })
				});
				expect(r.status, `${method} ${routeIdOf(file)}`).toBe(401);
				expect(r.body.error.code).toBe('unauthorized');
			}
		expect(handlers).toBe(Object.keys(ENDPOINTS).length);
		expect(await rows(s.spaceId)).toBe(0);
	});
});
