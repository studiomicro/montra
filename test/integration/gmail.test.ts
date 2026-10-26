import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveKey } from '#lib/server/ai-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { exportAccount } from '#lib/server/export/account-export';
import { processGmailRead, type GmailReadDeps } from '#lib/server/gmail/read';
import { claimAiRead, connectionsDue, sweepGmail } from '#lib/server/gmail/repo';
import { GMAIL_AI_READS_PER_DAY } from '#lib/shared/gmail/ledger';
import { processGmailCheck } from '#lib/server/gmail/scan';
import { findRecipient } from '#lib/server/inbound/repo';
import {
	GMAIL_ALREADY_CONNECTED,
	GMAIL_CALLBACK_RESULTS,
	GMAIL_CHANGED_MEANWHILE,
	GMAIL_LOOKBACK_LIMIT,
	GMAIL_LOOKBACK_PLAN,
	GMAIL_LOOKBACK_RUNNING,
	GMAIL_MISSING_CLIENT,
	GMAIL_MISSING_KEY,
	GMAIL_MISSING_REDIRECT,
	GMAIL_NOT_CONFIGURED,
	GMAIL_NOT_CONNECTED,
	GMAIL_RATE_LIMITED,
	GMAIL_SPACE_NOT_AVAILABLE
} from '#lib/server/gmail/messages';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createSharedSpace } from '#lib/server/spaces/spaces';
import { base64urlEncode } from '#lib/shared/base64url';
import { GMAIL_SCOPE } from '#lib/server/gmail/google';
import { RetryLaterError, type JobMessage } from '#lib/shared/jobs';
import { handleEmail } from '../../workers/inbound/src/process';
import { runCronTick } from '../../workers/jobs/src/cron';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import {
	fakeGoogle,
	gmailFromFixture,
	gmailMessage,
	type FakeGoogle
} from '../helpers/fake-google';
import { bytes, emailMessage, fixtureText } from '../helpers/mail';
import { messagesResponse } from '../helpers/receipts';
import { readZip, textOf } from '../helpers/zip';

// FN-19 Gmail against a local D1: the settings page, the OAuth callback, the jobs Worker's `gmail_check` and
// `gmail_read`, the sweep, disconnect and account deletion. Google is `fakeGoogle()` (an in-memory fetch) and the AI
// is a synthetic stub: no test reaches Google or Anthropic, and a mocked capture never counts as verified (PRD AC
// 49/50 stay NOT verified).

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
const aplikasi = await import('../../src/routes/(app)/pengaturan/aplikasi/+page.server');
const forwardingPage =
	await import('../../src/routes/(app)/pengaturan/aplikasi/email/+page.server');
const { googleClient } = await import('#lib/server/gmail/google');

const KEY = base64urlEncode(new Uint8Array(32).fill(5));
const ENC = base64urlEncode(new Uint8Array(32).fill(9));
const ORIGIN = 'http://localhost:8787';
const GATEWAY = {
	AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	AI_GATEWAY_ID: 'montra-test'
};
const CLIENT = {
	GOOGLE_OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com',
	GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-client-secret-value'
};
const SECRETS = [
	CLIENT.GOOGLE_OAUTH_CLIENT_SECRET,
	'1//refresh-token-secret',
	'ya29.access-from-code',
	'ya29.access-refreshed',
	'auth-code-xyz'
];

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let google: FakeGoogle;
let sent: JobMessage[];
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());
beforeEach(() => {
	for (const k of Object.keys(binding)) delete binding[k];
	google = fakeGoogle();
	hoisted.fetch = google.fetchFn;
	sent = [];
	Object.assign(binding, {
		DB: d1,
		...CLIENT,
		GOOGLE_OAUTH_REDIRECT_ORIGIN: ORIGIN,
		CONNECTED_APPS_ENCRYPTION_KEY: KEY,
		JOBS_QUEUE: {
			sendBatch: async (batch: { body: JobMessage }[]) => {
				sent.push(...batch.map((b) => b.body));
			},
			send: async (body: JobMessage) => {
				sent.push(body);
			}
		}
	});
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function person() {
	const email = `gmail${++n}@mail.example`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	return {
		user: { id: r.userId, email, name: 'Uji', createdAt: 0 },
		space: { id: space.id, kind: space.kind, name: space.name, role: space.role },
		session: `session-${n}-${crypto.randomUUID()}`
	};
}
type Person = Awaited<ReturnType<typeof person>>;

const ev = (
	who: Person | null,
	init: {
		url?: string;
		form?: Record<string, string>;
		session?: string | null;
		cookies?: Record<string, string>;
	} = {}
) =>
	fakeEvent({
		url: init.url ?? `${ORIGIN}/pengaturan/aplikasi/gmail`,
		routeId: '/(app)/pengaturan/aplikasi/gmail',
		db,
		user: who?.user ?? null,
		space: who?.space ?? null,
		sessionToken: init.session === undefined ? (who?.session ?? null) : init.session,
		form: init.form,
		cookies: init.cookies
	});

type Run =
	| { kind: 'fail'; status: number; error: string }
	| { kind: 'ok'; value: Record<string, unknown> }
	| { kind: 'redirect'; status: number; location: string }
	| { kind: 'error'; status: number };
async function run(fn: () => unknown): Promise<Run> {
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
type Action =
	| 'connect'
	| 'disconnect'
	| 'target'
	| 'autoCheck'
	| 'checkNow'
	| 'lookback'
	| 'stopLookback'
	| 'reread';
const act = (
	who: Person | null,
	name: Action,
	form: Record<string, string> = {},
	session?: string
) =>
	run(() =>
		(page.actions as Record<string, (e: never) => unknown>)[name]!(
			ev(who, { form, session }).event as never
		)
	);
interface LoadData {
	configured: boolean;
	missing: string[];
	testing: boolean;
	result: string | null;
	connection: {
		id: string;
		status: string;
		reconnectReason: string | null;
		pausedReason: string | null;
		googleAddress: string | null;
		spaceId: string;
		spaceName: string | null;
		autoCheck: boolean;
		updatedAt: number;
		rereadable: number;
		lookback: { id: string; status: string; listed: number; read: number; drafted: number } | null;
	} | null;
	lookbackMax: number;
}
const load = async (who: Person, cookies?: Record<string, string>) =>
	(await page.load(ev(who, { cookies }).event as never)) as unknown as LoadData;

/** "Hubungkan": the state of the authorization URL the page got. */
async function startConnect(p: Person, spaceId = p.space.id, session = p.session) {
	const r = await act(p, 'connect', { spaceId }, session);
	if (r.kind !== 'ok') throw new Error(`connect: ${JSON.stringify(r)}`);
	const url = new URL(r.value.authUrl as string);
	return { url, state: url.searchParams.get('state')! };
}

async function callbackWith(p: Person | null, query: string, session?: string, origin = ORIGIN) {
	const e = ev(p, { url: `${origin}/pengaturan/aplikasi/gmail/callback?${query}`, session });
	const r = await run(() => callback.GET(e.event as never));
	const flash = e.written.get('gmail_result')?.value ?? null;
	return { r, flash, response: r.kind === 'ok' ? (r.value as unknown as Response) : null };
}

/** Connect `p` end to end through the fake Google. */
async function connect(p: Person, spaceId = p.space.id) {
	const { state } = await startConnect(p, spaceId);
	const out = await callbackWith(p, `state=${state}&code=auth-code-xyz&scope=${GMAIL_SCOPE}`);
	expect(out.flash).toBe('connected');
	return (await load(p)).connection!;
}

const conn = (userId: string) =>
	db.get<Record<string, unknown>>(sql`select * from gmail_connections where user_id = ${userId}`);
const mailRows = (connectionId: string) =>
	db.all<Record<string, unknown>>(
		sql`select * from gmail_mail where connection_id = ${connectionId} order by gmail_id`
	);
const draftsOf = (spaceId: string) =>
	db.all<Record<string, unknown>>(
		sql`select * from drafts where space_id = ${spaceId} order by created_at`
	);
const count = async (table: string, where = '1 = 1') =>
	(await d1.prepare(`select count(*) as n from ${table} where ${where}`).first<{ n: number }>())!.n;

const aiStub = (body: string) =>
	vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
		messagesResponse(body)
	) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const answer = (o: Record<string, unknown> = {}) =>
	JSON.stringify({
		is_payment: true,
		direction: 'expense',
		amount: 'Rp 125.500',
		currency: 'IDR',
		merchant: 'Toko Daring Contoh',
		date: '2026-10-08',
		time: '10:15',
		...o
	});

/** The jobs Worker's dependencies against the fake Google; `queue` collects what the handlers enqueue. */
function jobs(
	opts: { env?: Record<string, unknown>; aiFetch?: typeof fetch; now?: () => number } = {}
) {
	const queue: JobMessage[] = [];
	const deps: GmailReadDeps = {
		db,
		env: { ...CLIENT, CONNECTED_APPS_ENCRYPTION_KEY: KEY, ...opts.env },
		google: googleClient(google.fetchFn),
		tokens: new Map(),
		now: opts.now ?? (() => Date.now()),
		random: () => 0,
		enqueue: async (m) => {
			queue.push(...m);
		},
		aiFetch: opts.aiFetch
	};
	/** Delivers everything queued (and what that enqueues), first delivery each. */
	async function drain(limit = 500) {
		for (let i = 0; i < limit && queue.length > 0; i++) {
			const m = queue.shift()!;
			if (m.type === 'gmail_check') {
				const job = checkJob(m);
				await processGmailCheck(deps, job, 1);
			} else if (m.type === 'gmail_read') await processGmailRead(deps, m.mailId, 1);
		}
	}
	return { deps, queue, drain };
}

/** The handler's input of a `gmail_check` message. */
const checkJob = (m: JobMessage) => {
	if (m.type !== 'gmail_check') throw new Error('not a gmail_check');
	return { connectionId: m.connectionId, kind: m.kind, window: m.window, page: m.page };
};

/** One hourly check of `connectionId` now (window = the current WIB hour). */
async function check(j: ReturnType<typeof jobs>, connectionId: string, window = hourWindow()) {
	j.queue.push({ type: 'gmail_check', connectionId, kind: 'hourly', window, page: 0 });
	await j.drain();
}
let windowSeq = 0;
const hourWindow = () =>
	`2026-10-10T${String(6 + (windowSeq++ % 17)).padStart(2, '0')}-${windowSeq}`;

function captureConsole() {
	const lines: string[] = [];
	for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const)
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
		});
	return lines;
}
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

describe('configuration (AC 1, 2)', () => {
	it('unconfigured: "Belum dikonfigurasi" with the reasons in words, connect 503, Aplikasi row says the same', async () => {
		for (const k of Object.keys(CLIENT)) delete binding[k];
		binding.GOOGLE_OAUTH_REDIRECT_ORIGIN = 'https://app.example.com/';
		delete binding.CONNECTED_APPS_ENCRYPTION_KEY;
		const p = await person();
		const data = await load(p);
		expect(data.configured).toBe(false);
		expect(data.missing).toEqual([GMAIL_MISSING_CLIENT, GMAIL_MISSING_REDIRECT, GMAIL_MISSING_KEY]);
		expect(JSON.stringify(data)).not.toMatch(/GOOGLE_|ENCRYPTION_KEY/);
		expect(await act(p, 'connect', { spaceId: p.space.id })).toEqual({
			kind: 'fail',
			status: 503,
			error: GMAIL_NOT_CONFIGURED
		});
		const apps = (await aplikasi.load(
			fakeEvent({
				url: `${ORIGIN}/pengaturan/aplikasi`,
				routeId: '/(app)/pengaturan/aplikasi',
				db,
				user: p.user,
				space: p.space
			}).event as never
		)) as unknown as { gmail: { configured: boolean; status: string | null } };
		expect(apps.gmail).toEqual({ configured: false, status: null });
		binding.GOOGLE_OAUTH_REDIRECT_ORIGIN = 'http://evil.example';
		Object.assign(binding, CLIENT, { CONNECTED_APPS_ENCRYPTION_KEY: KEY });
		expect((await load(p)).missing).toEqual([GMAIL_MISSING_REDIRECT]);
	});

	it('signed out: every load and action redirects to /masuk; the callback too', async () => {
		expect(await run(() => page.load(ev(null).event as never))).toMatchObject({
			kind: 'redirect',
			location: '/masuk'
		});
		for (const name of ['connect', 'disconnect', 'target', 'lookback', 'reread'] as const)
			expect(await act(null, name, { spaceId: 'x' })).toMatchObject({ kind: 'redirect' });
		expect((await callbackWith(null, 'state=x&code=y')).r).toMatchObject({
			kind: 'redirect',
			location: '/masuk'
		});
	});
});

describe('connect flow (AC 3, 5, 7–10, 12)', () => {
	it('the authorization URL carries exactly the fixed parameters; the verifier is stored sealed only', async () => {
		const p = await person();
		const { url, state } = await startConnect(p);
		expect(url.searchParams.get('client_id')).toBe(CLIENT.GOOGLE_OAUTH_CLIENT_ID);
		expect(url.searchParams.get('redirect_uri')).toBe(
			`${ORIGIN}/pengaturan/aplikasi/gmail/callback`
		);
		expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPE);
		expect(url.searchParams.get('access_type')).toBe('offline');
		expect(url.searchParams.get('prompt')).toBe('consent');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const row = (await db.get<Record<string, unknown>>(
			sql`select * from oauth_states where user_id = ${p.user.id}`
		))!;
		expect(row.state_hash).not.toBe(state);
		expect(JSON.stringify(row)).not.toContain(state);
		expect(row.expires_at as number).toBe((row.created_at as number) + 10 * 60 * 1000);
	});

	it('callback: exchanges with verifier and secret, seals the token, one row, 303 without a query, no secret anywhere', async () => {
		const lines = captureConsole();
		const p = await person();
		const { url, state } = await startConnect(p);
		const out = await callbackWith(p, `state=${state}&code=auth-code-xyz`);
		expect(out.response!.status).toBe(303);
		expect(out.response!.headers.get('location')).toBe('/pengaturan/aplikasi/gmail');
		expect(out.response!.headers.get('referrer-policy')).toBe('no-referrer');
		expect(out.flash).toBe('connected');
		const exchange = google.state.calls.find((c) => c.endpoint === 'exchange')!;
		const body = new URLSearchParams(exchange.body);
		expect(body.get('client_secret')).toBe(CLIENT.GOOGLE_OAUTH_CLIENT_SECRET);
		expect(body.get('code')).toBe('auth-code-xyz');
		expect(body.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(body.get('code_verifier')!)
		);
		expect(base64urlEncode(digest)).toBe(url.searchParams.get('code_challenge'));
		const row = (await conn(p.user.id))!;
		expect(await count('gmail_connections', `user_id = '${p.user.id}'`)).toBe(1);
		expect(row).toMatchObject({ status: 'connected', space_id: p.space.id, auto_check: 1 });
		expect(row.google_address).toBe('pemilik@gmail.example');
		expect(leaks(JSON.stringify(row))).toEqual([]);
		const data = await load(p, { gmail_result: 'connected' });
		expect(data.result).toBe(GMAIL_CALLBACK_RESULTS.connected);
		expect(data.connection?.status).toBe('connected');
		expect(data.testing).toBe(true);
		const serialised = JSON.stringify(data) + lines.join('\n');
		expect(leaks(serialised)).toEqual([]);
		expect(serialised).not.toContain(state);
		expect(serialised).not.toContain(body.get('code_verifier')!);
		expect(serialised).not.toMatch(/encrypted_token|encryptedToken|tokenNonce/);
	});

	it('state is single-use and bound to user, session and time; every miss is the same neutral result', async () => {
		const a = await person();
		const b = await person();
		const replay = await startConnect(a);
		expect((await callbackWith(a, `state=${replay.state}&code=auth-code-xyz`)).flash).toBe(
			'connected'
		);
		await d1.prepare('delete from gmail_connections where user_id = ?').bind(a.user.id).run();
		const before = google.count('exchange');
		const replayed = await callbackWith(a, `state=${replay.state}&code=auth-code-xyz`);
		const other = await startConnect(a);
		const byOtherUser = await callbackWith(b, `state=${other.state}&code=c`);
		const otherSession = await callbackWith(a, `state=${other.state}&code=c`, 'another-session');
		const expired = await startConnect(a);
		await d1
			.prepare('update oauth_states set expires_at = ? where user_id = ?')
			.bind(Date.now() - 1, a.user.id)
			.run();
		const late = await callbackWith(a, `state=${expired.state}&code=c`);
		const tampered = await callbackWith(a, `state=${'A'.repeat(43)}&code=c`);
		const missing = await callbackWith(a, `code=c`);
		const long = await callbackWith(a, `state=${'A'.repeat(500)}&code=c`);
		const fresh = await startConnect(a);
		const noCode = await callbackWith(a, `state=${fresh.state}`);
		for (const r of [replayed, byOtherUser, otherSession, late, tampered, missing, long, noCode]) {
			expect(r.flash).toBe('failed');
			expect(r.response!.status).toBe(303);
			expect(r.response!.headers.get('location')).toBe('/pengaturan/aplikasi/gmail');
		}
		expect(google.count('exchange')).toBe(before);
		expect(await count('gmail_connections', `user_id in ('${a.user.id}', '${b.user.id}')`)).toBe(0);
	});

	it('20 concurrent callbacks with one state create one connection and exchange once', async () => {
		const p = await person();
		const { state } = await startConnect(p);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => callbackWith(p, `state=${state}&code=auth-code-xyz`))
		);
		expect(results.filter((r) => r.flash === 'connected')).toHaveLength(1);
		expect(google.count('exchange')).toBe(1);
		expect(await count('gmail_connections', `user_id = '${p.user.id}'`)).toBe(1);
	});

	it('access_denied: "Kamu membatalkan izin.", nothing written; missing scope or refresh token: revoked, nothing stored', async () => {
		const p = await person();
		const s1 = await startConnect(p);
		const denied = await callbackWith(p, `state=${s1.state}&error=access_denied`);
		expect(denied.flash).toBe('cancelled');
		expect(google.count('exchange')).toBe(0);
		google.state.exchange.body = { ...google.state.exchange.body, scope: 'openid' };
		const s2 = await startConnect(p);
		expect((await callbackWith(p, `state=${s2.state}&code=c`)).flash).toBe('scope');
		expect(google.count('revoke')).toBe(1);
		expect(new URLSearchParams(google.state.calls.at(-1)!.body).get('token')).toBe(
			'1//refresh-token-secret'
		);
		google.state.exchange.body = { access_token: 'ya29.access-from-code', scope: GMAIL_SCOPE };
		const s3 = await startConnect(p);
		expect((await callbackWith(p, `state=${s3.state}&code=c`)).flash).toBe('scope');
		expect(await conn(p.user.id)).toBeUndefined();
	});

	it('a foreign origin is 404; hostile parameters never change the target or the redirect_uri sent', async () => {
		const p = await person();
		const { state } = await startConnect(p);
		expect(
			(await callbackWith(p, `state=${state}&code=c`, undefined, 'http://evil.example')).r
		).toEqual({ kind: 'error', status: 404 });
		const hostile = [
			'redirect_uri=https://evil.example/cb',
			'next=https://evil.example',
			'return=//evil.example',
			'next=%2F%2Fevil.example',
			'redirect_uri=javascript:alert(1)',
			'state[]=x',
			`code=${'x'.repeat(5000)}`
		];
		for (let i = 0; i < 40; i++) {
			const extra = hostile[i % hostile.length]!;
			await d1.prepare('delete from gmail_connections where user_id = ?').bind(p.user.id).run();
			await d1.prepare('delete from auth_attempts').run();
			const fresh = await startConnect(p);
			const out = await callbackWith(
				p,
				`${extra}&state=${fresh.state}&code=auth-code-xyz&${extra}`
			);
			expect(out.response!.headers.get('location')).toBe('/pengaturan/aplikasi/gmail');
		}
		for (const c of google.state.calls.filter((x) => x.endpoint === 'exchange'))
			expect(new URLSearchParams(c.body).get('redirect_uri')).toBe(
				`${ORIGIN}/pengaturan/aplikasi/gmail/callback`
			);
	});

	it('connect refuses a space the user is not a live member of, an existing connection, and the 11th start (429)', async () => {
		const p = await person();
		const other = await person();
		expect(await act(p, 'connect', { spaceId: other.space.id })).toEqual({
			kind: 'fail',
			status: 404,
			error: GMAIL_SPACE_NOT_AVAILABLE
		});
		for (let i = 0; i < 10; i++) await startConnect(p);
		expect(await count('oauth_states', `user_id = '${p.user.id}'`)).toBe(5);
		expect(await act(p, 'connect', { spaceId: p.space.id })).toEqual({
			kind: 'fail',
			status: 429,
			error: GMAIL_RATE_LIMITED
		});
		const q = await person();
		await connect(q);
		expect(await act(q, 'connect', { spaceId: q.space.id })).toEqual({
			kind: 'fail',
			status: 409,
			error: GMAIL_ALREADY_CONNECTED
		});
	});
});

describe('settings writes and access (AC 4, 11, 35, 42)', () => {
	it('"Dicatat ke" only to a live membership; stale forms answer changed-meanwhile; other users read as missing', async () => {
		const p = await person();
		const other = await person();
		const c = await connect(p);
		const shared = await createSharedSpace(db, p.user.id, 'Keluarga', Date.now());
		const sharedId = shared!;
		const ref = { connectionId: c.id, updatedAt: String(c.updatedAt) };
		expect(await act(p, 'target', { ...ref, spaceId: other.space.id })).toMatchObject({
			status: 404,
			error: GMAIL_SPACE_NOT_AVAILABLE
		});
		expect(await act(p, 'target', { ...ref, spaceId: sharedId })).toEqual({
			kind: 'ok',
			value: { done: 'moved' }
		});
		expect((await load(p)).connection?.spaceId).toBe(sharedId);
		expect(await act(p, 'target', { ...ref, spaceId: p.space.id })).toMatchObject({
			status: 409,
			error: GMAIL_CHANGED_MEANWHILE
		});
		const fresh = (await load(p)).connection!;
		const stolen = { connectionId: fresh.id, updatedAt: String(fresh.updatedAt) };
		const asOther = await act(other, 'target', { ...stolen, spaceId: other.space.id });
		const unknown = await act(other, 'autoCheck', {
			connectionId: 'nope',
			updatedAt: '1',
			on: '0'
		});
		expect(asOther).toEqual({ kind: 'fail', status: 404, error: GMAIL_NOT_CONNECTED });
		expect(unknown).toEqual({ kind: 'fail', status: 404, error: GMAIL_NOT_CONNECTED });
		expect(await act(other, 'disconnect', stolen)).toEqual(unknown);
		expect(await act(other, 'stopLookback', { scanId: 'x' })).toEqual(unknown);
		expect((await load(other)).connection).toBeNull();
		expect(await conn(p.user.id)).toMatchObject({ space_id: sharedId });
	});
});

describe('checking (AC 14–18, 33, 34)', () => {
	it('cron fans out only due connections, none in quiet hours; the toggle stops it at once', async () => {
		const a = await person();
		const b = await person();
		const ca = await connect(a);
		const cb = await connect(b);
		const due = await connectionsDue(db, Date.now(), '', 1000);
		expect(due).toEqual(expect.arrayContaining([ca.id, cb.id]));
		expect(
			await act(b, 'autoCheck', { connectionId: cb.id, updatedAt: String(cb.updatedAt), on: '0' })
		).toEqual({ kind: 'ok', value: { done: 'auto_off' } });
		expect(await connectionsDue(db, Date.now(), '', 1000)).not.toContain(cb.id);
		const tick = async (utc: string) => {
			const enqueued: JobMessage[] = [];
			const cursors = new Map<string, string>();
			await runCronTick(
				{
					spacesWithBudget: async () => [],
					spacesWithSubscriptions: async () => [],
					spacesWithDueSeries: async () => [],
					usersWanting: async () => [],
					usersDueCloseReminder: async () => [],
					gmailConnectionsDue: (after, limit) => connectionsDue(db, Date.now(), after, limit),
					enqueue: async (m) => {
						enqueued.push(...m);
					},
					getCursor: async (k) => cursors.get(k) ?? null,
					setCursor: async (k, v) => {
						cursors.set(k, v);
					}
				},
				Date.parse(utc)
			);
			return enqueued.filter((m) => m.type === 'gmail_check');
		};
		expect(await tick('2026-10-10T20:00:00Z')).toEqual([]); // 03:00 WIB
		const morning = await tick('2026-10-10T23:00:00Z'); // 06:00 WIB
		expect(morning).toContainEqual({
			type: 'gmail_check',
			connectionId: ca.id,
			kind: 'hourly',
			window: '2026-10-11T06',
			page: 0
		});
		expect(morning.some((m) => m.type === 'gmail_check' && m.connectionId === cb.id)).toBe(false);
		// A check queued before the toggle went off is dropped too.
		const j = jobs();
		await check(j, cb.id, '2026-10-11T07');
		expect(google.count('list')).toBe(0);
	});

	it('the 06:00 check lists since checked_through − 120 s (night mail), with the exclusions, maxResults=100, never user text', async () => {
		const p = await person();
		const c = await connect(p);
		// The previous check ended at 23:00 WIB; a payment at 23:30 WIB came in during the quiet hours.
		const through = Math.floor(Date.now() / 1000) - 7 * 60 * 60;
		await d1
			.prepare('update gmail_connections set checked_through = ? where id = ?')
			.bind(through, c.id)
			.run();
		const night = (through + 30 * 60) * 1000;
		google.state.messages.set(
			'night1',
			await gmailFromFixture('bank-qris/payment', 'night1', { authResults: null })
		);
		google.state.messages.get('night1')!['internalDate' as never] = String(night) as never;
		const j = jobs();
		await check(j, c.id, '2026-10-11T06');
		const list = new URL(google.state.calls.find((x) => x.endpoint === 'list')!.url);
		expect(list.searchParams.get('maxResults')).toBe('100');
		const q = list.searchParams.get('q')!;
		expect(q).toContain('-category:promotions -category:social');
		expect(q).toContain(`after:${through - 120} `);
		expect(q).not.toContain(p.user.email);
		const rows = await mailRows(c.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'draft_created', received_at: night });
		expect((await conn(p.user.id))!.checked_through).toBeGreaterThan(through);
	});

	it('a repeated tick, a redelivered page and a double enqueue open one scan; 20 concurrent reads make one draft', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('q1', await gmailFromFixture('bank-qris/payment', 'q1'));
		const j = jobs();
		const msg = {
			type: 'gmail_check' as const,
			connectionId: c.id,
			kind: 'hourly' as const,
			window: 'W-dup',
			page: 0
		};
		await Promise.all([
			processGmailCheck(j.deps, msg, 1),
			processGmailCheck(j.deps, msg, 1),
			processGmailCheck(j.deps, msg, 2)
		]);
		await processGmailCheck(j.deps, msg, 1);
		expect(await count('gmail_scans', `connection_id = '${c.id}'`)).toBe(1);
		expect(await count('gmail_mail', `connection_id = '${c.id}'`)).toBe(1);
		const mailId = (await mailRows(c.id))[0]!.id as string;
		await Promise.all(Array.from({ length: 20 }, () => processGmailRead(j.deps, mailId, 1)));
		expect(await draftsOf(p.space.id)).toHaveLength(1);
		const scan = (await db.get<Record<string, number>>(
			sql`select * from gmail_scans where connection_id = ${c.id}`
		))!;
		expect(scan).toMatchObject({ listed: 1, read: 1, drafted: 1, status: 'done' });
	});

	it('pages are capped at 20 per scan; checked_through advances only after the last page', async () => {
		const p = await person();
		const c = await connect(p);
		const before = (await conn(p.user.id))!.checked_through as number;
		google.state.listIds = Array.from({ length: 2500 }, (_, i) => `id${i}`);
		const j = jobs();
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'hourly',
			window: 'W-cap',
			page: 0
		});
		// Pages only (reads dropped): run the check messages one by one.
		for (let i = 0; i < 25; i++) {
			const next = j.queue.findIndex((m) => m.type === 'gmail_check');
			if (next < 0) break;
			const m = j.queue.splice(next, 1)[0] as Extract<JobMessage, { type: 'gmail_check' }>;
			const job = checkJob(m);
			await processGmailCheck(j.deps, job, 1);
			if (i === 3) expect((await conn(p.user.id))!.checked_through).toBe(before);
		}
		expect(google.count('list')).toBe(20);
		expect(await count('gmail_mail', `connection_id = '${c.id}'`)).toBe(2000);
		expect((await conn(p.user.id))!.checked_through).toBeGreaterThan(before);
	});

	it('quota: never more than 3,000 units a minute; throttling backs off and holds the connection', async () => {
		const p = await person();
		const c = await connect(p);
		const ids = Array.from({ length: 160 }, (_, i) => `m${i}`);
		for (const id of ids)
			google.state.messages.set(
				id,
				gmailMessage({ id, from: 'a@b.example', subject: 'Halo', text: 'tanpa nominal' })
			);
		let clock = Date.now();
		const j = jobs({ now: () => clock });
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'hourly',
			window: 'W-q',
			page: 0
		});
		const m = j.queue.shift() as Extract<JobMessage, { type: 'gmail_check' }>;
		const job = checkJob(m);
		await processGmailCheck(j.deps, job, 1);
		await processGmailCheck(j.deps, { ...job, page: 1 }, 1);
		let refused = 0;
		for (const r of j.queue.filter((x) => x.type === 'gmail_read'))
			try {
				await processGmailRead(j.deps, (r as { mailId: string }).mailId, 1);
			} catch (e) {
				expect(e).toBeInstanceOf(RetryLaterError);
				refused++;
			}
		const spent = google.count('list') * 5 + google.count('get') * 20;
		expect(spent).toBeLessThanOrEqual(3000);
		expect(refused).toBeGreaterThan(0);
		clock += 61_000;
		const mailId = (await db.get<{ id: string }>(
			sql`select id from gmail_mail where connection_id = ${c.id} and status = 'listed' limit 1`
		))!.id;
		for (const [status, body] of [
			[429, {}],
			[403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }],
			[503, {}]
		] as const) {
			google.state.apiQueue.push({ status, body });
			const err = await processGmailRead(j.deps, mailId, 3).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(RetryLaterError);
			expect((err as RetryLaterError).delaySeconds).toBe(4);
			if (status !== 503)
				expect((await conn(p.user.id))!.check_after as number).toBeGreaterThan(clock);
		}
		google.state.apiQueue.push({
			status: 403,
			body: { error: { errors: [{ reason: 'forbidden' }] } }
		});
		await processGmailRead(j.deps, mailId, 1);
		expect(await db.get(sql`select status, reason from gmail_mail where id = ${mailId}`)).toEqual({
			status: 'unreadable',
			reason: 'fetch_failed'
		});
	});

	it('sweep: listed rows untouched 15 min are re-sent, 48 h old ones expire; stalled pages are re-sent', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.listIds = ['s1', 's2'];
		const j = jobs();
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'hourly',
			window: 'W-s',
			page: 0
		});
		const first = j.queue.shift() as Extract<JobMessage, { type: 'gmail_check' }>;
		const job = checkJob(first);
		await processGmailCheck(j.deps, job, 1);
		const now = Date.now();
		await d1
			.prepare(`update gmail_mail set updated_at = ? where connection_id = ? and gmail_id = 's1'`)
			.bind(now - 20 * 60 * 1000, c.id)
			.run();
		await d1
			.prepare(`update gmail_mail set updated_at = ? where connection_id = ? and gmail_id = 's2'`)
			.bind(now - 49 * 60 * 60 * 1000, c.id)
			.run();
		const swept = await sweepGmail(db, now);
		const s1 = (await mailRows(c.id)).find((r) => r.gmail_id === 's1')!;
		const s2 = (await mailRows(c.id)).find((r) => r.gmail_id === 's2')!;
		expect(swept.requeueReads).toContain(s1.id);
		expect(s2).toMatchObject({ status: 'unreadable', reason: 'expired' });
	});

	it('invalid_grant: needs_reconnect, no fan-out, drafts kept; Hubungkan ulang replaces the token on the same row', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('r1', await gmailFromFixture('bank-qris/payment', 'r1'));
		const j = jobs();
		await check(j, c.id);
		expect(await draftsOf(p.space.id)).toHaveLength(1);
		const sealedBefore = (await conn(p.user.id))!.encrypted_token;
		google.state.refresh = { status: 400, body: { error: 'invalid_grant' } };
		await check(jobs(), c.id);
		expect(await conn(p.user.id)).toMatchObject({
			status: 'needs_reconnect',
			reconnect_reason: 'revoked'
		});
		expect(await connectionsDue(db, Date.now(), '', 1000)).not.toContain(c.id);
		const refreshes = google.count('refresh');
		await check(jobs(), c.id);
		expect(google.count('refresh')).toBe(refreshes);
		expect((await load(p)).connection).toMatchObject({ status: 'needs_reconnect' });
		google.state.refresh = { status: 200, body: { access_token: 'ya29.access-refreshed' } };
		await connect(p);
		const after = (await conn(p.user.id))!;
		expect(after).toMatchObject({ id: c.id, status: 'connected', reconnect_reason: null });
		expect(after.encrypted_token).not.toBe(sealedBefore);
		expect(await draftsOf(p.space.id)).toHaveLength(1);
	});

	it('an unopenable token (key removed) is needs_reconnect/key, never a crash', async () => {
		const p = await person();
		const c = await connect(p);
		const j = jobs({ env: { CONNECTED_APPS_ENCRYPTION_KEY: ENC } });
		await check(j, c.id);
		expect(await conn(p.user.id)).toMatchObject({
			status: 'needs_reconnect',
			reconnect_reason: 'key'
		});
	});

	it('the owner removed from the target space: checks pause (space_lost), nothing is written there', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('l1', await gmailFromFixture('bank-qris/payment', 'l1'));
		await d1
			.prepare('update space_members set deleted_at = ? where user_id = ? and space_id = ?')
			.bind(Date.now(), p.user.id, p.space.id)
			.run();
		await check(jobs(), c.id);
		expect(await conn(p.user.id)).toMatchObject({ auto_check: 0, paused_reason: 'space_lost' });
		expect(google.count('list')).toBe(0);
		expect(await draftsOf(p.space.id)).toHaveLength(0);
		expect(await connectionsDue(db, Date.now(), '', 1000)).not.toContain(c.id);
	});
});

describe('what is read (AC 19–28)', () => {
	async function readOne(
		message: Record<string, unknown>,
		opts: { aiFetch?: typeof fetch; env?: Record<string, unknown>; p?: Person } = {}
	) {
		const p = opts.p ?? (await person());
		const c = (await load(p)).connection ?? (await connect(p));
		google.state.messages.clear();
		google.state.messages.set(message.id as string, message);
		const j = jobs({ aiFetch: opts.aiFetch, env: opts.env });
		await check(j, c.id);
		const row = (await mailRows(c.id)).find((r) => r.gmail_id === message.id)!;
		return { p, c, row };
	}

	it('hostile responses end unreadable (malformed / too_large) and never throw', async () => {
		const huge = gmailMessage({
			id: 'h1',
			from: 'a@b.example',
			subject: 'x',
			text: 'y'.repeat(2_200_000)
		});
		expect((await readOne(huge)).row).toMatchObject({ status: 'unreadable', reason: 'too_large' });
		const broken = { id: 'h2', payload: { mimeType: 'text/plain', body: { data: '%%%' } } };
		expect((await readOne(broken)).row).toMatchObject({
			status: 'unreadable',
			reason: 'malformed'
		});
		let deep: Record<string, unknown> = { mimeType: 'text/plain', body: { data: 'eA' } };
		for (let i = 0; i < 30; i++) deep = { mimeType: 'multipart/mixed', parts: [deep] };
		expect((await readOne({ id: 'h3', payload: deep })).row).toMatchObject({ reason: 'malformed' });
		const script = gmailMessage({
			id: 'h4',
			from: 'a@b.example',
			subject: 'Halo',
			text: '<script>alert(1)</script> tanpa nominal'
		});
		expect((await readOne(script)).row).toMatchObject({ status: 'not_payment' });
	});

	it('attachments are never opened: an amount only in an attachment is not_payment and no attachment is fetched', async () => {
		const ai = aiStub(answer());
		const m = gmailMessage({
			id: 'att1',
			from: 'invoice@toko-daring.example',
			subject: 'Invoice pesanan',
			text: 'Rincian ada di lampiran.',
			attachments: [{ filename: 'invoice.txt', text: 'Total pembayaran: Rp 125.500' }]
		});
		const { row } = await readOne(m, { aiFetch: ai, env: GATEWAY });
		expect(row).toMatchObject({ status: 'not_payment' });
		expect(ai).not.toHaveBeenCalled();
		expect(google.state.calls.some((c) => c.url.includes('/attachments'))).toBe(false);
	});

	it('no amount, an OTP, promo, unpaid-bill or shipping subject, or a Promotions/Spam label: not_payment, AI never called', async () => {
		const ai = aiStub(answer());
		const p = await person();
		const cases = [
			gmailMessage({ id: 'n1', from: 'a@b.example', subject: 'Invoice', text: 'Terima kasih.' }),
			gmailMessage({ id: 'n2', from: 'a@b.example', subject: 'Kode OTP', text: 'Rp 10.000' }),
			gmailMessage({ id: 'n3', from: 'a@b.example', subject: 'Promo tagihan', text: 'Rp 10.000' }),
			gmailMessage({
				id: 'n4',
				from: 'a@b.example',
				subject: 'Tagihan jatuh tempo',
				text: 'Rp 10.000'
			}),
			gmailMessage({
				id: 'n5',
				from: 'a@b.example',
				subject: 'Struk pengiriman',
				text: 'Rp 10.000'
			}),
			{
				...(await gmailFromFixture('bank-qris/payment', 'n6')),
				labelIds: ['CATEGORY_PROMOTIONS']
			},
			{ ...(await gmailFromFixture('bank-qris/payment', 'n7')), labelIds: ['SPAM'] }
		];
		for (const m of cases) {
			const { row } = await readOne(m, { aiFetch: ai, env: GATEWAY, p });
			expect(row, String(m.id)).toMatchObject({
				status: 'not_payment',
				subject: null,
				sender_domain: null,
				parser: null,
				trust: null,
				reason: null
			});
		}
		expect(ai).not.toHaveBeenCalled();
		expect(await draftsOf(p.space.id)).toHaveLength(0);
	});

	it('the schema refuses text in a listed or not_payment row and has no column for mail text', async () => {
		const p = await person();
		const c = await connect(p);
		await expect(
			d1
				.prepare(
					`insert into gmail_mail (id, connection_id, user_id, space_id, gmail_id, received_at, status, subject, updated_at)
					values ('x1', ?, ?, ?, 'g1', 1, 'not_payment', 'Rahasia', 1)`
				)
				.bind(c.id, p.user.id, p.space.id)
				.run()
		).rejects.toThrow(/CHECK/);
		const columns = (
			await d1.prepare(`pragma table_info(gmail_mail)`).all<{ name: string }>()
		).results.map((r) => r.name);
		expect(columns.some((name) => /text|body|snippet|content/.test(name))).toBe(false);
	});

	it('the four fixtures through Gmail make the same drafts as through forwarding', async () => {
		const fixtures = [
			'bank-qris/payment',
			'ewallet-payment/payment',
			'bank-transfer-in/transfer',
			'bank-transfer-out/transfer'
		];
		const pick = (d: Record<string, unknown>) => ({
			type: d.type,
			amount_minor: d.amount_minor,
			title: d.title,
			occurred_on: d.occurred_on,
			occurred_at: d.occurred_at,
			flag: d.flag,
			dedupe_key: d.dedupe_key
		});
		for (const f of fixtures) {
			const viaGmail = await person();
			const { row } = await readOne(await gmailFromFixture(f, `fx-${f.replace(/\W/g, '')}`), {
				p: viaGmail
			});
			expect(row.status, f).toBe('draft_created');
			const viaForward = await person();
			binding.INBOUND_EMAIL_DOMAIN = 'in.contoh.example';
			await forwardingPage.actions.create!(
				fakeEvent({
					url: `${ORIGIN}/pengaturan/aplikasi/email`,
					db,
					user: viaForward.user,
					space: viaForward.space,
					form: { spaceId: viaForward.space.id }
				}).event as never
			);
			const local = (await db.get<{ local_part: string }>(
				sql`select local_part from inbound_addresses where user_id = ${viaForward.user.id}`
			))!.local_part;
			binding.INBOUND_EMAIL_DOMAIN = 'in.contoh.example';
			const to = `${local}@in.contoh.example`;
			await handleEmail(emailMessage(bytes(fixtureText(f, to)), to), {
				db,
				env: {
					INBOUND_EMAIL_DOMAIN: 'in.contoh.example',
					INBOUND_AUTHSERV_ID: 'mx.inbound.example'
				},
				enqueue: async () => {},
				now: () => Date.now()
			});
			expect(await findRecipient(db, local)).not.toBeNull();
			const [g] = await draftsOf(viaGmail.space.id);
			const [fw] = await draftsOf(viaForward.space.id);
			expect({ ...pick(g!), flag: null }, f).toEqual({ ...pick(fw!), flag: null });
			// Without GMAIL_AUTHSERV_ID every Gmail capture is unverified, so it asks for review.
			expect(g!.flag).toBe('needs_review');
		}
	});

	it('the same payment by forwarding and by Gmail is one draft; a Gmail resend is never a second draft', async () => {
		const p = await person();
		binding.INBOUND_EMAIL_DOMAIN = 'in.contoh.example';
		await forwardingPage.actions.create!(
			fakeEvent({
				url: `${ORIGIN}/pengaturan/aplikasi/email`,
				db,
				user: p.user,
				space: p.space,
				form: { spaceId: p.space.id }
			}).event as never
		);
		binding.INBOUND_EMAIL_DOMAIN = 'in.contoh.example';
		const local = (await db.get<{ local_part: string }>(
			sql`select local_part from inbound_addresses where user_id = ${p.user.id}`
		))!.local_part;
		const to = `${local}@in.contoh.example`;
		await handleEmail(emailMessage(bytes(fixtureText('bank-qris/payment', to)), to), {
			db,
			env: { INBOUND_EMAIL_DOMAIN: 'in.contoh.example' },
			enqueue: async () => {},
			now: () => Date.now()
		});
		expect(await draftsOf(p.space.id)).toHaveLength(1);
		const c = await connect(p);
		google.state.messages.set('dup1', await gmailFromFixture('bank-qris/payment', 'dup1'));
		google.state.messages.set('dup2', await gmailFromFixture('bank-qris/payment', 'dup2'));
		await check(jobs(), c.id);
		expect(await draftsOf(p.space.id)).toHaveLength(1);
		const rows = await mailRows(c.id);
		expect(rows.map((r) => [r.status, r.draft_id])).toEqual([
			['draft_created', null],
			['draft_created', null]
		]);
	});

	it('a discarded draft is never recreated by a later check, a look-back or a reconnect', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('d1', await gmailFromFixture('bank-qris/payment', 'd1'));
		await check(jobs(), c.id);
		const [draft] = await draftsOf(p.space.id);
		await d1
			.prepare(
				`update drafts set deleted_at = ?, amount_minor = null, currency = null, title = null, note = null,
				occurred_on = null, occurred_at = null, flag = null where id = ?`
			)
			.bind(Date.now(), draft!.id)
			.run();
		google.state.messages.set('d2', await gmailFromFixture('bank-qris/payment', 'd2'));
		await check(jobs(), c.id);
		const fresh = (await load(p)).connection!;
		await act(p, 'disconnect', { connectionId: fresh.id, updatedAt: String(fresh.updatedAt) });
		const again = await connect(p);
		await check(jobs(), again.id);
		expect(await act(p, 'lookback', { connectionId: again.id, days: '7' })).toEqual({
			kind: 'ok',
			value: { done: 'scanning' }
		});
		const j = jobs();
		j.queue.push(...sent);
		await j.drain();
		expect((await draftsOf(p.space.id)).filter((d) => d.deleted_at === null)).toHaveLength(0);
	});

	it('duplicate amount within 12 h is flagged; nothing ever writes a transaction; the draft cap holds (inbox_full)', async () => {
		const p = await person();
		const c = await connect(p);
		const before = await count('transactions');
		google.state.messages.set('c1', await gmailFromFixture('bank-qris/payment', 'c1'));
		await check(jobs(), c.id);
		expect(await count('transactions')).toBe(before);
		const q = await person();
		const cq = await connect(q);
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < 1000)
				insert into drafts (id, space_id, type, amount_minor, currency, title, occurred_on, occurred_at, source,
					is_demo, created_at, updated_at, seq)
				select 'cap-' || i || '-' || ?, ?, 'expense', 1000, 'IDR', 'x', '2026-10-01', 1, 'voice', 0, 1, 1, 0 from n`
			)
			.bind(q.user.id, q.space.id)
			.run();
		google.state.messages.set('c2', await gmailFromFixture('ewallet-payment/payment', 'c2'));
		await check(jobs(), cq.id);
		expect((await mailRows(cq.id)).find((r) => r.gmail_id === 'c2')).toMatchObject({
			status: 'unreadable',
			reason: 'inbox_full'
		});
	});

	it('masking: account numbers in the stored subject and in the text sent to the AI keep only the last 4 digits', async () => {
		const p = await person();
		await saveKey(
			db,
			p.user.id,
			'anthropic',
			`sk-ant-api03-synthetic-${p.user.id.slice(0, 8)}-AbCd`,
			{ AI_KEYS_ENCRYPTION_KEY: ENC },
			Date.now()
		);
		const ai = aiStub(answer());
		const m = gmailMessage({
			id: 'mask1',
			from: 'invoice@toko-daring.example',
			subject: '=?UTF-8?Q?Invoice_kartu_4111111111111234?=',
			text: 'Total pembayaran: Rp 125.500\nDibayar dengan kartu 4111 1111 1111 1234 pada 8 Oktober 2026 pukul 10:15 WIB.'
		});
		const { row } = await readOne(m, {
			p,
			aiFetch: ai,
			env: { ...GATEWAY, AI_KEYS_ENCRYPTION_KEY: ENC }
		});
		expect(row.status).toBe('draft_created');
		expect(String(row.subject)).not.toMatch(/4111111111111234/);
		expect(String(row.subject)).toContain('1234');
		const sentBody = JSON.parse(String((ai.mock.calls[0] as [string, RequestInit])[1].body)) as {
			messages: { content: { text: string }[] }[];
		};
		const text = sentBody.messages[0]!.content[0]!.text;
		expect(text).not.toMatch(/4111 1111 1111 1234/);
		expect(text).toContain('1234');
	});

	it('WIB buckets: a 23:30 WIB month-end payment and a 00:30 WIB first-of-month one keep their WIB dates', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('me', await gmailFromFixture('bank-qris/month-end', 'me'));
		google.state.messages.set('ms', await gmailFromFixture('bank-qris/month-start', 'ms'));
		await check(jobs(), c.id);
		const dates = (await draftsOf(p.space.id)).map((d) => d.occurred_on).sort();
		expect(dates).toEqual(['2026-10-31', '2026-11-01']);
		const amounts = (await draftsOf(p.space.id)).map((d) => d.amount_minor);
		expect(amounts.every((a) => Number.isSafeInteger(a))).toBe(true);
	});
});

describe('AI read and prompt injection (AC 29, 30)', () => {
	async function aiCase(
		body: string | null,
		opts: { gateway?: boolean; key?: boolean; fixture?: string } = {}
	) {
		const p = await person();
		if (opts.key !== false)
			await saveKey(
				db,
				p.user.id,
				'anthropic',
				`sk-ant-api03-synthetic-${p.user.id.slice(0, 8)}-AbCd`,
				{ AI_KEYS_ENCRYPTION_KEY: ENC },
				Date.now()
			);
		const c = await connect(p);
		const ai = aiStub(body ?? answer());
		google.state.messages.set(
			'ai1',
			await gmailFromFixture(opts.fixture ?? 'other/shop-invoice', 'ai1')
		);
		const j = jobs({
			aiFetch: ai,
			env: { AI_KEYS_ENCRYPTION_KEY: ENC, ...(opts.gateway === false ? {} : GATEWAY) }
		});
		await check(j, c.id);
		return { p, c, ai, row: (await mailRows(c.id))[0]!, drafts: await draftsOf(p.space.id) };
	}

	it('reads with the owner’s own key through the gateway (no cache, no log); a needs_review draft', async () => {
		const { ai, row, drafts } = await aiCase(null);
		expect(row).toMatchObject({ status: 'draft_created', parser: 'ai' });
		expect(drafts[0]).toMatchObject({
			amount_minor: 12_550_000,
			flag: 'needs_review',
			source: 'gmail'
		});
		const [url, init] = ai.mock.calls[0] as [string, RequestInit];
		expect(url).toContain('gateway.ai.cloudflare.com');
		const h = new Headers(init.headers);
		expect(h.get('cf-aig-skip-cache')).toBe('true');
		expect(h.get('cf-aig-collect-log')).toBe('false');
		expect(h.get('x-api-key')).toMatch(/^sk-ant-api03-synthetic-/);
		expect(init.signal).toBeDefined();
	});

	it('no gateway → ai_unconfigured; no key → no_ai_key; nothing kept; "Baca ulang" re-queues them', async () => {
		const noGateway = await aiCase(null, { gateway: false });
		expect(noGateway.row).toMatchObject({ status: 'unreadable', reason: 'ai_unconfigured' });
		expect(noGateway.ai).not.toHaveBeenCalled();
		const noKey = await aiCase(null, { key: false });
		expect(noKey.row).toMatchObject({ status: 'unreadable', reason: 'no_ai_key' });
		expect((await load(noKey.p)).connection?.rereadable).toBe(1);
		expect(await act(noKey.p, 'reread')).toEqual({
			kind: 'ok',
			value: { done: 'rereading', count: 1 }
		});
		expect(sent).toEqual([{ type: 'gmail_read', mailId: noKey.row.id }]);
		expect((await mailRows(noKey.c.id))[0]).toMatchObject({ status: 'listed', subject: null });
	});

	it('injection: an amount not printed in the mail, extra fields, a wrong type → ai_invalid; non-IDR → currency', async () => {
		const injected = await aiCase(answer({ amount: 'Rp 99.999.999' }), {
			fixture: 'other/prompt-injection'
		});
		expect(injected.row).toMatchObject({ status: 'unreadable', reason: 'ai_invalid' });
		expect(injected.drafts).toHaveLength(0);
		const extra = await aiCase(JSON.stringify({ ...JSON.parse(answer()), space_id: 'x' }));
		expect(extra.row).toMatchObject({ reason: 'ai_invalid' });
		const wrongType = await aiCase(answer({ is_payment: 'yes' }));
		expect(wrongType.row).toMatchObject({ reason: 'ai_invalid' });
		const usd = await aiCase(answer({ currency: 'USD' }));
		expect(usd.row).toMatchObject({ status: 'unreadable', reason: 'currency' });
		const body = JSON.parse(
			String((usd.ai.mock.calls[0] as [string, RequestInit])[1].body)
		) as Record<string, unknown>;
		expect(body.tools).toBeUndefined();
	});
});

describe('look-back and plan gate (AC 31, 32)', () => {
	it('Gratis: 7 days works, 30 is refused server-side; Pro: 365; a lapsed plan is clamped by the handler', async () => {
		const p = await person();
		const c = await connect(p);
		expect((await load(p)).lookbackMax).toBe(7);
		expect(await act(p, 'lookback', { connectionId: c.id, days: '30' })).toEqual({
			kind: 'fail',
			status: 403,
			error: GMAIL_LOOKBACK_PLAN
		});
		expect(await act(p, 'lookback', { connectionId: c.id, days: '14' })).toMatchObject({
			status: 400
		});
		const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
		await d1
			.prepare(
				`update user_plan_state set plan = 'pro', billing_period = 'monthly', current_period_end = ?
				where user_id = ?`
			)
			.bind(future, p.user.id)
			.run();
		expect((await load(p)).lookbackMax).toBe(365);
		expect(await act(p, 'lookback', { connectionId: c.id, days: '365' })).toEqual({
			kind: 'ok',
			value: { done: 'scanning' }
		});
		await d1
			.prepare(`update user_plan_state set plan = 'gratis' where user_id = ?`)
			.bind(p.user.id)
			.run();
		const j = jobs();
		j.queue.push(...sent);
		await j.drain();
		const scan = (await db.get<{ days: number; after_s: number; created_at: number }>(
			sql`select days, after_s, created_at from gmail_scans where connection_id = ${c.id} and kind = 'lookback'`
		))!;
		expect(scan.days).toBe(7);
		expect(scan.after_s).toBe(Math.floor(scan.created_at / 1000) - 7 * 86400);
		const q = new URL(google.state.calls.find((x) => x.endpoint === 'list')!.url).searchParams.get(
			'q'
		)!;
		expect(q).toContain(`after:${scan.after_s} `);
	});

	it('one running look-back (20 concurrent starts → one), 4th in 24 h refused, Hentikan stops reads, progress persists', async () => {
		const p = await person();
		const c = await connect(p);
		const starts = await Promise.all(
			Array.from({ length: 20 }, () => act(p, 'lookback', { connectionId: c.id, days: '7' }))
		);
		expect(starts.filter((s) => s.kind === 'ok')).toHaveLength(1);
		expect(
			starts.filter((s) => s.kind === 'fail' && s.error === GMAIL_LOOKBACK_RUNNING).length
		).toBeGreaterThan(0);
		const scan = (await load(p)).connection!.lookback!;
		expect(scan.status).toBe('running');
		google.state.listIds = ['lb1', 'lb2', 'lb3'];
		const j = jobs();
		const first = sent.shift() as Extract<JobMessage, { type: 'gmail_check' }>;
		const job = checkJob(first);
		await processGmailCheck(j.deps, job, 1);
		expect((await load(p)).connection!.lookback).toMatchObject({ listed: 3, status: 'done' });
		for (let i = 0; i < 2; i++) {
			await d1.prepare('delete from auth_attempts').run();
			await d1
				.prepare(`update gmail_scans set status = 'done' where connection_id = ?`)
				.bind(c.id)
				.run();
			const r = await act(p, 'lookback', { connectionId: c.id, days: '7' });
			expect(r.kind).toBe('ok');
			if (i === 1) {
				const running = (await load(p)).connection!.lookback!;
				expect(await act(p, 'stopLookback', { scanId: running.id })).toEqual({
					kind: 'ok',
					value: { done: 'stopped' }
				});
				expect((await load(p)).connection!.lookback!.status).toBe('cancelled');
			}
		}
		await d1.prepare('delete from auth_attempts').run();
		expect(await act(p, 'lookback', { connectionId: c.id, days: '7' })).toEqual({
			kind: 'fail',
			status: 429,
			error: GMAIL_LOOKBACK_LIMIT
		});
		const credits = await count('credit_ledger', `user_id = '${p.user.id}' and delta < 0`);
		expect(credits).toBe(0);
	});
});

describe('disconnect and deletion (AC 36–40, 43)', () => {
	it('revokes with the refresh token, deletes every Gmail row and pending Gmail drafts; keeps saved and forwarded ones', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.listIds = Array.from({ length: 105 }, (_, i) => `x${i}`);
		google.state.messages.set('pay', await gmailFromFixture('bank-qris/payment', 'pay'));
		google.state.listIds.push('pay');
		await check(jobs(), c.id);
		const forwardDraft = 'fwd-draft-' + p.user.id;
		await d1
			.prepare(
				`insert into drafts (id, space_id, type, amount_minor, currency, title, occurred_on, occurred_at, source,
				dedupe_key, is_demo, created_at, updated_at, seq) values (?, ?, 'expense', 5000, 'IDR', 'fwd',
				'2026-10-01', 1, 'gmail', 'mail:m:other', 0, 1, 1, 0)`
			)
			.bind(forwardDraft, p.space.id)
			.run();
		expect(await count('gmail_mail', `connection_id = '${c.id}'`)).toBe(106);
		const fresh = (await load(p)).connection!;
		const r = await act(p, 'disconnect', {
			connectionId: fresh.id,
			updatedAt: String(fresh.updatedAt)
		});
		expect(r).toEqual({ kind: 'ok', value: { done: 'disconnected' } });
		const revoke = google.state.calls.find((x) => x.endpoint === 'revoke')!;
		expect(new URLSearchParams(revoke.body).get('token')).toBe('1//refresh-token-secret');
		for (const t of ['gmail_mail', 'gmail_scans', 'oauth_states'])
			expect(await count(t, `user_id = '${p.user.id}'`), t).toBe(0);
		expect(await conn(p.user.id)).toBeUndefined();
		const drafts = await draftsOf(p.space.id);
		const gmailDraft = drafts.find((d) => d.id !== forwardDraft)!;
		expect(gmailDraft).toMatchObject({ amount_minor: null, title: null });
		expect(gmailDraft.deleted_at).not.toBeNull();
		expect(gmailDraft.dedupe_key).not.toBeNull();
		expect(drafts.find((d) => d.id === forwardDraft)).toMatchObject({ deleted_at: null });
	});

	it('a failed revoke still deletes locally and says so; 400 invalid_token counts as revoked', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.revokeStatus = 503;
		expect(
			await act(p, 'disconnect', { connectionId: c.id, updatedAt: String(c.updatedAt) })
		).toEqual({ kind: 'ok', value: { done: 'disconnected_local' } });
		expect(await conn(p.user.id)).toBeUndefined();
		const q = await person();
		const cq = await connect(q);
		google.state.revokeStatus = 400;
		google.state.revokeBody = JSON.stringify({ error: 'invalid_token' });
		expect(
			await act(q, 'disconnect', { connectionId: cq.id, updatedAt: String(cq.updatedAt) })
		).toEqual({ kind: 'ok', value: { done: 'disconnected' } });
	});

	it('a read racing a disconnect creates no draft; queued reads of a removed connection ack without calling Google', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('race', await gmailFromFixture('bank-qris/payment', 'race'));
		const j = jobs();
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'hourly',
			window: 'W-race',
			page: 0
		});
		const check0 = j.queue.shift() as Extract<JobMessage, { type: 'gmail_check' }>;
		const job = checkJob(check0);
		await processGmailCheck(j.deps, job, 1);
		const mailId = (j.queue[0] as { mailId: string }).mailId;
		let release!: () => void;
		google.state.getGate = new Promise((r) => (release = r));
		const gets = google.count('get');
		const reading = processGmailRead(j.deps, mailId, 1);
		// Google is answering slowly: the user disconnects (the connection stops being `connected`) meanwhile.
		for (let i = 0; i < 200 && google.count('get') === gets; i++)
			await new Promise((r) => setTimeout(r, 10));
		await d1
			.prepare(
				`update gmail_connections set status = 'needs_reconnect', reconnect_reason = 'revoked' where id = ?`
			)
			.bind(c.id)
			.run();
		release();
		await reading;
		expect(await draftsOf(p.space.id)).toHaveLength(0);
		google.state.getGate = null;
		const fresh = (await load(p)).connection!;
		await act(p, 'disconnect', { connectionId: fresh.id, updatedAt: String(fresh.updatedAt) });
		const getsAfter = google.count('get');
		expect(await processGmailRead(j.deps, mailId, 1)).toBe('skipped');
		expect(google.count('get')).toBe(getsAfter);
	});

	it('account deletion revokes and removes all four tables’ rows; the export never carries tokens or Gmail ids', async () => {
		const p = await person();
		await startConnect(p);
		const c = await connect(p);
		google.state.messages.set('ex1', await gmailFromFixture('bank-qris/payment', 'ex1'));
		await check(jobs(), c.id);
		const r = await exportAccount(db, p.user.id);
		if (!r.ok) throw new Error('export failed');
		const files = readZip(new Uint8Array(await new Response(r.stream).arrayBuffer()));
		const names = [...files.keys()];
		for (const t of ['gmail_connections', 'gmail_scans', 'gmail_mail'])
			expect(
				names.some((f) => f.endsWith(`${t}.json`)),
				t
			).toBe(true);
		expect(names.some((f) => f.includes('oauth_states'))).toBe(false);
		const all = [...files.values()].map(textOf).join('\n');
		expect(all).not.toContain('ex1');
		expect(all).not.toMatch(/encrypted_token|encryptedToken|tokenNonce|stateHash|pageToken/);
		expect(leaks(all)).toEqual([]);
		const proof = await signInWithPassword(db, p.user.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof');
		const revokes = google.count('revoke');
		const { revokeGmailToken } = await import('#lib/server/gmail/oauth');
		expect(
			await revokeGmailToken(
				db,
				{ CONNECTED_APPS_ENCRYPTION_KEY: KEY },
				googleClient(google.fetchFn),
				p.user.id
			)
		).toBe(true);
		expect(google.count('revoke')).toBe(revokes + 1);
		expect(await deleteAccount(db, p.user.id, proof.hash, Date.now())).toBe(true);
		for (const t of ['gmail_connections', 'gmail_scans', 'gmail_mail', 'oauth_states'])
			expect(await count(t, `user_id = '${p.user.id}'`), t).toBe(0);
	});
});

describe('migration 0033 (AC 48)', () => {
	it('CHECKs refuse a wrong token length, a second running look-back, a reason on a listed row', async () => {
		const p = await person();
		const c = await connect(p);
		await expect(
			d1.prepare(`update gmail_connections set token_nonce = 'short' where id = ?`).bind(c.id).run()
		).rejects.toThrow(/CHECK/);
		const scan = (id: string) =>
			d1
				.prepare(
					`insert into gmail_scans (id, connection_id, user_id, kind, scan_window, days, after_s, status, created_at, updated_at)
					values (?, ?, ?, 'lookback', ?, 7, 0, 'running', 1, 1)`
				)
				.bind(id, c.id, p.user.id, `lb-${id}`)
				.run();
		await scan('s-a');
		await expect(scan('s-b')).rejects.toThrow(/UNIQUE/);
		await expect(
			d1
				.prepare(
					`insert into gmail_mail (id, connection_id, user_id, space_id, gmail_id, received_at, status, reason, updated_at)
					values ('r1', ?, ?, ?, 'g', 1, 'listed', 'gone', 1)`
				)
				.bind(c.id, p.user.id, p.space.id)
				.run()
		).rejects.toThrow(/CHECK/);
	});

	it('running the migration file again changes nothing', async () => {
		const { applyMigration } = await import('../helpers/d1');
		await expect(applyMigration(d1, '0033_gmail_connection.sql')).resolves.toBeUndefined();
	});
});

describe('red team lows L1–L4 (personal-data retention)', () => {
	const DAY = 24 * 60 * 60 * 1000;
	// The queue is global; earlier tests' deletions leave rows in it.
	beforeEach(() => db.run(sql`delete from gmail_revocations`));
	const live = (rows: Record<string, unknown>[]) =>
		rows.filter((d) => d.deleted_at === null).map((d) => d.id);
	const disconnect = async (who: Person) => {
		const fresh = (await load(who)).connection!;
		return act(who, 'disconnect', { connectionId: fresh.id, updatedAt: String(fresh.updatedAt) });
	};
	const addMember = (spaceId: string, userId: string) =>
		db.run(sql`insert into space_members (id, space_id, user_id, role, created_at, updated_at)
			values (${crypto.randomUUID()}, ${spaceId}, ${userId}, 'member', 0, 0)`);
	const proofOf = async (who: Person) => {
		const proof = await signInWithPassword(db, who.user.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof');
		return proof.hash;
	};
	const revocations = async () => {
		const { processGmailRevocations } = await import('#lib/server/gmail/oauth');
		return processGmailRevocations(
			db,
			{ CONNECTED_APPS_ENCRYPTION_KEY: KEY },
			googleClient(google.fetchFn),
			Date.now()
		);
	};
	const revokedTokens = () =>
		google.state.calls
			.filter((c) => c.endpoint === 'revoke')
			.map((c) => new URLSearchParams(c.body).get('token'));

	it('L1: disconnect tombstones a pending Gmail draft whose ledger row passed the 90-day retention', async () => {
		const p = await person();
		const q = await person();
		const cp = await connect(p);
		const cq = await connect(q);
		google.state.messages.set('old1', await gmailFromFixture('bank-qris/payment', 'old1'));
		google.state.listIds = ['old1', 'gone1'];
		await check(jobs(), cp.id);
		await check(jobs(), cq.id);
		expect(live(await draftsOf(p.space.id))).toHaveLength(1);
		expect(live(await draftsOf(q.space.id))).toHaveLength(1);
		// Both drafts stay pending in Kotak masuk past the ledger's 90 days; the hourly sweep runs.
		await d1
			.prepare('update gmail_mail set updated_at = ? where connection_id in (?, ?)')
			.bind(Date.now() - 91 * DAY, cp.id, cq.id)
			.run();
		await sweepGmail(db, Date.now());
		// Retention still removes the ledger row without a pending draft.
		expect((await mailRows(cq.id)).map((r) => r.gmail_id)).toEqual(['old1']);
		expect(await disconnect(p)).toEqual({ kind: 'ok', value: { done: 'disconnected' } });
		const [gone] = await draftsOf(p.space.id);
		expect(gone).toMatchObject({ amount_minor: null, title: null });
		expect(gone!.deleted_at).not.toBeNull();
		// Stamped with its own space's freshly advanced change counter, so a sync pull returns the tombstone.
		const counter = await db.get<{ seq: number }>(
			sql`select seq from space_seq where space_id = ${p.space.id}`
		);
		expect(gone!.seq).toBe(counter!.seq);
		// The other user's connection, ledger and draft are untouched.
		expect(live(await draftsOf(q.space.id))).toHaveLength(1);
		expect(await conn(q.user.id)).toMatchObject({ status: 'connected' });
	});

	it('L2: account deletion tombstones the account’s pending Gmail and forwarded drafts in a shared space that stays', async () => {
		const owner = await person();
		const a = await person();
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		await addMember(shared, a.user.id);
		const ca = await connect(a, shared);
		google.state.messages.set('sh1', await gmailFromFixture('bank-qris/payment', 'sh1'));
		await check(jobs(), ca.id);
		binding.INBOUND_EMAIL_DOMAIN = 'in.contoh.example';
		await forwardingPage.actions.create!(
			fakeEvent({
				url: `${ORIGIN}/pengaturan/aplikasi/email`,
				db,
				user: a.user,
				space: a.space,
				form: { spaceId: shared }
			}).event as never
		);
		const local = (await db.get<{ local_part: string }>(
			sql`select local_part from inbound_addresses where user_id = ${a.user.id}`
		))!.local_part;
		const to = `${local}@in.contoh.example`;
		await handleEmail(emailMessage(bytes(fixtureText('ewallet-payment/payment', to)), to), {
			db,
			env: { INBOUND_EMAIL_DOMAIN: 'in.contoh.example' },
			enqueue: async () => {},
			now: () => Date.now()
		});
		// The owner's own pending draft in the same space, and one in the owner's personal space.
		for (const [id, spaceId] of [
			[`own-${owner.user.id}`, shared],
			[`own2-${owner.user.id}`, owner.space.id]
		])
			await d1
				.prepare(
					`insert into drafts (id, space_id, type, amount_minor, currency, title, occurred_on, occurred_at, source,
					dedupe_key, is_demo, created_at, updated_at, seq) values (?, ?, 'expense', 5000, 'IDR', 'milik',
					'2026-10-01', 1, 'gmail', ?, 0, 1, 1, 0)`
				)
				.bind(id, spaceId, `mail:m:${id}`)
				.run();
		expect(live(await draftsOf(shared))).toHaveLength(3);
		expect(await deleteAccount(db, a.user.id, await proofOf(a), Date.now())).toBe(true);
		const after = await draftsOf(shared);
		expect(live(after)).toEqual([`own-${owner.user.id}`]);
		for (const d of after.filter((x) => x.deleted_at !== null))
			expect(d).toMatchObject({ amount_minor: null, title: null });
		expect(live(await draftsOf(owner.space.id))).toEqual([`own2-${owner.user.id}`]);
	});

	it('L3: a space purge queues another user’s paused connection; the jobs sweep revokes it at Google', async () => {
		const owner = await person();
		const m = await person();
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		await addMember(shared, m.user.id);
		await connect(m, shared);
		// M is removed: the connection pauses (space_lost). Then the owner deletes the account: the space is purged.
		await d1
			.prepare('update space_members set deleted_at = ? where user_id = ? and space_id = ?')
			.bind(Date.now(), m.user.id, shared)
			.run();
		await sweepGmail(db, Date.now());
		expect(await conn(m.user.id)).toMatchObject({ paused_reason: 'space_lost' });
		expect(await deleteAccount(db, owner.user.id, await proofOf(owner), Date.now())).toBe(true);
		expect(await conn(m.user.id)).toBeUndefined();
		expect(google.count('revoke')).toBe(0);
		// The jobs Worker's sweep revokes the purged grant (a failure is retried on the next tick).
		google.state.revokeStatus = 503;
		expect(await revocations()).toMatchObject({ revoked: 0, retried: 1 });
		google.state.revokeStatus = 200;
		expect(await revocations()).toMatchObject({ revoked: 1, retried: 0 });
		expect(revokedTokens()).toEqual(['1//refresh-token-secret', '1//refresh-token-secret']);
		expect(await count('gmail_revocations', `user_id = '${m.user.id}'`)).toBe(0);
		expect(await revocations()).toMatchObject({ revoked: 0, dropped: 0, retried: 0 });
		// M's personal space and account are untouched.
		expect((await resolveCurrentSpace(db, m.user.id, undefined))!.id).toBe(m.space.id);
	});

	it('L3: a queued grant is dropped, not revoked, when the user reconnected the same Google account meanwhile', async () => {
		const owner = await person();
		const m = await person();
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		await addMember(shared, m.user.id);
		await connect(m, shared);
		await d1
			.prepare('update space_members set deleted_at = ? where user_id = ? and space_id = ?')
			.bind(Date.now(), m.user.id, shared)
			.run();
		expect(await deleteAccount(db, owner.user.id, await proofOf(owner), Date.now())).toBe(true);
		google.state.exchange.body.refresh_token = '1//reconnected';
		await connect(m);
		// Revoking the old token would end the new connection too (one grant per Google account).
		expect(await revocations()).toMatchObject({ revoked: 0, dropped: 1 });
		expect(google.count('revoke')).toBe(0);
		expect(await conn(m.user.id)).toMatchObject({ status: 'connected' });
	});

	it('L3: a queued grant older than 7 days is dropped without a call, even while the key is missing', async () => {
		const m = await person();
		const c = await connect(m);
		await db.run(sql`insert into gmail_revocations select id, token_nonce, user_id, google_address,
			encrypted_token, token_key_id, 0, ${Date.now() - 8 * DAY} from gmail_connections where id = ${c.id}`);
		await db.run(sql`delete from gmail_connections where id = ${c.id}`);
		const { processGmailRevocations } = await import('#lib/server/gmail/oauth');
		expect(await processGmailRevocations(db, {}, googleClient(google.fetchFn), Date.now())).toEqual(
			{ revoked: 0, dropped: 1, retried: 0 }
		);
		expect(google.count('revoke')).toBe(0);
		expect(await count('gmail_revocations')).toBe(0);
	});

	it('L4: a second authorization for another Google account revokes the replaced grant; the same account is kept', async () => {
		const p = await person();
		const q = await person();
		await connect(q);
		// Four tabs start "Hubungkan" before any finishes; each callback completes in turn.
		const tabs = [];
		for (let i = 0; i < 4; i++) tabs.push((await startConnect(p)).state);
		const finish = async (state: string) =>
			(await callbackWith(p, `state=${state}&code=auth-code-xyz&scope=${GMAIL_SCOPE}`)).flash;
		expect(await finish(tabs[0]!)).toBe('connected');
		google.state.profile = 'kedua@gmail.example';
		google.state.exchange.body.refresh_token = '1//second';
		expect(await finish(tabs[1]!)).toBe('connected');
		expect(await conn(p.user.id)).toMatchObject({ google_address: 'kedua@gmail.example' });
		expect(await revocations()).toMatchObject({ revoked: 1 });
		expect(revokedTokens()).toEqual(['1//refresh-token-secret']);
		// Same account again: one grant at Google, nothing to revoke.
		google.state.exchange.body.refresh_token = '1//third';
		expect(await finish(tabs[2]!)).toBe('connected');
		expect(await revocations()).toMatchObject({ revoked: 0, dropped: 0 });
		// The profile read fails: the address is unknown (not the previous mailbox's), nothing is revoked.
		google.state.apiQueue.push({ status: 500 });
		google.state.exchange.body.refresh_token = '1//fourth';
		expect(await finish(tabs[3]!)).toBe('connected');
		expect(await conn(p.user.id)).toMatchObject({ google_address: null });
		expect(await revocations()).toMatchObject({ revoked: 0 });
		expect(revokedTokens()).toEqual(['1//refresh-token-secret']);
		// The other user's connection is untouched.
		expect(await conn(q.user.id)).toMatchObject({
			status: 'connected',
			google_address: 'pemilik@gmail.example'
		});
	});
});

// Red team lows L6 and L7, resolved 2026-10-13.
describe('red team lows L5 (never verified), L6 (daily AI-read cap) and L7 (re-seal on rotation)', () => {
	async function withKey() {
		const p = await person();
		await saveKey(
			db,
			p.user.id,
			'anthropic',
			`sk-ant-api03-synthetic-${p.user.id.slice(0, 8)}-AbCd`,
			{ AI_KEYS_ENCRYPTION_KEY: ENC },
			Date.now()
		);
		return p;
	}

	it('L6: over the daily cap the mail is unreadable/ai_limit, the AI is never called, and "Baca ulang" can re-queue it', async () => {
		const p = await withKey();
		const c = await connect(p);
		await d1
			.prepare('update gmail_connections set ai_window_start = ?, ai_reads = ? where id = ?')
			.bind(Date.now(), GMAIL_AI_READS_PER_DAY, c.id)
			.run();
		const ai = aiStub(answer());
		google.state.messages.set('cap1', await gmailFromFixture('other/shop-invoice', 'cap1'));
		const j = jobs({ aiFetch: ai, env: { AI_KEYS_ENCRYPTION_KEY: ENC, ...GATEWAY } });
		await check(j, c.id);
		const [row] = await mailRows(c.id);
		expect(row).toMatchObject({ status: 'unreadable', reason: 'ai_limit' });
		expect(ai).not.toHaveBeenCalled();
		expect(await draftsOf(p.space.id)).toHaveLength(0);
		expect((await load(p)).connection?.rereadable).toBe(1);
	});

	it('L6: the window resets after 24 hours, and 20 concurrent claims never pass the cap', async () => {
		const p = await person();
		const c = await connect(p);
		const now = Date.now();
		await d1
			.prepare('update gmail_connections set ai_window_start = ?, ai_reads = ? where id = ?')
			.bind(now, GMAIL_AI_READS_PER_DAY - 5, c.id)
			.run();
		const claims = await Promise.all(Array.from({ length: 20 }, () => claimAiRead(db, c.id, now)));
		expect(claims.filter(Boolean)).toHaveLength(5);
		expect(await claimAiRead(db, c.id, now + 24 * 60 * 60 * 1000)).toBe(true);
		expect(await conn(p.user.id)).toMatchObject({ ai_reads: 1 });
	});

	it('L5 (owner decision 2026-10-13): a Gmail capture is never verified, whatever its Authentication-Results say', async () => {
		const p = await person();
		const c = await connect(p);
		// A passing header from the authserv-id an old config named: before, this made a `verified` capture.
		google.state.messages.set('v1', await gmailFromFixture('bank-qris/payment', 'v1'));
		const j = jobs({ env: { GMAIL_AUTHSERV_ID: 'mx.inbound.example' } });
		await check(j, c.id);
		const [row] = await mailRows(c.id);
		expect(row).toMatchObject({ status: 'draft_created', trust: 'unverified' });
		const [draft] = await draftsOf(p.space.id);
		expect(draft).toMatchObject({ source: 'gmail', flag: 'needs_review' });
	});

	it('N4 (cycle 2): the hourly sweep re-seals connections that never refresh (paused, needs reconnect, checks off)', async () => {
		const { resealGmailTokens } = await import('#lib/server/gmail/token');
		const { openRefreshToken } = await import('#lib/server/gmail/crypto');
		const ids: { id: string; userId: string }[] = [];
		for (const setup of [
			'update gmail_connections set auto_check = 0 where id = ?',
			"update gmail_connections set status = 'needs_reconnect', reconnect_reason = 'revoked' where id = ?",
			"update gmail_connections set auto_check = 0, paused_reason = 'space_lost' where id = ?"
		]) {
			const p = await person();
			const c = await connect(p);
			await d1.prepare(setup).bind(c.id).run();
			ids.push({ id: c.id, userId: p.user.id });
		}
		const rotated = {
			CONNECTED_APPS_ENCRYPTION_KEY: ENC,
			CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS: KEY
		};
		let total = 0;
		for (let i = 0; i < 20; i++) {
			const n = await resealGmailTokens(db, rotated);
			total += n;
			if (n === 0) break;
		}
		expect(total).toBeGreaterThanOrEqual(3);
		for (const { id, userId } of ids) {
			const row = await db.get<{ ciphertext: string; nonce: string; keyId: string }>(
				sql`select encrypted_token as ciphertext, token_nonce as nonce, token_key_id as keyId
					from gmail_connections where id = ${id}`
			);
			// _PREVIOUS removed: the token still opens, so disconnect can still revoke it at Google.
			expect(
				await openRefreshToken({ CONNECTED_APPS_ENCRYPTION_KEY: ENC }, row!, {
					connectionId: id,
					userId
				})
			).not.toBeNull();
		}
		expect(await resealGmailTokens(db, rotated)).toBe(0);
	});

	it('L7: a token opened with _PREVIOUS is re-sealed with the current key, so removing _PREVIOUS keeps it working', async () => {
		const p = await person();
		const c = await connect(p);
		const before = await conn(p.user.id);
		// Rotation: ENC is the new key, KEY (which sealed the token) moves to _PREVIOUS.
		const rotated = jobs({
			env: { CONNECTED_APPS_ENCRYPTION_KEY: ENC, CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS: KEY }
		});
		await check(rotated, c.id);
		const after = await conn(p.user.id);
		expect(after).toMatchObject({ status: 'connected', updated_at: before!.updated_at });
		expect(after!.token_key_id).not.toBe(before!.token_key_id);
		expect(after!.token_nonce).not.toBe(before!.token_nonce);
		// _PREVIOUS removed: the connection still opens (before the fix it became needs_reconnect/key).
		const newOnly = jobs({ env: { CONNECTED_APPS_ENCRYPTION_KEY: ENC } });
		await check(newOnly, c.id);
		expect(await conn(p.user.id)).toMatchObject({ status: 'connected', reconnect_reason: null });
	});
});
