import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAnthropicKey } from '#lib/server/ai-keys/lookup';
import {
	AI_KEY_INVALID_FORMAT,
	AI_KEY_MISSING,
	AI_KEY_UNREADABLE,
	AI_KEYS_NOT_CONFIGURED,
	AI_TEST_NOT_CONFIGURED,
	AI_TEST_RATE_LIMITED
} from '#lib/server/ai-keys/messages';
import { recordTestResult, saveKey } from '#lib/server/ai-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { exportAccount } from '#lib/server/export/account-export';
import { AI_KEY_TEST_MAX_ATTEMPTS } from '#lib/shared/ai-keys';
import { base64urlEncode } from '#lib/shared/base64url';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { readZip, textOf } from '../helpers/zip';

// FN-41 /pengaturan/integrasi and /pengaturan/integrasi/admin against a local D1. The provider call is the real
// testAnthropicKey with an injected fetch double: no test here reaches the network, the gateway or Anthropic.

const { fakeFetch } = vi.hoisted(() => ({
	fakeFetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
}));
vi.mock('#lib/server/ai-keys/anthropic', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/ai-keys/anthropic')>();
	return {
		...actual,
		testAnthropicKey: (env: Parameters<typeof actual.testAnthropicKey>[0], key: string) =>
			actual.testAnthropicKey(env, key, fakeFetch as unknown as typeof fetch)
	};
});

const ENC = base64urlEncode(new Uint8Array(32).fill(11));
const ENC_NEXT = base64urlEncode(new Uint8Array(32).fill(12));
const binding: Record<string, string | D1Database | undefined> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/pengaturan/integrasi/+page.server');
const admin = await import('../../src/routes/pengaturan/integrasi/admin/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

function configure(
	o: { enc?: string; previous?: string; gateway?: boolean; admins?: string } = {}
) {
	for (const k of Object.keys(binding)) delete binding[k];
	binding.DB = d1;
	binding.AI_KEYS_ENCRYPTION_KEY = 'enc' in o ? o.enc : ENC;
	binding.AI_KEYS_ENCRYPTION_KEY_PREVIOUS = o.previous;
	if (o.gateway !== false) {
		binding.AI_GATEWAY_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
		binding.AI_GATEWAY_ID = 'montra-test';
	}
	binding.ADMIN_ACCOUNT_IDS = o.admins;
}
beforeEach(() => {
	configure();
	fakeFetch.mockReset();
	fakeFetch.mockImplementation(async () => new Response('{"id":"msg_test"}', { status: 200 }));
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function person() {
	const email = `integrasi${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { id: r.userId, email, name: 'Uji', createdAt: 0 };
}
type Person = Awaited<ReturnType<typeof person>>;
const keyOf = (i: number) => `sk-ant-api03-synthetic-${String(i).padStart(4, '0')}-AbCdEfGh`;

const ev = (who: Person | null, form?: Record<string, string>, path = '/pengaturan/integrasi') =>
	fakeEvent({
		url: `http://localhost${path}`,
		routeId: path === '/pengaturan/integrasi' ? '/(app)/pengaturan/integrasi' : path,
		db,
		user: who,
		form
	}).event as never;

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail' as const,
				status: value.status,
				data: value.data as unknown as { error: string }
			};
		return { kind: 'ok' as const, value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}
type Action = 'save' | 'delete' | 'test';
const act = (who: Person | null, name: Action, form: Record<string, string> = {}) =>
	run(() => (page.actions as Record<string, (e: never) => unknown>)[name]!(ev(who, form)));
const save = (who: Person, key: string) => act(who, 'save', { key });
interface LoadData {
	configured: boolean;
	testConfigured: boolean;
	keys: {
		provider: string;
		lastFour: string;
		createdAt: number;
		updatedAt: number;
		lastTestedAt: number | null;
		lastTestResult: string | null;
	}[];
	loadError: string | null;
}
const load = async (who: Person) => (await page.load(ev(who) as never)) as unknown as LoadData;

interface Row {
	id: string;
	encrypted_key: string;
	key_nonce: string;
	key_key_id: string;
	last_four: string;
	created_at: number;
	updated_at: number;
	last_tested_at: number | null;
	last_test_result: string | null;
}
const rowsOf = (userId: string) =>
	db.all<Row>(sql`select * from ai_keys where user_id = ${userId}`);
const auditOf = async (userId: string) =>
	(
		await db.all<{ action: string }>(
			sql`select action from ai_key_audit where user_id = ${userId} order by created_at, rowid`
		)
	).map((r) => r.action);

describe('/pengaturan/integrasi: access (criteria 1, 2)', () => {
	it('sends a signed-out visitor to /masuk on load and on every action', async () => {
		expect(await run(() => page.load(ev(null) as never))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/masuk'
		});
		for (const name of ['save', 'delete', 'test'] as const)
			expect(await act(null, name, { key: keyOf(1) })).toMatchObject({
				kind: 'redirect',
				location: '/masuk'
			});
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('every action addresses only the session user’s row; another user’s key is untouched and unseen', async () => {
		const a = await person();
		const b = await person();
		await save(a, keyOf(1));
		expect((await load(b)).keys).toEqual([]);
		// B's actions never reach A's row, whatever the form carries.
		expect(await act(b, 'test', { userId: a.id, id: (await rowsOf(a.id))[0]!.id })).toMatchObject({
			kind: 'fail',
			status: 404,
			data: { error: AI_KEY_MISSING }
		});
		expect(await act(b, 'delete', { userId: a.id })).toMatchObject({ kind: 'fail', status: 404 });
		expect(fakeFetch).not.toHaveBeenCalled();
		expect(await rowsOf(a.id)).toHaveLength(1);
		expect(await resolveAnthropicKey(db, a.id, binding)).toBe(keyOf(1));
		expect(await resolveAnthropicKey(db, b.id, binding)).toBeNull();
	});
});

describe('save, replace, delete (criteria 6–10, 12)', () => {
	it('stores one sealed row with a created audit row and shows only the masked view', async () => {
		const p = await person();
		const key = keyOf(2);
		const r = await save(p, key);
		expect(r).toEqual({ kind: 'ok', value: { done: 'created' } });
		const [row, ...more] = await rowsOf(p.id);
		expect(more).toEqual([]);
		expect(row!.last_four).toBe(key.slice(-4));
		expect(row!.encrypted_key).not.toContain('sk-ant');
		expect(row!.last_tested_at).toBeNull();
		expect(await auditOf(p.id)).toEqual(['created']);
		// A fresh load (a full reload) reads it back from D1.
		const data = await load(p);
		expect(data).toMatchObject({ configured: true, testConfigured: true, loadError: null });
		expect(data.keys).toEqual([
			{
				provider: 'anthropic',
				lastFour: key.slice(-4),
				createdAt: row!.created_at,
				updatedAt: row!.created_at,
				lastTestedAt: null,
				lastTestResult: null
			}
		]);
		const text = JSON.stringify([data, r]);
		for (const secret of [key, row!.encrypted_key, row!.key_nonce, row!.key_key_id, 'sk-ant'])
			expect(text).not.toContain(secret);
	});

	it('"Ganti kunci" replaces the ciphertext in place and resets the test state', async () => {
		const p = await person();
		await save(p, keyOf(3));
		expect((await act(p, 'test')).kind).toBe('ok');
		const [before] = await rowsOf(p.id);
		expect(before!.last_test_result).toBe('ok');
		expect(await save(p, keyOf(4))).toEqual({ kind: 'ok', value: { done: 'replaced' } });
		const after = await rowsOf(p.id);
		expect(after).toHaveLength(1);
		expect(after[0]!.id).not.toBe(before!.id);
		expect(after[0]!.encrypted_key).not.toBe(before!.encrypted_key);
		expect(after[0]!.created_at).toBe(before!.created_at);
		expect(after[0]!.last_tested_at).toBeNull();
		expect(after[0]!.last_test_result).toBeNull();
		expect(await resolveAnthropicKey(db, p.id, binding)).toBe(keyOf(4));
		expect(await auditOf(p.id)).toEqual(['created', 'test_ok', 'replaced']);
	});

	it('"Hapus kunci" deletes the row for real; a repeated delete answers 404 and audits nothing', async () => {
		const p = await person();
		await save(p, keyOf(5));
		expect(await act(p, 'delete')).toEqual({ kind: 'ok', value: { done: 'removed' } });
		expect(await rowsOf(p.id)).toEqual([]);
		expect((await load(p)).keys).toEqual([]);
		expect(await act(p, 'delete')).toEqual({
			kind: 'fail',
			status: 404,
			data: { error: AI_KEY_MISSING }
		});
		expect(await auditOf(p.id)).toEqual(['created', 'removed']);
		expect(await resolveAnthropicKey(db, p.id, binding)).toBeNull();
	});

	it('refuses a malformed key with one message, never echoing the pasted text', async () => {
		const p = await person();
		for (const key of [
			'',
			'sk-proj-abcdefghijklmnopqrstuvwxyz',
			'sk-ant-short',
			'sk-ant-' + 'x'.repeat(400)
		]) {
			const r = await save(p, key);
			expect(r).toEqual({ kind: 'fail', status: 400, data: { error: AI_KEY_INVALID_FORMAT } });
		}
		expect(await rowsOf(p.id)).toEqual([]);
		expect(await auditOf(p.id)).toEqual([]);
	});

	it('stores nothing while AI_KEYS_ENCRYPTION_KEY is unset or not 32 bytes (criterion 10)', async () => {
		const p = await person();
		for (const enc of [undefined, '', base64urlEncode(new Uint8Array(31))]) {
			configure({ enc });
			expect(await save(p, keyOf(6))).toEqual({
				kind: 'fail',
				status: 503,
				data: { error: AI_KEYS_NOT_CONFIGURED }
			});
			expect((await load(p)).configured).toBe(false);
		}
		expect(await rowsOf(p.id)).toEqual([]);
		expect(await auditOf(p.id)).toEqual([]);
	});

	it('never logs the key (criterion 12)', async () => {
		const logs = [
			vi.spyOn(console, 'log'),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'info')
		];
		const p = await person();
		const key = keyOf(7);
		await save(p, key);
		fakeFetch.mockImplementation(async () => {
			throw new Error(`boom ${key}`);
		});
		await act(p, 'test');
		await act(p, 'delete');
		for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain('sk-ant');
	});
});

describe('"Tes koneksi" (criteria 13–18)', () => {
	const respond = (status: number, body: string) =>
		fakeFetch.mockImplementation(async () => new Response(body, { status }));
	const anthropicError = (type: string) =>
		JSON.stringify({ type: 'error', error: { type, message: 'x' } });

	it('ok: one call with the user’s own key through the gateway; result and audit stored', async () => {
		const p = await person();
		await save(p, keyOf(10));
		expect(await act(p, 'test')).toEqual({ kind: 'ok', value: { tested: 'ok' } });
		expect(fakeFetch).toHaveBeenCalledTimes(1);
		const [url, init] = fakeFetch.mock.calls[0]!;
		expect(url).toBe(
			'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/montra-test/anthropic/v1/messages'
		);
		expect((init.headers as Record<string, string>)['x-api-key']).toBe(keyOf(10));
		const [row] = await rowsOf(p.id);
		expect(row!.last_test_result).toBe('ok');
		expect(row!.last_tested_at).toBeGreaterThan(0);
		expect(await auditOf(p.id)).toEqual(['created', 'test_ok']);
		expect((await load(p)).keys[0]).toMatchObject({ lastTestResult: 'ok' });
	});

	it('invalid and quota are stored distinctly; the key stays stored', async () => {
		const p = await person();
		await save(p, keyOf(11));
		respond(401, anthropicError('authentication_error'));
		expect(await act(p, 'test')).toEqual({ kind: 'ok', value: { tested: 'invalid' } });
		expect((await rowsOf(p.id))[0]!.last_test_result).toBe('invalid');
		respond(429, anthropicError('rate_limit_error'));
		expect(await act(p, 'test')).toEqual({ kind: 'ok', value: { tested: 'quota' } });
		expect((await rowsOf(p.id))[0]!.last_test_result).toBe('quota');
		expect(await resolveAnthropicKey(db, p.id, binding)).toBe(keyOf(11));
		expect(await auditOf(p.id)).toEqual(['created', 'test_failed', 'test_failed']);
	});

	it('network, timeout or 5xx leaves a previous result as it was (criterion 16)', async () => {
		const p = await person();
		await save(p, keyOf(12));
		await act(p, 'test');
		const [ok] = await rowsOf(p.id);
		for (const fail of [
			() => respond(503, 'unavailable'),
			() => respond(529, anthropicError('overloaded_error')),
			() =>
				fakeFetch.mockImplementation(async () => {
					throw new TypeError('fetch failed');
				})
		]) {
			fail();
			expect(await act(p, 'test')).toEqual({ kind: 'ok', value: { tested: 'network' } });
			const [row] = await rowsOf(p.id);
			expect(row!.last_test_result).toBe('ok');
			expect(row!.last_tested_at).toBe(ok!.last_tested_at);
		}
	});

	it('a retired test model is its own outcome; the key and the stored result stay as they were', async () => {
		const p = await person();
		await save(p, keyOf(21));
		await act(p, 'test');
		const [ok] = await rowsOf(p.id);
		respond(404, anthropicError('not_found_error'));
		expect(await act(p, 'test')).toEqual({ kind: 'ok', value: { tested: 'model_unavailable' } });
		const [row] = await rowsOf(p.id);
		expect(row!.last_test_result).toBe('ok');
		expect(row!.last_tested_at).toBe(ok!.last_tested_at);
		expect(await resolveAnthropicKey(db, p.id, binding)).toBe(keyOf(21));
		expect(await auditOf(p.id)).toEqual(['created', 'test_ok', 'test_failed']);
	});

	it('the 6th attempt in a window is refused before any provider call (criterion 17)', async () => {
		const mid = Math.floor(Date.now() / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS + 1000;
		vi.spyOn(Date, 'now').mockReturnValue(mid);
		const p = await person();
		await save(p, keyOf(13));
		for (let i = 0; i < AI_KEY_TEST_MAX_ATTEMPTS; i++)
			expect((await act(p, 'test')).kind).toBe('ok');
		expect(await act(p, 'test')).toEqual({
			kind: 'fail',
			status: 429,
			data: { error: AI_TEST_RATE_LIMITED }
		});
		expect(fakeFetch).toHaveBeenCalledTimes(AI_KEY_TEST_MAX_ATTEMPTS);
		// Another user has their own budget.
		const q = await person();
		await save(q, keyOf(14));
		expect((await act(q, 'test')).kind).toBe('ok');
	});

	it('without the gateway ids: no call, "Belum dikonfigurasi"; saving, replacing and deleting still work', async () => {
		configure({ gateway: false });
		const p = await person();
		expect(await save(p, keyOf(15))).toMatchObject({ kind: 'ok' });
		expect((await load(p)).testConfigured).toBe(false);
		expect(await act(p, 'test')).toEqual({
			kind: 'fail',
			status: 503,
			data: { error: AI_TEST_NOT_CONFIGURED }
		});
		expect(await save(p, keyOf(16))).toEqual({ kind: 'ok', value: { done: 'replaced' } });
		expect(await act(p, 'delete')).toMatchObject({ kind: 'ok' });
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('a key that no longer opens is reported, never sent', async () => {
		const p = await person();
		await save(p, keyOf(17));
		configure({ enc: ENC_NEXT });
		expect(await act(p, 'test')).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: AI_KEY_UNREADABLE }
		});
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('a result is never stamped on a key replaced while the test ran', async () => {
		const p = await person();
		await save(p, keyOf(18));
		const oldId = (await rowsOf(p.id))[0]!.id;
		await saveKey(db, p.id, 'anthropic', keyOf(19), binding, Date.now());
		expect(await recordTestResult(db, p.id, 'anthropic', oldId, 'invalid', Date.now())).toBe(false);
		const [row] = await rowsOf(p.id);
		expect(row!.last_test_result).toBeNull();
		expect(await auditOf(p.id)).toEqual(['created', 'replaced']);
	});
});

describe('resolveAnthropicKey (criteria 19, 20, 11)', () => {
	it('returns the user’s own key, null without one or when it cannot be opened; previous key still opens', async () => {
		const p = await person();
		expect(await resolveAnthropicKey(db, p.id, binding)).toBeNull();
		await save(p, keyOf(20));
		expect(await resolveAnthropicKey(db, p.id, binding)).toBe(keyOf(20));
		expect(await resolveAnthropicKey(db, p.id, { AI_KEYS_ENCRYPTION_KEY: ENC_NEXT })).toBeNull();
		expect(await resolveAnthropicKey(db, p.id, {})).toBeNull();
		expect(await resolveAnthropicKey(db, p.id, undefined)).toBeNull();
		// Rotation: the row sealed under the old key opens through _PREVIOUS.
		expect(
			await resolveAnthropicKey(db, p.id, {
				AI_KEYS_ENCRYPTION_KEY: ENC_NEXT,
				AI_KEYS_ENCRYPTION_KEY_PREVIOUS: ENC
			})
		).toBe(keyOf(20));
		// No fallback to anything app-wide: an unknown user is null.
		expect(await resolveAnthropicKey(db, 'no-such-user', binding)).toBeNull();
	});

	it('never throws, even when the database fails', async () => {
		const broken = getDb({
			prepare: () => {
				throw new Error('D1_ERROR: unavailable');
			},
			batch: () => Promise.reject(new Error('D1_ERROR: unavailable'))
		} as unknown as D1Database);
		expect(await resolveAnthropicKey(broken, 'u1', binding)).toBeNull();
	});
});

describe('concurrency probes (criterion 27)', () => {
	it('20 concurrent saves: one row holding one of the submitted keys, 1 created + 19 replaced', async () => {
		const p = await person();
		const keys = Array.from({ length: 20 }, (_, i) => keyOf(100 + i));
		const results = await Promise.all(keys.map((k) => save(p, k)));
		expect(results.every((r) => r.kind === 'ok')).toBe(true);
		const rows = await rowsOf(p.id);
		expect(rows).toHaveLength(1);
		const stored = await resolveAnthropicKey(db, p.id, binding);
		expect(keys).toContain(stored);
		expect(rows[0]!.last_four).toBe(stored!.slice(-4));
		const audit = await auditOf(p.id);
		expect(audit.filter((a) => a === 'created')).toHaveLength(1);
		expect(audit.filter((a) => a === 'replaced')).toHaveLength(19);
	});

	it('20 concurrent deletes: one removed audit row', async () => {
		const p = await person();
		await save(p, keyOf(200));
		const results = await Promise.all(Array.from({ length: 20 }, () => act(p, 'delete')));
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
		expect(await auditOf(p.id)).toEqual(['created', 'removed']);
	});

	it('20 concurrent tests: exactly the budget reaches the provider', async () => {
		const mid = Math.floor(Date.now() / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS + 1000;
		vi.spyOn(Date, 'now').mockReturnValue(mid);
		const p = await person();
		await save(p, keyOf(300));
		const results = await Promise.all(Array.from({ length: 20 }, () => act(p, 'test')));
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(AI_KEY_TEST_MAX_ATTEMPTS);
		expect(results.filter((r) => r.kind === 'fail' && r.status === 429)).toHaveLength(
			20 - AI_KEY_TEST_MAX_ATTEMPTS
		);
		expect(fakeFetch).toHaveBeenCalledTimes(AI_KEY_TEST_MAX_ATTEMPTS);
	});
});

describe('/pengaturan/integrasi/admin (criteria 3–5, 28; FN-30 hardening 24–27)', () => {
	const PATH = '/pengaturan/integrasi/admin';
	const view = (who: Person | null) => run(() => admin.load(ev(who, undefined, PATH) as never));
	const NOT_FOUND = { kind: 'error', status: 404, body: { message: 'Not Found', status: 404 } };

	it('answers 404 alike to a signed-out visitor, a non-admin and everyone while ADMIN_ACCOUNT_IDS is unset', async () => {
		const owner = await person();
		const other = await person();
		configure({ admins: owner.id });
		expect((await view(owner)).kind).toBe('ok');
		expect(await view(null)).toEqual(NOT_FOUND);
		expect(await view(other)).toEqual(NOT_FOUND);
		configure({ admins: undefined });
		expect(await view(owner)).toEqual(NOT_FOUND);
		configure({ admins: '' });
		expect(await view(owner)).toEqual(NOT_FOUND);
		configure({ admins: ',' });
		expect(await view(owner)).toEqual(NOT_FOUND);
	});

	it('an e-mail is never an admin credential: a listed address admits nobody (red team L1)', async () => {
		const owner = await person();
		// What an operator might have put in the old ADMIN_EMAILS: the address of an account that registered it.
		configure({ admins: owner.email });
		expect(await view(owner)).toEqual(NOT_FOUND);
		configure({ admins: `${owner.email},${owner.id.slice(1)}` });
		expect(await view(owner)).toEqual(NOT_FOUND);
		binding.ADMIN_EMAILS = owner.email;
		expect(await view(owner)).toEqual(NOT_FOUND);
	});

	it('admits a listed account id (case and spaces ignored)', async () => {
		const owner = await person();
		configure({ admins: ` ${owner.id.toUpperCase()} , 00000000-0000-4000-8000-000000000000` });
		expect((await view(owner)).kind).toBe('ok');
	});

	it('shows names and booleans only: no secret value, no other user, and a bare key count', async () => {
		const owner = await person();
		const user = await person();
		configure({ admins: owner.id, previous: ENC_NEXT });
		const secrets = {
			VAPID_PUBLIC_KEY: 'BPUBLIC-vapid-value-should-not-leak',
			VAPID_PRIVATE_KEY: 'private-vapid-value-should-not-leak',
			CONNECTED_APPS_ENCRYPTION_KEY: base64urlEncode(new Uint8Array(32).fill(21)),
			SUPPORT_EMAIL: 'dukungan-should-not-leak@contoh.id',
			BILLING_MOCK_ENABLED: '1',
			MOCK_PAYMENT_WEBHOOK_SECRET: 'mock-secret-should-not-leak-0123456789abcdef',
			CLAIM_HASH_KEY: base64urlEncode(new Uint8Array(32).fill(31)),
			APP_ENV: 'staging',
			// FN-50: both Turnstile values set: the row says `ok`, never a value.
			TURNSTILE_SITE_KEY: 'turnstile-site-key-should-not-leak',
			TURNSTILE_SECRET_KEY: 'turnstile-secret-should-not-leak-0123'
		};
		Object.assign(binding, secrets);
		const before = (await view(owner)) as {
			kind: 'ok';
			value: { keyCount: number; refunds: unknown };
		};
		await save(user, keyOf(400));
		const r = (await view(owner)) as { kind: 'ok'; value: Record<string, unknown> };
		expect(r.kind).toBe('ok');
		expect(r.value).toEqual({
			webPush: 'partial',
			turnstile: 'ok',
			connectedApps: { configured: true, previous: false },
			aiKeys: { configured: true, previous: true },
			claimHash: { configured: true, previous: false },
			supportEmail: true,
			aiGateway: true,
			billingMock: { enabled: true, webhookSecret: true },
			appEnv: 'staging',
			keyCount: before.value.keyCount + 1,
			refunds: before.value.refunds
		});
		const text = JSON.stringify(r);
		for (const value of [
			...Object.values(secrets).filter((v) => v.length > 8),
			ENC,
			ENC_NEXT,
			'0123456789abcdef0123456789abcdef',
			'montra-test',
			user.email,
			user.id,
			owner.email
		])
			expect(text).not.toContain(value);
	});

	it('lists pending refunds without any person, and keeps the other lines when that query fails (criterion 27)', async () => {
		const owner = await person();
		const payer = await person();
		configure({ admins: owner.id });
		await d1.batch([
			d1
				.prepare(
					`insert into billing_events (id, user_id, provider, provider_event_id, kind, reference, plan,
						amount_minor, currency, signature_valid, created_at)
					values (?, ?, 'mock', ?, 'paid_not_applied', ?, 'pro', 4900000, 'IDR', 1, ?)`
				)
				.bind(
					`ev-adm-${payer.id}`,
					payer.id,
					`pe-adm-${payer.id}`,
					`ref-adm-${payer.id}`,
					Date.now()
				),
			d1
				.prepare(
					`insert into billing_refunds (id, billing_event_id, user_id, provider, reference, amount_minor,
						currency, reason, status, created_at, updated_at)
					values (?, ?, ?, 'mock', ?, 4900000, 'IDR', 'plan_higher', 'pending', ?, ?)`
				)
				.bind(
					`rf-adm-1`,
					`ev-adm-${payer.id}`,
					payer.id,
					`ref-adm-${payer.id.slice(0, 8)}`,
					Date.now(),
					Date.now()
				)
		]);
		const r = (await view(owner)) as {
			kind: 'ok';
			value: { refunds: { count: number; rows: Record<string, unknown>[] }; keyCount: number };
		};
		expect(r.value.refunds.count).toBeGreaterThanOrEqual(1);
		expect(r.value.refunds.rows).toContainEqual(
			expect.objectContaining({
				reference: `ref-adm-${payer.id.slice(0, 8)}`,
				reason: 'plan_higher'
			})
		);
		const text = JSON.stringify(r.value.refunds);
		for (const value of [payer.id, payer.email, owner.id, owner.email, 'Uji'])
			expect(text).not.toContain(value);

		// A failing refund query: the error state (null), every other line still there.
		await d1.prepare('alter table billing_refunds rename to billing_refunds_away').run();
		try {
			const failed = (await view(owner)) as { kind: 'ok'; value: Record<string, unknown> };
			expect(failed.kind).toBe('ok');
			expect(failed.value.refunds).toBeNull();
			expect(failed.value.keyCount).toBe(r.value.keyCount);
			expect(failed.value.aiKeys).toEqual({ configured: true, previous: false });
		} finally {
			await d1.prepare('alter table billing_refunds_away rename to billing_refunds').run();
		}
	});

	it('shows CLAIM_HASH_KEY as not configured while unset or malformed (criterion 19)', async () => {
		const owner = await person();
		configure({ admins: owner.id });
		const claim = async () =>
			((await view(owner)) as unknown as { value: { claimHash: unknown } }).value.claimHash;
		expect(await claim()).toEqual({ configured: false, previous: false });
		binding.CLAIM_HASH_KEY = base64urlEncode(new Uint8Array(31).fill(1));
		binding.CLAIM_HASH_KEY_PREVIOUS = base64urlEncode(new Uint8Array(32).fill(2));
		expect(await claim()).toEqual({ configured: false, previous: true });
	});
});

describe('account deletion and export (criteria 24, 25)', () => {
	it('deleting the account deletes the key and its audit trail', async () => {
		const p = await person();
		const other = await person();
		await save(p, keyOf(500));
		await save(other, keyOf(501));
		const proof = await signInWithPassword(db, p.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, p.id, proof.hash)).toBe(true);
		expect(await rowsOf(p.id)).toEqual([]);
		expect(await auditOf(p.id)).toEqual([]);
		expect(await rowsOf(other.id)).toHaveLength(1);
	});

	it('account.json says a key exists and when; the ZIP holds no key material', async () => {
		const p = await person();
		const without = await person();
		await save(p, keyOf(600));
		await act(p, 'test');
		const [row] = await rowsOf(p.id);
		const zipOf = async (userId: string) => {
			const r = await exportAccount(db, userId);
			if (!r.ok) throw new Error('export failed');
			return readZip(new Uint8Array(await new Response(r.stream).arrayBuffer()));
		};
		const files = await zipOf(p.id);
		const account = JSON.parse(textOf(files.get('account.json')!));
		expect(account.aiKeys).toEqual({
			hasAnthropicKey: true,
			anthropicKeyAddedAt: expect.stringMatching(/\+07:00$/),
			anthropicKeyReplacedAt: null,
			anthropicKeyLastTestedAt: expect.stringMatching(/\+07:00$/)
		});
		expect(account.notIncluded.map((x: { table: string }) => x.table)).toEqual(
			expect.arrayContaining(['ai_keys', 'ai_key_audit'])
		);
		const all = [...files.values()].map(textOf).join('\n');
		for (const secret of [
			keyOf(600),
			row!.encrypted_key,
			row!.key_nonce,
			row!.key_key_id,
			'sk-ant'
		])
			expect(all).not.toContain(secret);
		expect(JSON.parse(textOf((await zipOf(without.id)).get('account.json')!)).aiKeys).toEqual({
			hasAnthropicKey: false,
			anthropicKeyAddedAt: null,
			anthropicKeyReplacedAt: null,
			anthropicKeyLastTestedAt: null
		});
	});
});
