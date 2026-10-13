import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOT_CHECK_FAILED, TOO_MANY_ATTEMPTS } from '#lib/server/auth/messages';
import { THROTTLE_MAX_ATTEMPTS } from '#lib/server/auth/throttle';
import { SITEVERIFY_URL } from '#lib/server/auth/turnstile';
import { cspHeader } from '#lib/server/csp';
import { getDb, type Db } from '#lib/server/db';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-50 Part A: the Turnstile check in the /masuk and /daftar actions, their loaders, and the per-route CSP.
 * Siteverify is always a stubbed `fetch`; no test reaches Cloudflare.
 */

const binding: { DB?: D1Database; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

// The password derivation is observed, not replaced: AC 4 asserts it never runs for a refused bot check.
const derivations = vi.hoisted(() => ({ count: 0 }));
vi.mock('#lib/server/auth/password', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/server/auth/password')>();
	return {
		...real,
		signInWithPassword: (...args: Parameters<typeof real.signInWithPassword>) => {
			derivations.count += 1;
			return real.signInWithPassword(...args);
		}
	};
});

const { handle } = await import('../../src/hooks.server');
const masuk = await import('../../src/routes/(auth)/masuk/+page.server');
const daftar = await import('../../src/routes/(auth)/daftar/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const SITE_KEY = '1x00000000000000000000AA';
const SECRET = '1x0000000000000000000000000000000AA';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete binding.TURNSTILE_SITE_KEY;
	delete binding.TURNSTILE_SECRET_KEY;
});

type Action = (event: never) => unknown;
const action = (actions: unknown, name: string) =>
	(actions as Record<string, Action>)[name] as Action;

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
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
		throw e;
	}
}

let ip = 0;
const nextIp = () => `198.51.100.${++ip}`;
let n = 0;
const freshEmail = () => `turnstile-${++n}-${Date.now()}@contoh.id`;

const configure = (site = SITE_KEY, secret = SECRET) => {
	binding.TURNSTILE_SITE_KEY = site;
	binding.TURNSTILE_SECRET_KEY = secret;
};

/** A siteverify stub: records each call's body and answers `answer` (or what `respond` builds). */
function stubSiteverify(respond: () => Response | Promise<Response>) {
	const calls: { url: string; body: URLSearchParams }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, body: new URLSearchParams(String(init.body)) });
			return respond();
		})
	);
	return calls;
}
const answer =
	(body: unknown, status = 200) =>
	() =>
		Response.json(body, { status });
const passing = answer({ success: true, action: 'sign-in', hostname: 'localhost' });

/** An account made directly through the sign-up action while the check is off. */
async function account(email = freshEmail()) {
	const { event } = fakeEvent({
		url: 'http://localhost/daftar',
		routeId: '/(auth)/daftar',
		db,
		headers: { 'cf-connecting-ip': nextIp() },
		form: { name: 'Budi', email, password: PASSWORD, adult: 'on', consent: 'on' }
	});
	const result = await run(() => action(daftar.actions, 'default')(event as never));
	if (result.kind !== 'redirect') throw new Error('sign-up setup failed');
	return email;
}

/** The session token of a fresh account (the sign-up action's cookie). */
async function sessionToken() {
	const { event, written } = fakeEvent({
		url: 'http://localhost/daftar',
		routeId: '/(auth)/daftar',
		db,
		headers: { 'cf-connecting-ip': nextIp() },
		form: { name: 'Budi', email: freshEmail(), password: PASSWORD, adult: 'on', consent: 'on' }
	});
	await run(() => action(daftar.actions, 'default')(event as never));
	return written.get('financer_session')!.value;
}

function signIn(form: Record<string, string>, clientIp = nextIp(), host = 'localhost') {
	const { event, written } = fakeEvent({
		url: `http://${host}/masuk?next=%2Friwayat`,
		routeId: '/(auth)/masuk',
		db,
		headers: { 'cf-connecting-ip': clientIp },
		form
	});
	return run(() => action(masuk.actions, 'password')(event as never)).then((result) => ({
		result,
		written
	}));
}

const lastLogin = async (email: string) =>
	(
		await d1
			.prepare('select last_login_at as t from users where email = ?')
			.bind(email)
			.first<{ t: number | null }>()
	)?.t ?? null;

describe('Turnstile unset or partial (AC 1, 2)', () => {
	it('loaders return no site key and sign-in works without a token or any siteverify call', async () => {
		const calls = stubSiteverify(passing);
		const email = await account();
		const load = (await masuk.load(
			fakeEvent({ url: 'http://localhost/masuk', db }).event as never
		)) as { turnstile: unknown };
		expect(load.turnstile).toBeNull();
		const signUpLoad = (await daftar.load(
			fakeEvent({ url: 'http://localhost/daftar', db }).event as never
		)) as { turnstile: unknown };
		expect(signUpLoad.turnstile).toBeNull();
		const { result, written } = await signIn({ email, password: PASSWORD });
		expect(result).toEqual({ kind: 'redirect', status: 303, location: '/riwayat' });
		expect(written.get('financer_session')?.value).toBeTruthy();
		expect(calls).toHaveLength(0);
	});

	it('with exactly one value set behaves as unset and logs one value-free line per auth action call', async () => {
		for (const [site, secret] of [
			[SITE_KEY, ''],
			['', SECRET]
		]) {
			configure(site, secret);
			const calls = stubSiteverify(passing);
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
			const email = await account();
			expect(logged).toHaveBeenCalledTimes(1);
			const { result } = await signIn({ email, password: PASSWORD });
			expect(result.kind).toBe('redirect');
			expect(logged).toHaveBeenCalledTimes(2);
			for (const call of logged.mock.calls) {
				expect(call).toEqual(['turnstile: partial configuration']);
				expect(JSON.stringify(call)).not.toContain(SECRET);
				expect(JSON.stringify(call)).not.toContain(SITE_KEY);
			}
			expect(calls).toHaveLength(0);
			const load = (await masuk.load(
				fakeEvent({ url: 'http://localhost/masuk', db }).event as never
			)) as { turnstile: unknown };
			expect(load.turnstile).toBeNull();
			vi.restoreAllMocks();
		}
	});
});

describe('Turnstile configured (AC 3 – 10)', () => {
	it('loaders hand the page the site key only, never the secret', async () => {
		configure();
		const load = await masuk.load(fakeEvent({ url: 'http://localhost/masuk', db }).event as never);
		expect(load).toMatchObject({ turnstile: { siteKey: SITE_KEY } });
		expect(JSON.stringify(load)).not.toContain(SECRET);
		const signUpLoad = await daftar.load(
			fakeEvent({ url: 'http://localhost/daftar', db }).event as never
		);
		expect(signUpLoad).toMatchObject({ turnstile: { siteKey: SITE_KEY } });
		expect(JSON.stringify(signUpLoad)).not.toContain(SECRET);
	});

	it('refuses a missing, empty or 2049-character token with the fixed message before any derivation', async () => {
		const email = await account();
		configure();
		const calls = stubSiteverify(passing);
		const before = derivations.count;
		const loginBefore = await lastLogin(email);
		for (const form of [
			{ email, password: PASSWORD } as Record<string, string>,
			{ email, password: PASSWORD, 'cf-turnstile-response': '' },
			{ email, password: PASSWORD, 'cf-turnstile-response': 'a'.repeat(2049) }
		]) {
			const { result, written } = await signIn(form);
			expect(result).toEqual({
				kind: 'fail',
				status: 400,
				data: { error: BOT_CHECK_FAILED, values: { email } }
			});
			expect(written.size).toBe(0);
		}
		expect(derivations.count).toBe(before);
		// No siteverify request at all: not for a missing or empty token, not for the over-length one.
		expect(calls).toHaveLength(0);
		expect(await lastLogin(email)).toBe(loginBefore);
	});

	it('signs in exactly as before with a token siteverify accepts for this action and host', async () => {
		const email = await account();
		configure();
		const calls = stubSiteverify(passing);
		const clientIp = nextIp();
		const { result, written } = await signIn(
			{ email, password: PASSWORD, 'cf-turnstile-response': TOKEN },
			clientIp
		);
		expect(result).toEqual({ kind: 'redirect', status: 303, location: '/riwayat' });
		expect(written.get('financer_session')).toMatchObject({
			options: { path: '/', httpOnly: true, sameSite: 'lax' }
		});
		expect(await lastLogin(email)).toBeGreaterThan(0);
		// AC 9: the request body carries exactly the documented fields, never the e-mail or password.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(SITEVERIFY_URL);
		const body = calls[0]!.body;
		expect([...body.keys()].sort()).toEqual(['idempotency_key', 'remoteip', 'response', 'secret']);
		expect(body.get('secret')).toBe(SECRET);
		expect(body.get('response')).toBe(TOKEN);
		expect(body.get('remoteip')).toBe(clientIp);
		expect(body.get('idempotency_key')).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		const raw = body.toString();
		expect(raw).not.toContain(encodeURIComponent(email));
		expect(raw).not.toContain(PASSWORD);
	});

	it.each([
		['the sign-up action', { success: true, action: 'sign-up', hostname: 'localhost' }],
		['another host', { success: true, action: 'sign-in', hostname: 'evil.example' }],
		['a spent token', { success: false, 'error-codes': ['timeout-or-duplicate'] }],
		['an invalid token', { success: false, 'error-codes': ['invalid-input-response'] }]
	])('refuses a token siteverify answers for %s', async (_label, verdict) => {
		const email = await account();
		configure();
		stubSiteverify(answer(verdict));
		const before = derivations.count;
		const { result } = await signIn({ email, password: PASSWORD, 'cf-turnstile-response': TOKEN });
		expect(result).toMatchObject({ kind: 'fail', status: 400, data: { error: BOT_CHECK_FAILED } });
		expect(derivations.count).toBe(before);
	});

	it.each([
		['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), 'timeout'],
		['a non-2xx status', () => new Response('oops', { status: 502 }), 'status'],
		['non-JSON', () => new Response('<html>', { status: 200 }), 'non_json'],
		['a network error', () => Promise.reject(new TypeError('fetch failed')), 'network']
	])(
		'refuses on %s within the timeout and logs one reason line without the token',
		async (_label, respond, reason) => {
			const email = await account();
			configure();
			stubSiteverify(respond as () => Response);
			const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const started = Date.now();
			const { result } = await signIn({
				email,
				password: PASSWORD,
				'cf-turnstile-response': TOKEN
			});
			expect(Date.now() - started).toBeLessThan(6000);
			expect(result).toMatchObject({
				kind: 'fail',
				status: 400,
				data: { error: BOT_CHECK_FAILED }
			});
			expect(warned.mock.calls).toEqual([['turnstile: refused', 'sign-in', reason]]);
			expect(JSON.stringify(warned.mock.calls)).not.toContain(TOKEN);
		}
	);

	it('answers 429 as before when the sign-in throttle is spent, without calling siteverify', async () => {
		const email = await account();
		configure();
		const calls = stubSiteverify(passing);
		const clientIp = nextIp();
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i++)
			await signIn({ email, password: 'salah-sekali-1', 'cf-turnstile-response': TOKEN }, clientIp);
		calls.length = 0;
		const { result } = await signIn(
			{ email, password: PASSWORD, 'cf-turnstile-response': TOKEN },
			clientIp
		);
		expect(result).toMatchObject({ kind: 'fail', status: 429, data: { error: TOO_MANY_ATTEMPTS } });
		expect(calls).toHaveLength(0);
	});

	it('guards sign-up the same way: no account without an accepted sign-up token', async () => {
		configure();
		const calls = stubSiteverify(
			answer({ success: true, action: 'sign-up', hostname: 'localhost' })
		);
		const signUp = (email: string, token?: string) => {
			const { event } = fakeEvent({
				url: 'http://localhost/daftar',
				routeId: '/(auth)/daftar',
				db,
				headers: { 'cf-connecting-ip': nextIp() },
				form: {
					name: 'Budi',
					email,
					password: PASSWORD,
					adult: 'on',
					consent: 'on',
					...(token === undefined ? {} : { 'cf-turnstile-response': token })
				}
			});
			return run(() => action(daftar.actions, 'default')(event as never));
		};
		const refused = freshEmail();
		expect(await signUp(refused)).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { error: BOT_CHECK_FAILED }
		});
		const users = async (email: string) =>
			(await d1.prepare('select count(*) as n from users where email = ?').bind(email).first<{
				n: number;
			}>())!.n;
		expect(await users(refused)).toBe(0);
		const accepted = freshEmail();
		expect(await signUp(accepted, TOKEN)).toMatchObject({ kind: 'redirect', status: 303 });
		expect(await users(accepted)).toBe(1);
		expect(calls).toHaveLength(1);
		// The sign-in page's action label is refused on sign-up.
		stubSiteverify(passing);
		expect(await signUp(freshEmail(), TOKEN)).toMatchObject({ kind: 'fail', status: 400 });
	});
});

describe('per-route CSP (AC 1, 3)', () => {
	const csp = cspHeader();
	const resolveWithCsp = vi.fn(
		async () => new Response('ok', { headers: { 'content-security-policy': csp } })
	);
	const headerFor = async (path: string, routeId: string) => {
		const { event } = fakeEvent({ url: `http://localhost${path}`, routeId, db });
		const res = await handle({ event, resolve: resolveWithCsp });
		return res.headers.get('content-security-policy');
	};

	it('adds the widget origin to script-src and frame-src on /masuk and /daftar only while configured', async () => {
		expect(await headerFor('/masuk', '/(auth)/masuk')).toBe(csp);
		configure(SITE_KEY, '');
		expect(await headerFor('/masuk', '/(auth)/masuk')).toBe(csp);
		configure();
		for (const [path, id] of [
			['/masuk', '/(auth)/masuk'],
			['/daftar', '/(auth)/daftar']
		] as const) {
			const header = (await headerFor(path, id))!;
			const directive = (name: string) => header.split('; ').find((d) => d.startsWith(`${name} `));
			expect(directive('script-src')).toBe("script-src 'self' https://challenges.cloudflare.com");
			expect(directive('frame-src')).toBe("frame-src 'self' https://challenges.cloudflare.com");
			expect(header).not.toContain('unsafe-inline');
			// Every other directive is what csp.ts says.
			const others = (h: string) =>
				h.split('; ').filter((d) => !d.startsWith('script-src ') && !d.startsWith('frame-src '));
			expect(others(header)).toEqual(others(csp));
		}
	});

	it('leaves the policy of / and /pengaturan/akun byte-identical while configured', async () => {
		const token = await sessionToken();
		configure();
		for (const [path, routeId] of [
			['/', '/(app)'],
			['/pengaturan/akun', '/(app)/pengaturan/akun']
		]) {
			const { event } = fakeEvent({
				url: `http://localhost${path}`,
				routeId,
				db,
				cookies: { financer_session: token }
			});
			const res = await handle({ event, resolve: resolveWithCsp });
			expect(res.status, path).toBe(200);
			expect(res.headers.get('content-security-policy'), path).toBe(csp);
		}
	});
});
