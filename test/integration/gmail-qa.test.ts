import { readFileSync, readdirSync } from 'node:fs';
import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { GMAIL_SCOPE } from '#lib/server/gmail/google';
import { GMAIL_NOT_CONNECTED } from '#lib/server/gmail/messages';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { base64urlEncode } from '#lib/shared/base64url';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { fakeGoogle, type FakeGoogle } from '../helpers/fake-google';

// QA cycle 1 (fn-19-gmail): extra checks beside test/integration/gmail.test.ts. Google is the in-memory fake; nothing
// here reaches Google or Anthropic.

const hoisted = vi.hoisted(() => ({ fetch: null as typeof fetch | null }));
vi.mock('#lib/server/gmail/google', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/server/gmail/google')>();
	return {
		...real,
		googleClient: (f?: typeof fetch) => real.googleClient(f ?? (hoisted.fetch as typeof fetch))
	};
});
const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/pengaturan/aplikasi/gmail/+page.server');
const callback = await import('../../src/routes/(app)/pengaturan/aplikasi/gmail/callback/+server');

const ORIGIN = 'http://localhost:8787';
const KEY = base64urlEncode(new Uint8Array(32).fill(5));
let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let google: FakeGoogle;
let n = 0;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());
beforeEach(() => {
	for (const k of Object.keys(binding)) delete binding[k];
	google = fakeGoogle();
	hoisted.fetch = google.fetchFn;
	Object.assign(binding, {
		DB: d1,
		GOOGLE_OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com',
		GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-client-secret-value',
		GOOGLE_OAUTH_REDIRECT_ORIGIN: ORIGIN,
		CONNECTED_APPS_ENCRYPTION_KEY: KEY,
		JOBS_QUEUE: { sendBatch: async () => {}, send: async () => {} }
	});
});

async function person() {
	const email = `gmailqa${++n}@mail.example`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	return {
		user: { id: r.userId, email, name: 'Uji', createdAt: 0 },
		space: { id: space.id, kind: space.kind, name: space.name, role: space.role },
		session: `qa-session-${n}-${crypto.randomUUID()}`
	};
}
type Person = Awaited<ReturnType<typeof person>>;

const ev = (who: Person, init: { url?: string; form?: Record<string, string> } = {}) =>
	fakeEvent({
		url: init.url ?? `${ORIGIN}/pengaturan/aplikasi/gmail`,
		routeId: '/(app)/pengaturan/aplikasi/gmail',
		db,
		user: who.user,
		space: who.space,
		sessionToken: who.session,
		form: init.form
	});

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail',
				status: value.status,
				error: (value.data as unknown as { error: string }).error
			};
		return { kind: 'ok', value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect', status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error', status: e.status };
		throw e;
	}
}
const act = (who: Person, name: string, form: Record<string, string> = {}) =>
	run(() =>
		(page.actions as Record<string, (e: never) => unknown>)[name]!(ev(who, { form }).event as never)
	);

async function connect(p: Person) {
	const r = await act(p, 'connect', { spaceId: p.space.id });
	if (r.kind !== 'ok') throw new Error(`connect: ${JSON.stringify(r)}`);
	const state = new URL((r.value as { authUrl: string }).authUrl).searchParams.get('state')!;
	await callbackWith(p, state);
	return state;
}
async function callbackWith(p: Person, state: string) {
	const e = ev(p, {
		url: `${ORIGIN}/pengaturan/aplikasi/gmail/callback?state=${state}&code=auth-code-xyz&scope=${GMAIL_SCOPE}`
	});
	return run(() => callback.GET(e.event as never));
}
const connectionOf = (userId: string) =>
	db.get<{ id: string; updated_at: number }>(
		`select id, updated_at from gmail_connections where user_id = '${userId}'` as never
	);
const count = async (table: string, where = '1 = 1') =>
	(await d1.prepare(`select count(*) as n from ${table} where ${where}`).first<{ n: number }>())!.n;

describe('QA: another user with REAL ids reads exactly like unknown ids (AC 4, 42)', () => {
	it('checkNow, lookback, stopLookback, disconnect, target, autoCheck: same answer as for ids that do not exist; nothing changes', async () => {
		const p = await person();
		const other = await person();
		await connect(p);
		const c = (await d1
			.prepare('select id, updated_at from gmail_connections where user_id = ?')
			.bind(p.user.id)
			.first<{ id: string; updated_at: number }>())!;
		expect((await act(p, 'lookback', { connectionId: c.id, days: '7' })).kind).toBe('ok');
		const scan = (await d1
			.prepare(`select id from gmail_scans where connection_id = ? and kind = 'lookback'`)
			.bind(c.id)
			.first<{ id: string }>())!;
		const real = { connectionId: c.id, updatedAt: String(c.updated_at) };
		const fake = { connectionId: 'nope', updatedAt: String(c.updated_at) };
		const missing = { kind: 'fail', status: 404, error: GMAIL_NOT_CONNECTED };
		for (const [name, extra] of [
			['checkNow', {}],
			['lookback', { days: '7' }],
			['disconnect', {}],
			['target', { spaceId: other.space.id }],
			['autoCheck', { on: '0' }]
		] as const) {
			const asReal = await act(other, name, { ...real, ...extra });
			const asFake = await act(other, name, { ...fake, ...extra });
			expect(asReal, name).toEqual(asFake);
			// "target" with a space the other user owns still must not move p's connection.
		}
		expect(await act(other, 'stopLookback', { scanId: scan.id })).toEqual(missing);
		expect(await act(other, 'stopLookback', { scanId: 'nope' })).toEqual(missing);
		const after = await d1
			.prepare(
				`select (select status from gmail_scans where id = ?) as scan, c.space_id, c.auto_check, c.updated_at
				 from gmail_connections c where c.id = ?`
			)
			.bind(scan.id, c.id)
			.first<Record<string, unknown>>();
		expect(after).toMatchObject({
			scan: 'running',
			space_id: p.space.id,
			auto_check: 1,
			updated_at: c.updated_at
		});
		expect(await count('gmail_connections', `user_id = '${other.user.id}'`)).toBe(0);
		expect(await count('gmail_scans', `user_id = '${other.user.id}'`)).toBe(0);
		// A "reread" by the other user finds no connection of theirs.
		expect(await act(other, 'reread')).toEqual(missing);
	});
});

describe('QA: forged look-back values (AC 31, 45)', () => {
	it('anything but 7/30/90/180/365 is 400, never a scan or a 500; Gratis refuses 30 with 403', async () => {
		const p = await person();
		await connect(p);
		const c = (await d1
			.prepare('select id from gmail_connections where user_id = ?')
			.bind(p.user.id)
			.first<{ id: string }>())!;
		for (const days of [
			'',
			'0',
			'-7',
			'7.5',
			'30abc',
			'1e1',
			'99999',
			'7\u0000',
			'9'.repeat(400)
		]) {
			const r = await act(p, 'lookback', { connectionId: c.id, days });
			expect(r, JSON.stringify(days.slice(0, 12))).toMatchObject({ kind: 'fail', status: 400 });
		}
		expect(await act(p, 'lookback', { connectionId: c.id, days: '30' })).toMatchObject({
			kind: 'fail',
			status: 403
		});
		expect(await count('gmail_scans', `connection_id = '${c.id}' and kind = 'lookback'`)).toBe(0);
	});
});

describe('QA: a second authorization completed while already connected (two tabs)', () => {
	it('keeps one connection row and does not crash; the second flow replaces the token on the same row', async () => {
		const p = await person();
		const r1 = await act(p, 'connect', { spaceId: p.space.id });
		const r2 = await act(p, 'connect', { spaceId: p.space.id });
		const s = (r: typeof r1) =>
			new URL((r as unknown as { value: { authUrl: string } }).value.authUrl).searchParams.get(
				'state'
			)!;
		await callbackWith(p, s(r1));
		const first = await connectionOf(p.user.id);
		await callbackWith(p, s(r2));
		expect(await count('gmail_connections', `user_id = '${p.user.id}'`)).toBe(1);
		expect((await connectionOf(p.user.id))!.id).toBe(first!.id);
	});
});

describe('QA: no assistant tool reads mail tables (AC 41)', () => {
	it('src/lib/server/tanya names none of drafts, gmail_mail, gmail_connections, inbound_mail', () => {
		const dir = 'src/lib/server/tanya';
		const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files)
			expect(readFileSync(`${dir}/${f}`, 'utf8'), f).not.toMatch(
				/\b(drafts|gmail_mail|gmailMail|gmail_connections|gmailConnections|inbound_mail|inboundMail|oauth_states)\b/
			);
	});
});
