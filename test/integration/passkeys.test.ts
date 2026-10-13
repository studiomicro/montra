import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { changePassword } from '#lib/server/auth/change-password';
import { deleteAccount } from '#lib/server/auth/delete-account';
import * as messages from '#lib/server/auth/messages';
import {
	INVALID_CREDENTIALS,
	PASSKEY_HOST_UNAVAILABLE,
	PASSKEY_LIMIT,
	PASSKEY_NOT_FOUND,
	PASSKEY_REGISTER_FAILED,
	PASSKEY_SIGN_IN_FAILED,
	TOO_MANY_ATTEMPTS
} from '#lib/server/auth/messages';
import { signInWithPassword } from '#lib/server/auth/password';
import { issueChallenge, verifyRegistrationFor } from '#lib/server/auth/passkey-flow';
import {
	AUTH_EVENT_RETENTION_MS,
	AUTH_EVENT_SWEEP_BATCH,
	listPasskeys,
	sweepAuthEvents
} from '#lib/server/auth/passkeys';
import { resolveSession } from '#lib/server/auth/session';
import { PASSKEY_BEGIN_PER_WINDOW, THROTTLE_MAX_ATTEMPTS } from '#lib/server/auth/throttle';
import { getDb, type Db } from '#lib/server/db';
import { sha256Hex } from '#lib/server/util';
import { base64urlDecode, base64urlEncode } from '#lib/shared/base64url';
import { PASSKEY_CHALLENGE_TTL_MS, PASSKEY_MAX_PER_USER } from '#lib/shared/passkeys';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { FakeAuthenticator } from '../helpers/webauthn';

/**
 * FN-50 Part B: passkey registration, sign-in, removal and lifecycle through the real route actions on local
 * D1, with a software authenticator (test/helpers/webauthn.ts) that makes real ES256/RS256 signatures. Two
 * users throughout; every refusal path is asserted for what it does NOT write as well.
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const masuk = await import('../../src/routes/(auth)/masuk/+page.server');
const passkeyPage = await import('../../src/routes/(app)/pengaturan/akun/passkey/+page.server');
const akun = await import('../../src/routes/(app)/pengaturan/akun/+page.server');
const api = await import('../../src/routes/(app)/pengaturan/api/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const ORIGIN = 'http://localhost';
const COOKIE = 'financer_session';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());
afterEach(() => vi.restoreAllMocks());

type Action = (event: never) => unknown;
const action = (actions: unknown, name: string) =>
	(actions as Record<string, Action>)[name] as Action;

type Outcome =
	| { kind: 'fail'; status: number; data: Record<string, unknown> }
	| { kind: 'ok'; value: Record<string, unknown> }
	| { kind: 'redirect'; status: number; location: string }
	| { kind: 'error'; status: number };

async function run(fn: () => unknown): Promise<Outcome> {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail',
				status: value.status,
				data: value.data as unknown as Record<string, unknown>
			};
		return { kind: 'ok', value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect', status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error', status: e.status };
		throw e;
	}
}

let ip = 0;
/** A distinct client per call, so the per-client budgets never mix tests. */
const nextIp = () => {
	ip += 1;
	return `10.50.${Math.floor(ip / 250)}.${(ip % 250) + 1}`;
};
let n = 0;
const freshEmail = () => `passkey-${++n}-${Date.now()}@contoh.id`;

interface Account {
	id: string;
	email: string;
	token: string;
	user: NonNullable<App.Locals['user']>;
}

async function account(): Promise<Account> {
	const email = freshEmail();
	const r = await signUp(
		db,
		{ name: 'Budi', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('sign-up setup failed');
	const user = await resolveSession(db, r.token, Date.now());
	return { id: r.userId, email, token: r.token, user: user! };
}

/** A management-page action as `who` (the session the cookie names). */
function manage(
	who: Account,
	name: 'registerOptions' | 'register' | 'remove',
	form: Record<string, string>,
	{ token = who.token, host = 'localhost', clientIp = nextIp() } = {}
) {
	const { event } = fakeEvent({
		url: `http://${host}/pengaturan/akun/passkey`,
		routeId: '/(app)/pengaturan/akun/passkey',
		db,
		user: who.user,
		sessionToken: token,
		headers: { 'cf-connecting-ip': clientIp, origin: `http://${host}` },
		form
	});
	return run(() => action(passkeyPage.actions, name)(event as never));
}

async function registrationChallenge(who: Account) {
	const r = await manage(who, 'registerOptions', { password: PASSWORD });
	if (r.kind !== 'ok') throw new Error(`registerOptions refused: ${JSON.stringify(r)}`);
	return (r.value.options as { challenge: string }).challenge;
}

/** Registers a new authenticator for `who` through both actions; returns it and the register outcome. */
async function registerPasskey(
	who: Account,
	options: Parameters<typeof FakeAuthenticator.create>[0] = {},
	name = ''
) {
	const authenticator = await FakeAuthenticator.create(options);
	const challenge = await registrationChallenge(who);
	const fields = await authenticator.register(challenge);
	const outcome = await manage(who, 'register', { ...fields, name });
	return { authenticator, outcome, fields };
}

async function signInChallenge(clientIp = nextIp()) {
	const { event } = fakeEvent({
		url: `${ORIGIN}/masuk`,
		routeId: '/(auth)/masuk',
		db,
		headers: { 'cf-connecting-ip': clientIp },
		form: {}
	});
	const r = await run(() => action(masuk.actions, 'passkeyOptions')(event as never));
	if (r.kind !== 'ok') throw new Error(`passkeyOptions refused: ${JSON.stringify(r)}`);
	return r.value.passkeyOptions as { challenge: string; rpId: string; allowCredentials: unknown[] };
}

async function postAssertion(
	fields: Record<string, string>,
	{ clientIp = nextIp(), cookie, next }: { clientIp?: string; cookie?: string; next?: string } = {}
) {
	const { event, written } = fakeEvent({
		url: `${ORIGIN}/masuk${next ? `?next=${encodeURIComponent(next)}` : ''}`,
		routeId: '/(auth)/masuk',
		db,
		headers: { 'cf-connecting-ip': clientIp },
		sessionToken: cookie ?? null,
		form: fields
	});
	const result = await run(() => action(masuk.actions, 'passkey')(event as never));
	return { result, token: written.get(COOKIE)?.value, written };
}

/** A full passkey sign-in with `authenticator`; returns the new session token. */
async function passkeySignIn(authenticator: FakeAuthenticator, cookie?: string) {
	const { challenge } = await signInChallenge();
	const { result, token } = await postAssertion(await authenticator.assert(challenge), { cookie });
	if (result.kind !== 'redirect' || !token)
		throw new Error(`sign-in refused: ${JSON.stringify(result)}`);
	return token;
}

const one = <T>(sql: string, ...binds: unknown[]) =>
	d1
		.prepare(sql)
		.bind(...binds)
		.first<T>();
const count = async (sql: string, ...binds: unknown[]) =>
	(await one<{ n: number }>(sql, ...binds))!.n;
const passkeyRows = (userId: string) =>
	d1
		.prepare('select * from passkeys where user_id = ? order by created_at')
		.bind(userId)
		.all<Record<string, unknown>>()
		.then((r) => r.results);
const events = (userId: string) =>
	d1
		.prepare(
			'select kind, passkey_id from auth_events where user_id = ? order by created_at, rowid'
		)
		.bind(userId)
		.all<{ kind: string; passkey_id: string | null }>()
		.then((r) => r.results.map((e) => e.kind));
const challengeRow = (challenge: string) =>
	one<Record<string, unknown>>('select * from passkey_challenges where challenge = ?', challenge);
const sessionsOf = (userId: string) =>
	count('select count(*) as n from sessions where user_id = ? and revoked_at is null', userId);
const sessionRow = async (token: string) =>
	one<Record<string, unknown>>(
		'select * from sessions where token_hash = ?',
		await sha256Hex(token)
	);

describe('registration (AC 17 – 24)', () => {
	it('refuses a wrong current password, counts it toward account-password and writes no challenge', async () => {
		const a = await account();
		const before = await count('select count(*) as n from passkey_challenges');
		const r = await manage(a, 'registerOptions', { password: 'bukan-ini-1' });
		expect(r).toEqual({ kind: 'fail', status: 400, data: { error: INVALID_CREDENTIALS } });
		expect(await count('select count(*) as n from passkey_challenges')).toBe(before);
		const key = await sha256Hex(`account-password:user:${a.id}`);
		expect(await one('select count from auth_attempts where client_hash = ?', key)).toEqual({
			count: 1
		});
	});

	it('issues one register challenge for this user with the documented options', async () => {
		const a = await account();
		const first = await registerPasskey(a);
		expect(first.outcome).toEqual({ kind: 'ok', value: { registered: true } });
		const r = await manage(a, 'registerOptions', { password: PASSWORD });
		expect(r.kind).toBe('ok');
		if (r.kind !== 'ok') throw new Error('registerOptions refused');
		const options = r.value.options as {
			rp: { id: string };
			user: { id: string; name: string };
			challenge: string;
			attestation: string;
			pubKeyCredParams: unknown;
			excludeCredentials: { id: string }[];
			authenticatorSelection: unknown;
		};
		expect(options.rp.id).toBe('localhost');
		const handleBytes = base64urlDecode(options.user.id)!;
		expect(handleBytes).toHaveLength(32);
		expect(options.user.id).not.toContain(a.id);
		expect(new TextDecoder().decode(handleBytes)).not.toContain(a.email);
		// Stable per account: the same handle every time, so an authenticator replaces rather than duplicates.
		const again = await manage(a, 'registerOptions', { password: PASSWORD });
		if (again.kind !== 'ok') throw new Error('registerOptions refused');
		expect((again.value.options as { user: { id: string } }).user.id).toBe(options.user.id);
		expect(options.attestation).toBe('none');
		expect(options.pubKeyCredParams).toEqual([
			{ type: 'public-key', alg: -7 },
			{ type: 'public-key', alg: -257 }
		]);
		expect(options.authenticatorSelection).toEqual({
			residentKey: 'preferred',
			userVerification: 'preferred'
		});
		expect(options.excludeCredentials.map((c) => c.id)).toEqual([
			first.authenticator.credentialIdB64
		]);
		const row = (await challengeRow(options.challenge))!;
		expect(row).toMatchObject({ kind: 'register', user_id: a.id, used_at: null });
		expect(Number(row.expires_at) - Number(row.created_at)).toBe(PASSKEY_CHALLENGE_TTL_MS);
	});

	it('writes the passkey, consumes the challenge and records passkey_added (ES256 and RS256)', async () => {
		const a = await account();
		const es = await registerPasskey(
			a,
			{ aaguid: new Uint8Array(16).fill(0xab), counter: 3, backedUp: true },
			'  iPhone\u0000 Budi​ yang sangat panjang sekali namanya lebih dari empat puluh  '
		);
		expect(es.outcome).toEqual({ kind: 'ok', value: { registered: true } });
		const rs = await registerPasskey(a, { algorithm: -257 });
		expect(rs.outcome.kind).toBe('ok');
		const [first, second] = await passkeyRows(a.id);
		expect(first).toMatchObject({
			credential_id: es.authenticator.credentialIdB64,
			public_key: es.authenticator.publicKeyB64,
			algorithm: -7,
			counter: 3,
			transports: '["internal"]',
			aaguid: 'abababab-abab-abab-abab-abababababab',
			rp_id: 'localhost',
			backed_up: 1,
			deleted_at: null,
			last_used_at: null
		});
		const name = String(first!.name);
		expect(name.length).toBeLessThanOrEqual(40);
		expect([...name].some((c) => c.charCodeAt(0) < 0x20 || c === '\u200b')).toBe(false);
		expect(name.startsWith('iPhone')).toBe(true);
		expect(second).toMatchObject({ algorithm: -257, backed_up: 0 });
		// The default name: "Passkey <WIB date>".
		expect(String(second!.name)).toMatch(/^Passkey \d{1,2} \S+ \d{4}$/);
		expect(await events(a.id)).toEqual(['passkey_added', 'passkey_added']);
		const fieldsChallenge = JSON.parse(
			new TextDecoder().decode(base64urlDecode(es.fields.clientDataJSON)!)
		).challenge;
		const consumed = (await challengeRow(fieldsChallenge))!;
		expect(consumed.used_at).not.toBeNull();
		expect(consumed.used_by).toBe(first!.id);
		// The list shows both, never the public key or credential id.
		const listed = await listPasskeys(db, a.id);
		expect(listed).toHaveLength(2);
		expect(JSON.stringify(listed)).not.toContain(es.authenticator.credentialIdB64);
		expect(JSON.stringify(listed)).not.toContain(es.authenticator.publicKeyB64);
	});

	it('accepts a registration response once: a second post of it is refused, one row exists', async () => {
		const a = await account();
		const { fields, outcome } = await registerPasskey(a);
		expect(outcome.kind).toBe('ok');
		const again = await manage(a, 'register', fields);
		expect(again).toEqual({ kind: 'fail', status: 400, data: { error: PASSKEY_REGISTER_FAILED } });
		expect(await passkeyRows(a.id)).toHaveLength(1);
		expect(await events(a.id)).toEqual(['passkey_added']);
	});

	it.each([
		['a foreign origin', { origin: 'https://evil.example' }],
		['another host’s rpIdHash', { rpId: 'evil.example' }],
		['a get-type clientData', { type: 'webauthn.get' }],
		['no user presence', { flags: 0x44 }]
	])('refuses %s and writes nothing (challenge left unconsumed)', async (_label, overrides) => {
		const a = await account();
		const authenticator = await FakeAuthenticator.create();
		const challenge = await registrationChallenge(a);
		const fields = await authenticator.register(challenge, overrides);
		const r = await manage(a, 'register', fields);
		expect(r).toEqual({ kind: 'fail', status: 400, data: { error: PASSKEY_REGISTER_FAILED } });
		expect(await passkeyRows(a.id)).toHaveLength(0);
		expect(await events(a.id)).toEqual([]);
		expect((await challengeRow(challenge))!.used_at).toBeNull();
	});

	it('refuses a response to a challenge older than 5 minutes and leaves it unconsumed', async () => {
		const a = await account();
		const authenticator = await FakeAuthenticator.create();
		const challenge = await registrationChallenge(a);
		const now = Date.now();
		await d1
			.prepare('update passkey_challenges set created_at = ?, expires_at = ? where challenge = ?')
			.bind(now - PASSKEY_CHALLENGE_TTL_MS - 1000, now - 1000, challenge)
			.run();
		const r = await manage(a, 'register', await authenticator.register(challenge));
		expect(r).toEqual({ kind: 'fail', status: 400, data: { error: PASSKEY_REGISTER_FAILED } });
		expect(await passkeyRows(a.id)).toHaveLength(0);
		expect((await challengeRow(challenge))!.used_at).toBeNull();
	});

	it('refuses past 10 live passkeys with the limit message and writes no challenge', async () => {
		const a = await account();
		const now = Date.now();
		// Ten passkeys written directly (the actions' per-user budget is 20 per window).
		for (let i = 0; i < PASSKEY_MAX_PER_USER; i++) {
			const auth = await FakeAuthenticator.create();
			const issued = await issueChallenge(db, 'register', a.id, now);
			const r = await verifyRegistrationFor(
				db,
				a,
				{
					...(await auth.register(issued.challenge)),
					transports: ['internal'],
					name: `Kunci ${i}`
				},
				{ origin: ORIGIN, rpId: 'localhost' },
				'Passkey',
				now
			);
			expect(r.ok).toBe(true);
		}
		const before = await count(
			'select count(*) as n from passkey_challenges where user_id = ?',
			a.id
		);
		const r = await manage(a, 'registerOptions', { password: PASSWORD });
		expect(r).toEqual({ kind: 'fail', status: 400, data: { error: PASSKEY_LIMIT } });
		expect(
			await count('select count(*) as n from passkey_challenges where user_id = ?', a.id)
		).toBe(before);
	});

	it('holds the cap under 20 concurrent registrations: exactly 10 rows (pre-handoff concurrency probe)', async () => {
		const a = await account();
		const now = Date.now();
		const attempts = await Promise.all(
			Array.from({ length: 20 }, async () => {
				const auth = await FakeAuthenticator.create();
				const issued = await issueChallenge(db, 'register', a.id, now);
				return { auth, challenge: issued.challenge };
			})
		);
		const results = await Promise.all(
			attempts.map(async ({ auth, challenge }) =>
				verifyRegistrationFor(
					db,
					a,
					{ ...(await auth.register(challenge)), transports: [], name: '' },
					{ origin: ORIGIN, rpId: 'localhost' },
					'Passkey',
					now
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(PASSKEY_MAX_PER_USER);
		expect(await passkeyRows(a.id)).toHaveLength(PASSKEY_MAX_PER_USER);
		expect(await events(a.id)).toHaveLength(PASSKEY_MAX_PER_USER);
	});

	it('refuses user B answering a challenge issued to user A; nothing is written for either', async () => {
		const a = await account();
		const b = await account();
		const authenticator = await FakeAuthenticator.create();
		const challenge = await registrationChallenge(a);
		const r = await manage(b, 'register', await authenticator.register(challenge));
		expect(r).toEqual({ kind: 'fail', status: 400, data: { error: PASSKEY_REGISTER_FAILED } });
		expect(await passkeyRows(a.id)).toHaveLength(0);
		expect(await passkeyRows(b.id)).toHaveLength(0);
		expect((await challengeRow(challenge))!.used_at).toBeNull();
	});

	it('refuses passkey actions on a host that cannot be an rpId', async () => {
		const a = await account();
		for (const host of ['192.0.2.10', 'montra-preview.workers.dev'])
			expect(await manage(a, 'registerOptions', { password: PASSWORD }, { host })).toEqual({
				kind: 'fail',
				status: 400,
				data: { error: PASSKEY_HOST_UNAVAILABLE }
			});
	});
});

describe('sign-in (AC 25 – 33)', () => {
	it('has only named actions: SvelteKit answers 500 to every action of a page that mixes `default` with named ones', () => {
		expect(Object.keys(masuk.actions).sort()).toEqual(['passkey', 'passkeyOptions', 'password']);
	});

	it('issues a discoverable sign_in challenge with no allowed credentials', async () => {
		const before = await count(
			`select count(*) as n from passkey_challenges where kind = 'sign_in'`
		);
		const options = await signInChallenge();
		expect(options).toMatchObject({
			rpId: 'localhost',
			allowCredentials: [],
			userVerification: 'preferred'
		});
		expect(await challengeRow(options.challenge)).toMatchObject({
			kind: 'sign_in',
			user_id: null,
			used_at: null
		});
		expect(await count(`select count(*) as n from passkey_challenges where kind = 'sign_in'`)).toBe(
			before + 1
		);
	});

	it('signs in: session cookie like a password one, counter and last use, event, old cookie revoked, safe next', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a, { counter: 7 });
		const { challenge } = await signInChallenge();
		const loginBefore = (await one<{ t: number }>(
			'select last_login_at as t from users where id = ?',
			a.id
		))!.t;
		const { result, token, written } = await postAssertion(await authenticator.assert(challenge), {
			cookie: a.token,
			next: '/riwayat'
		});
		expect(result).toEqual({ kind: 'redirect', status: 303, location: '/riwayat' });
		expect(written.get(COOKIE)!.options).toMatchObject({
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: false
		});
		const session = (await sessionRow(token!))!;
		const [passkey] = await passkeyRows(a.id);
		expect(session).toMatchObject({ user_id: a.id, revoked_at: null });
		expect(
			await one('select user_id, passkey_id from passkey_sessions where session_id = ?', session.id)
		).toEqual({ user_id: a.id, passkey_id: passkey!.id });
		expect(passkey).toMatchObject({ counter: 8 });
		expect(passkey!.last_used_at).not.toBeNull();
		expect((await challengeRow(challenge))!.used_by).toBe(session.id);
		expect(await events(a.id)).toEqual(['passkey_added', 'passkey_sign_in']);
		expect(
			(await one<{ t: number }>('select last_login_at as t from users where id = ?', a.id))!.t
		).toBeGreaterThanOrEqual(loginBefore);
		// The cookie the browser held before is revoked (red team L7 rule, as for a password sign-in).
		expect((await sessionRow(a.token))!.revoked_at).not.toBeNull();
		// A hostile next is replaced by the safe default.
		const again = await signInChallenge();
		const hostile = await postAssertion(await authenticator.assert(again.challenge), {
			next: '//evil.example'
		});
		expect(hostile.result).toEqual({ kind: 'redirect', status: 303, location: '/' });
	});

	it('accepts one assertion once: a replay is refused and no second session exists', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a);
		const { challenge } = await signInChallenge();
		const fields = await authenticator.assert(challenge);
		const first = await postAssertion(fields);
		expect(first.result.kind).toBe('redirect');
		const sessions = await sessionsOf(a.id);
		const replay = await postAssertion(fields);
		expect(replay.result).toEqual({
			kind: 'fail',
			status: 400,
			data: { passkeyError: PASSKEY_SIGN_IN_FAILED }
		});
		expect(replay.token).toBeUndefined();
		expect(await sessionsOf(a.id)).toBe(sessions);
	});

	it('of 20 concurrent posts of one assertion in the same millisecond exactly one gets a session (AC 46)', async () => {
		const a = await account();
		// An authenticator that never counts (0 → 0): the counter guard cannot tell the posts apart.
		const { authenticator } = await registerPasskey(a, { counter: 0 });
		const { challenge } = await signInChallenge();
		const fields = await authenticator.assert(challenge);
		const sessions = await sessionsOf(a.id);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now());
		const results = await Promise.all(Array.from({ length: 20 }, () => postAssertion(fields)));
		expect(results.filter((r) => r.result.kind === 'redirect')).toHaveLength(1);
		expect(await sessionsOf(a.id)).toBe(sessions + 1);
		expect((await events(a.id)).filter((k) => k === 'passkey_sign_in')).toHaveLength(1);
	});

	it.each([
		['a wrong origin', { origin: 'https://evil.example' }],
		['a wrong rpIdHash', { rpId: 'evil.example' }],
		['a create-type clientData', { type: 'webauthn.create' }],
		['altered authenticator data', { tamperAuthData: true }]
	])(
		'refuses %s, recording only passkey_refused for the known credential',
		async (_label, overrides) => {
			const a = await account();
			const { authenticator } = await registerPasskey(a, { counter: 1 });
			const { challenge } = await signInChallenge();
			const sessions = await sessionsOf(a.id);
			const { result, token } = await postAssertion(
				await authenticator.assert(challenge, overrides)
			);
			expect(result).toEqual({
				kind: 'fail',
				status: 400,
				data: { passkeyError: PASSKEY_SIGN_IN_FAILED }
			});
			expect(token).toBeUndefined();
			expect(await sessionsOf(a.id)).toBe(sessions);
			expect(await events(a.id)).toEqual(['passkey_added', 'passkey_refused']);
			expect(await passkeyRows(a.id)).toMatchObject([{ counter: 1, last_used_at: null }]);
			expect((await challengeRow(challenge))!.used_at).toBeNull();
		}
	);

	it('refuses a signature by another key', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a);
		const other = await FakeAuthenticator.create();
		const { challenge } = await signInChallenge();
		const { result } = await postAssertion(
			await authenticator.assert(challenge, { signWith: other.privateKey })
		);
		expect(result).toEqual({
			kind: 'fail',
			status: 400,
			data: { passkeyError: PASSKEY_SIGN_IN_FAILED }
		});
		expect(await events(a.id)).toEqual(['passkey_added', 'passkey_refused']);
	});

	it('refuses a counter that does not move forward, records the rollback and stays usable', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a, { counter: 5 });
		for (const counter of [5, 3]) {
			const { challenge } = await signInChallenge();
			const { result } = await postAssertion(await authenticator.assert(challenge, { counter }));
			expect(result).toEqual({
				kind: 'fail',
				status: 400,
				data: { passkeyError: PASSKEY_SIGN_IN_FAILED }
			});
		}
		expect(await events(a.id)).toEqual([
			'passkey_added',
			'passkey_counter_rollback',
			'passkey_counter_rollback'
		]);
		expect(await passkeyRows(a.id)).toMatchObject([{ counter: 5, deleted_at: null }]);
		// A higher counter still signs in.
		await passkeySignIn(authenticator);
		expect(await passkeyRows(a.id)).toMatchObject([{ counter: 6 }]);
	});

	it('accepts 0 → 0 for an authenticator that never counts, every time', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a, { counter: 0 });
		await passkeySignIn(authenticator);
		await passkeySignIn(authenticator);
		expect(await passkeyRows(a.id)).toMatchObject([{ counter: 0 }]);
	});

	it('answers a removed passkey and an unknown credential exactly alike', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a);
		const [row] = await passkeyRows(a.id);
		await d1
			.prepare('update passkeys set deleted_at = ? where id = ?')
			.bind(Date.now(), row!.id)
			.run();
		const stranger = await FakeAuthenticator.create();
		const removed = await postAssertion(
			await authenticator.assert((await signInChallenge()).challenge)
		);
		const unknown = await postAssertion(await stranger.assert((await signInChallenge()).challenge));
		expect(removed.result).toEqual({
			kind: 'fail',
			status: 400,
			data: { passkeyError: PASSKEY_SIGN_IN_FAILED }
		});
		expect(unknown.result).toEqual(removed.result);
		expect(removed.token).toBeUndefined();
	});

	it('creates no session for a disabled account', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a, { counter: 2 });
		await d1.prepare(`update users set status = 'disabled' where id = ?`).bind(a.id).run();
		const sessions = await count('select count(*) as n from sessions where user_id = ?', a.id);
		const { challenge } = await signInChallenge();
		const { result, token } = await postAssertion(await authenticator.assert(challenge));
		expect(result).toEqual({
			kind: 'fail',
			status: 400,
			data: { passkeyError: PASSKEY_SIGN_IN_FAILED }
		});
		expect(token).toBeUndefined();
		expect(await count('select count(*) as n from sessions where user_id = ?', a.id)).toBe(
			sessions
		);
		expect(await passkeyRows(a.id)).toMatchObject([{ counter: 2, last_used_at: null }]);
	});

	it('signs two users in as themselves; the discoverable options never list a credential', async () => {
		const a = await account();
		const b = await account();
		const ka = (await registerPasskey(a)).authenticator;
		const kb = (await registerPasskey(b)).authenticator;
		const options = await signInChallenge();
		expect(options.allowCredentials).toEqual([]);
		expect(JSON.stringify(options)).not.toContain(kb.credentialIdB64);
		const ta = await passkeySignIn(ka);
		const tb = await passkeySignIn(kb);
		expect((await resolveSession(db, ta, Date.now()))!.id).toBe(a.id);
		expect((await resolveSession(db, tb, Date.now()))!.id).toBe(b.id);
		// A's credential id with B's signature is a refusal, not B's session.
		const { challenge } = await signInChallenge();
		const forged = { ...(await kb.assert(challenge)), id: ka.credentialIdB64 };
		expect((await postAssertion(forged)).result.kind).toBe('fail');
	});

	it('throttles 61 option requests and 21 assertions per client, and fails closed without D1', async () => {
		const clientIp = '192.0.2.77';
		for (let i = 0; i < PASSKEY_BEGIN_PER_WINDOW; i++) await signInChallenge(clientIp);
		const before = await count('select count(*) as n from passkey_challenges');
		const { event } = fakeEvent({
			url: `${ORIGIN}/masuk`,
			routeId: '/(auth)/masuk',
			db,
			headers: { 'cf-connecting-ip': clientIp },
			form: {}
		});
		expect(await run(() => action(masuk.actions, 'passkeyOptions')(event as never))).toEqual({
			kind: 'fail',
			status: 429,
			data: { passkeyError: TOO_MANY_ATTEMPTS }
		});
		expect(await count('select count(*) as n from passkey_challenges')).toBe(before);
		const finishIp = '192.0.2.78';
		const junk = {
			id: 'x'.repeat(22),
			authenticatorData: 'AA',
			clientDataJSON: 'AA',
			signature: 'AA'
		};
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i++)
			expect((await postAssertion(junk, { clientIp: finishIp })).result).toMatchObject({
				status: 400
			});
		expect((await postAssertion(junk, { clientIp: finishIp })).result).toEqual({
			kind: 'fail',
			status: 429,
			data: { passkeyError: TOO_MANY_ATTEMPTS }
		});
		// D1 unavailable: both refuse with 429, never an unthrottled attempt.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const broken = getDb({
			prepare() {
				throw new Error('D1 unavailable');
			},
			batch() {
				throw new Error('D1 unavailable');
			}
		} as unknown as D1Database);
		for (const name of ['passkeyOptions', 'passkey']) {
			const e = fakeEvent({
				url: `${ORIGIN}/masuk`,
				routeId: '/(auth)/masuk',
				db: broken,
				form: junk
			});
			expect(await run(() => action(masuk.actions, name)(e.event as never))).toMatchObject({
				kind: 'fail',
				status: 429
			});
		}
	});
});

describe('the password stays the proof for sensitive actions after a passkey sign-in (AC 37)', () => {
	it('key material, password change, account deletion and API tokens still demand the password', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a);
		const token = await passkeySignIn(authenticator);
		const user = (await resolveSession(db, token, Date.now()))!;
		const call = (module: unknown, name: string, form: Record<string, string>) => {
			const { event } = fakeEvent({
				url: `${ORIGIN}/pengaturan/akun`,
				routeId: '/(app)/pengaturan/akun',
				db,
				user,
				sessionToken: token,
				headers: { 'cf-connecting-ip': nextIp() },
				form
			});
			return run(() => action((module as { actions: unknown }).actions, name)(event as never));
		};
		expect(await call(akun, 'keyMaterial', { password: '' })).toEqual({
			kind: 'fail',
			status: 400,
			data: { keyError: INVALID_CREDENTIALS }
		});
		expect(
			await call(akun, 'changePassword', {
				password: '',
				newPassword: 'teh-sore-2026-baru',
				confirmPassword: 'teh-sore-2026-baru'
			})
		).toMatchObject({ kind: 'fail', status: 400, data: { passwordError: INVALID_CREDENTIALS } });
		expect(await call(akun, 'deleteAccount', { password: '', confirm: 'on' })).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { deleteError: INVALID_CREDENTIALS }
		});
		expect(
			await call(api, 'create', {
				name: 'Skrip',
				scope: 'read',
				space: '',
				lifetime: '30',
				password: ''
			})
		).toMatchObject({ kind: 'fail' });
		expect(await one('select id from users where id = ?', a.id)).toEqual({ id: a.id });
		expect(await count('select count(*) as n from api_tokens where user_id = ?', a.id)).toBe(0);
	});
});

describe('management and lifecycle (AC 38 – 42, 44)', () => {
	it('removes one passkey: tombstone, event, its other sessions revoked, the current one kept', async () => {
		const a = await account();
		const one1 = await registerPasskey(a, { counter: 1 });
		const two = await registerPasskey(a, { counter: 1 });
		const current = await passkeySignIn(one1.authenticator);
		const otherDevice = await passkeySignIn(one1.authenticator);
		const viaSecond = await passkeySignIn(two.authenticator);
		const [p1] = await passkeyRows(a.id);
		const me = { ...a, token: current, user: (await resolveSession(db, current, Date.now()))! };
		const r = await manage(me, 'remove', { passkeyId: String(p1!.id), password: PASSWORD });
		expect(r).toEqual({ kind: 'ok', value: { removed: true } });
		const rows = await passkeyRows(a.id);
		expect(rows.find((p) => p.id === p1!.id)!.deleted_at).not.toBeNull();
		expect((await sessionRow(current))!.revoked_at).toBeNull();
		expect((await sessionRow(otherDevice))!.revoked_at).not.toBeNull();
		expect((await sessionRow(viaSecond))!.revoked_at).toBeNull();
		expect((await sessionRow(a.token))!.revoked_at).toBeNull();
		expect((await events(a.id)).at(-1)).toBe('passkey_removed');
		expect(await listPasskeys(db, a.id)).toHaveLength(1);
	});

	it('answers another user’s passkey id exactly like an unknown id and leaves it untouched', async () => {
		const a = await account();
		const b = await account();
		await registerPasskey(a);
		const [row] = await passkeyRows(a.id);
		const foreign = await manage(b, 'remove', { passkeyId: String(row!.id), password: PASSWORD });
		const unknown = await manage(b, 'remove', { passkeyId: 'tidak-ada', password: PASSWORD });
		expect(foreign).toEqual({ kind: 'fail', status: 404, data: { error: PASSKEY_NOT_FOUND } });
		expect(unknown).toEqual(foreign);
		expect(await passkeyRows(a.id)).toMatchObject([{ deleted_at: null }]);
		expect(await events(a.id)).toEqual(['passkey_added']);
	});

	it('refuses a removal with a wrong password', async () => {
		const a = await account();
		await registerPasskey(a);
		const [row] = await passkeyRows(a.id);
		expect(
			await manage(a, 'remove', { passkeyId: String(row!.id), password: 'bukan-ini-1' })
		).toEqual({
			kind: 'fail',
			status: 400,
			data: { error: INVALID_CREDENTIALS }
		});
		expect(await passkeyRows(a.id)).toMatchObject([{ deleted_at: null }]);
	});

	it('lets a removed authenticator register again as a new row', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a);
		const [old] = await passkeyRows(a.id);
		await manage(a, 'remove', { passkeyId: String(old!.id), password: PASSWORD });
		const challenge = await registrationChallenge(a);
		expect(await manage(a, 'register', await authenticator.register(challenge))).toEqual({
			kind: 'ok',
			value: { registered: true }
		});
		const rows = await passkeyRows(a.id);
		expect(rows).toHaveLength(2);
		expect(rows.filter((r) => r.deleted_at === null)).toHaveLength(1);
		expect(new Set(rows.map((r) => r.credential_id))).toEqual(
			new Set([authenticator.credentialIdB64])
		);
	});

	it('keeps passkeys through a password change; passkey sessions elsewhere are revoked like any other', async () => {
		const a = await account();
		const { authenticator } = await registerPasskey(a, { counter: 1 });
		const elsewhere = await passkeySignIn(authenticator);
		const proof = await signInWithPassword(db, a.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof failed');
		expect(
			await changePassword(db, a.id, proof.hash, a.token, 'teh-sore-2026-baru', null, Date.now())
		).toBe(true);
		expect((await sessionRow(elsewhere))!.revoked_at).not.toBeNull();
		expect((await sessionRow(a.token))!.revoked_at).toBeNull();
		expect(await passkeyRows(a.id)).toMatchObject([{ deleted_at: null }]);
		await passkeySignIn(authenticator);
	});

	it('deletes the account’s passkeys, challenges and events with the account', async () => {
		const a = await account();
		const b = await account();
		const { authenticator } = await registerPasskey(a);
		await registerPasskey(b);
		await passkeySignIn(authenticator);
		await registrationChallenge(a);
		const proof = await signInWithPassword(db, a.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, a.id, proof.hash, Date.now(), null)).toBe(true);
		for (const table of ['passkeys', 'passkey_challenges', 'auth_events'])
			expect(await count(`select count(*) as n from ${table} where user_id = ?`, a.id), table).toBe(
				0
			);
		expect(await passkeyRows(b.id)).toHaveLength(1);
		expect(await events(b.id)).toEqual(['passkey_added']);
	});

	it('gates the page and its actions like every (app) route when signed out', async () => {
		const resolve = vi.fn(async () => new Response('ok'));
		const get = fakeEvent({
			url: `${ORIGIN}/pengaturan/akun/passkey`,
			routeId: '/(app)/pengaturan/akun/passkey',
			db
		});
		const page = await handle({ event: get.event, resolve });
		expect(page.status).toBe(303);
		expect(page.headers.get('location')).toBe('/masuk?next=%2Fpengaturan%2Fakun%2Fpasskey');
		for (const name of ['registerOptions', 'register', 'remove']) {
			const post = fakeEvent({
				url: `${ORIGIN}/pengaturan/akun/passkey?/${name}`,
				routeId: '/(app)/pengaturan/akun/passkey',
				db,
				headers: { origin: ORIGIN },
				form: { password: PASSWORD }
			});
			expect((await handle({ event: post.event, resolve })).status).toBe(401);
		}
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe('hostile input (AC 45, 48)', () => {
	it('answers malformed base64url, CBOR and over-long fields with the fixed refusal, never a 500', async () => {
		const a = await account();
		const challenge = await registrationChallenge(a);
		const clientDataJSON = base64urlEncode(
			new TextEncoder().encode(
				JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN })
			)
		);
		for (const fields of [
			{ id: 'abc', attestationObject: 'not*base64url!', clientDataJSON },
			{
				id: 'abc',
				attestationObject: base64urlEncode(new Uint8Array([0xbf, 0x01, 0xff])),
				clientDataJSON
			},
			{ id: 'abc', attestationObject: 'A'.repeat(7000), clientDataJSON },
			{ id: 'abc', attestationObject: 'AA', clientDataJSON: '%%%' },
			{
				id: 'abc',
				attestationObject: 'AA',
				clientDataJSON: base64urlEncode(new TextEncoder().encode('[1,2'))
			}
		])
			expect(await manage(a, 'register', fields)).toEqual({
				kind: 'fail',
				status: 400,
				data: { error: PASSKEY_REGISTER_FAILED }
			});
		for (const fields of [
			{ id: 'abc', authenticatorData: '***', clientDataJSON: '***', signature: '***' },
			{ id: '', authenticatorData: '', clientDataJSON: '', signature: '' },
			{ id: 'x'.repeat(5000), authenticatorData: 'AA', clientDataJSON: 'AA', signature: 'AA' }
		])
			expect((await postAssertion(fields)).result).toEqual({
				kind: 'fail',
				status: 400,
				data: { passkeyError: PASSKEY_SIGN_IN_FAILED }
			});
		// Not a form, or a body over the form cap: 415 / 400 from the shared guard.
		const json = fakeEvent({
			url: `${ORIGIN}/masuk`,
			routeId: '/(auth)/masuk',
			db,
			headers: { 'content-type': 'application/json' },
			form: { id: 'x' }
		});
		expect(await run(() => action(masuk.actions, 'passkey')(json.event as never))).toEqual({
			kind: 'error',
			status: 415
		});
		const big = fakeEvent({
			url: `${ORIGIN}/masuk`,
			routeId: '/(auth)/masuk',
			db,
			form: { signature: 'A'.repeat(20_000) }
		});
		expect(await run(() => action(masuk.actions, 'passkey')(big.event as never))).toEqual({
			kind: 'error',
			status: 400
		});
	});

	it('never puts a credential id, challenge, key, token or e-mail into a message or a log line', async () => {
		for (const text of Object.values(messages))
			expect(String(text)).not.toMatch(/[A-Za-z0-9_-]{20,}|@|\/src\//);
		const logs: unknown[][] = [];
		for (const level of ['log', 'warn', 'error', 'info'] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
		const a = await account();
		const { authenticator } = await registerPasskey(a, { counter: 4 });
		const { challenge } = await signInChallenge();
		await postAssertion(await authenticator.assert(challenge, { origin: 'https://evil.example' }));
		await postAssertion(
			await authenticator.assert((await signInChallenge()).challenge, { counter: 1 })
		);
		const stranger = await FakeAuthenticator.create();
		const regChallenge = await registrationChallenge(a);
		await manage(
			a,
			'register',
			await stranger.register(regChallenge, { origin: 'https://evil.example' })
		);
		const token = await passkeySignIn(authenticator);
		const text = JSON.stringify(logs);
		expect(logs.length).toBeGreaterThan(0);
		for (const secret of [
			authenticator.credentialIdB64,
			authenticator.publicKeyB64,
			stranger.credentialIdB64,
			challenge,
			regChallenge,
			token,
			a.email
		])
			expect(text).not.toContain(secret);
	});
});

describe('retention (Owner decision 11, challenge sweep)', () => {
	it('sweeps auth_events older than 90 days, at most one batch per call, and keeps newer ones', async () => {
		const a = await account();
		const now = Date.now();
		const old = now - AUTH_EVENT_RETENTION_MS - 1000;
		// One statement for all of them (a 500-statement batch is slow on local D1).
		await d1.batch([
			d1
				.prepare(
					`with recursive n(i) as (select 0 union all select i + 1 from n where i < ?)
					insert into auth_events (id, user_id, kind, created_at)
					select 'old-' || ? || '-' || i, ?, 'passkey_refused', ? - i from n`
				)
				.bind(AUTH_EVENT_SWEEP_BATCH + 4, a.id, a.id, old),
			d1
				.prepare(
					`insert into auth_events (id, user_id, kind, created_at) values (?, ?, 'passkey_added', ?)`
				)
				.bind(`new-${a.id}`, a.id, now - AUTH_EVENT_RETENTION_MS + 60_000)
		]);
		expect(await count('select count(*) as n from auth_events where user_id = ?', a.id)).toBe(
			AUTH_EVENT_SWEEP_BATCH + 6
		);
		expect(await sweepAuthEvents(db, now)).toBe(AUTH_EVENT_SWEEP_BATCH);
		expect(await sweepAuthEvents(db, now)).toBeGreaterThanOrEqual(5);
		expect(await events(a.id)).toEqual(['passkey_added']);
	});

	it('drops challenges expired for over an hour when the next one is issued', async () => {
		const now = Date.now();
		const stale = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
		const recent = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
		await d1.batch(
			[
				[stale, now - 2 * 60 * 60 * 1000],
				[recent, now - 30 * 60 * 1000]
			].map(([challenge, expiresAt]) =>
				d1
					.prepare(
						`insert into passkey_challenges (id, challenge, kind, created_at, expires_at) values (?, ?, 'sign_in', ?, ?)`
					)
					.bind(
						`c-${challenge}`,
						challenge,
						Number(expiresAt) - PASSKEY_CHALLENGE_TTL_MS,
						expiresAt
					)
			)
		);
		await issueChallenge(db, 'sign_in', null, now);
		expect(await challengeRow(String(stale))).toBeNull();
		expect(await challengeRow(String(recent))).not.toBeNull();
	});
});
