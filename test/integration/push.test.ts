import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { createPasswordSession, revokeSession } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { FORM_BODY_MAX_BYTES } from '#lib/server/forms';
import { SUBSCRIPTIONS_MAX } from '#lib/server/push/repo';
import { sendPushNotification } from '#lib/server/push/send';
import { vapidKeys } from '#lib/server/push/vapid';
import { base64urlEncode } from '#lib/shared/base64url';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
vi.mock('$app/env', () => ({ dev: false, building: false }));

const { handle } = await import('../../src/hooks.server');
const page = await import('../../src/routes/(app)/pengaturan/notifikasi/+page.server');
const instal = await import('../../src/routes/(app)/pengaturan/instal/+page.server');
const akun = await import('../../src/routes/(app)/pengaturan/akun/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const ROUTE = '/(app)/pengaturan/notifikasi';

/** A real VAPID key set in env format, made per run (never a committed key). */
async function vapidEnv() {
	const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign'
	])) as CryptoKeyPair;
	return {
		VAPID_PUBLIC_KEY: base64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey)),
		VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', pair.privateKey)).d as string,
		VAPID_SUBJECT: 'mailto:dev@montra.local'
	};
}
let VAPID: Awaited<ReturnType<typeof vapidEnv>>;

/** A browser subscription's keys: a real P-256 point (p256dh) and 16 random octets (auth). */
async function browserKeys() {
	const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits'
	])) as CryptoKeyPair;
	return {
		p256dh: base64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey)),
		auth: base64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
	};
}
let n = 0;
const endpoint = () => `https://fcm.googleapis.com/fcm/send/e2e-${++n}:${crypto.randomUUID()}`;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
	VAPID = await vapidEnv();
});
afterAll(() => dispose());
beforeEach(() => {
	Object.assign(binding, VAPID);
	delete binding.DEV_ROUTES;
});

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

let people = 0;
async function person() {
	const email = `push${++people}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name: 'Uji', createdAt: 0 }, token: r.token, email };
}
type Person = Awaited<ReturnType<typeof person>>;

/** A second session (another device) of the same person. */
async function secondSession(p: Person) {
	const proof = await signInWithPassword(db, p.email, PASSWORD, Date.now());
	if (!proof.ok) throw new Error('sign-in failed');
	const s = await createPasswordSession(db, p.user.id, proof.hash, Date.now());
	return { ...p, token: s!.token };
}

type Act = 'subscribe' | 'unsubscribe' | 'sendTestPush';
const ev = (
	who: Person,
	action: Act,
	opts: { form?: Record<string, string>; headers?: Record<string, string> } = {}
) =>
	fakeEvent({
		url: `http://localhost/pengaturan/notifikasi?/${action}`,
		routeId: ROUTE,
		db,
		user: who.user,
		sessionToken: who.token,
		form: opts.form ?? {},
		headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126', ...opts.headers }
	}).event as never;
const act = (who: Person, action: Act, form?: Record<string, string>) =>
	run(() => (page.actions[action] as (e: never) => unknown)(ev(who, action, { form })));
const load = (who: Person) =>
	run(() =>
		page.load(
			fakeEvent({
				url: 'http://localhost/pengaturan/notifikasi',
				routeId: ROUTE,
				db,
				user: who.user,
				sessionToken: who.token
			}).event as never
		)
	);

interface Row {
	id: string;
	user_id: string;
	session_id: string | null;
	endpoint: string;
	p256dh: string;
	auth: string;
	user_agent: string | null;
	deleted_at: number | null;
}
const rowsFor = async (ep: string) =>
	(await d1.prepare('select * from push_subscriptions where endpoint = ?').bind(ep).all<Row>())
		.results;
const liveCount = async (userId: string) =>
	(await d1
		.prepare(
			'select count(*) as c from push_subscriptions where user_id = ? and deleted_at is null'
		)
		.bind(userId)
		.first<{ c: number }>())!.c;
const sessionIdOf = async (token: string) => {
	const hash = [
		...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
	]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return (await d1
		.prepare('select id from sessions where token_hash = ?')
		.bind(hash)
		.first<{ id: string }>())!.id;
};

async function subscribed(who: Person, ep = endpoint()) {
	const keys = await browserKeys();
	const r = await act(who, 'subscribe', { endpoint: ep, ...keys });
	expect(r).toMatchObject({ kind: 'ok', value: { subscribed: true } });
	return { endpoint: ep, ...keys };
}

describe('push_subscriptions schema (migration 0009)', () => {
	it('is per user and device: no space_id or seq, unique endpoint', async () => {
		const cols = (
			await d1.prepare('select name from pragma_table_info(?)').bind('push_subscriptions').all()
		).results.map((c) => c.name);
		expect(cols).toEqual(
			expect.arrayContaining(['user_id', 'session_id', 'endpoint', 'p256dh', 'auth', 'deleted_at'])
		);
		expect(cols).not.toContain('space_id');
		expect(cols).not.toContain('seq');
	});
});

describe('/pengaturan/notifikasi load', () => {
	it('without VAPID keys: not configured, no public key (criterion 13)', async () => {
		delete binding.VAPID_PRIVATE_KEY;
		const p = await person();
		expect(await load(p)).toMatchObject({
			kind: 'ok',
			value: { configured: false, publicKey: null, endpointHashes: [] }
		});
		expect(await act(p, 'subscribe', { endpoint: endpoint(), ...(await browserKeys()) })).toEqual({
			kind: 'fail',
			status: 503,
			data: { error: 'Notifikasi belum dikonfigurasi di server ini.' }
		});
	});

	it('with keys: the public key only, and hashes (not endpoints) of this user’s live subscriptions', async () => {
		const p = await person();
		const sub = await subscribed(p);
		const r = await load(p);
		expect(r.kind).toBe('ok');
		const value = (r as { value: Record<string, unknown> }).value;
		expect(value).toMatchObject({ configured: true, publicKey: VAPID.VAPID_PUBLIC_KEY });
		expect(JSON.stringify(value)).not.toContain(VAPID.VAPID_PRIVATE_KEY);
		expect(JSON.stringify(value)).not.toContain(sub.endpoint);
		expect(value.endpointHashes).toHaveLength(1);
	});
});

describe('subscribe', () => {
	it('stores one row for locals.user bound to this session (criterion 14)', async () => {
		const p = await person();
		const sub = await subscribed(p);
		const [row] = await rowsFor(sub.endpoint);
		expect(row).toMatchObject({
			user_id: p.user.id,
			session_id: await sessionIdOf(p.token),
			p256dh: sub.p256dh,
			auth: sub.auth,
			deleted_at: null
		});
		expect(row!.user_agent).toContain('Android');
	});

	it('the same endpoint again updates in place, never a duplicate; 10 concurrent posts too (criterion 15)', async () => {
		const p = await person();
		const sub = await subscribed(p);
		const keys = await browserKeys();
		const results = await Promise.all(
			Array.from({ length: 10 }, () => act(p, 'subscribe', { endpoint: sub.endpoint, ...keys }))
		);
		expect(results.every((r) => r.kind === 'ok')).toBe(true);
		const rows = await rowsFor(sub.endpoint);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ p256dh: keys.p256dh, deleted_at: null });
	});

	it('refuses malformed keys, unknown push hosts and non-https endpoints with 400', async () => {
		const p = await person();
		const keys = await browserKeys();
		for (const form of [
			{ endpoint: 'https://evil.example/push', ...keys },
			{ endpoint: 'http://fcm.googleapis.com/fcm/send/x', ...keys },
			{ endpoint: 'https://fcm.googleapis.com.evil.example/x', ...keys },
			{ endpoint: 'https://user:pw@fcm.googleapis.com/x', ...keys },
			{ endpoint: endpoint(), p256dh: keys.auth, auth: keys.auth },
			{ endpoint: endpoint(), p256dh: keys.p256dh, auth: keys.p256dh },
			{ endpoint: endpoint(), p256dh: 'not base64!', auth: keys.auth },
			{ endpoint: '', ...keys }
		])
			expect(await act(p, 'subscribe', form)).toMatchObject({ kind: 'fail', status: 400 });
		expect(await liveCount(p.user.id)).toBe(0);
	});

	it(`keeps at most ${SUBSCRIPTIONS_MAX} live devices per user`, async () => {
		const p = await person();
		for (let i = 0; i < SUBSCRIPTIONS_MAX; i++) await subscribed(p);
		expect(
			await act(p, 'subscribe', { endpoint: endpoint(), ...(await browserKeys()) })
		).toMatchObject({ kind: 'fail', status: 409 });
		expect(await liveCount(p.user.id)).toBe(SUBSCRIPTIONS_MAX);
	});

	it('cannot take over another user’s endpoint while their session is live; can after they sign out', async () => {
		const a = await person();
		const b = await person();
		const sub = await subscribed(a);
		expect(
			await act(b, 'subscribe', { endpoint: sub.endpoint, ...(await browserKeys()) })
		).toMatchObject({ kind: 'fail', status: 409 });
		expect((await rowsFor(sub.endpoint))[0]).toMatchObject({
			user_id: a.user.id,
			deleted_at: null
		});

		// The same browser, now signed in as b after a signed out: the endpoint passes to b.
		await revokeSession(db, a.token, Date.now());
		await subscribed(b, sub.endpoint);
		expect(await rowsFor(sub.endpoint)).toHaveLength(1);
		expect((await rowsFor(sub.endpoint))[0]).toMatchObject({
			user_id: b.user.id,
			deleted_at: null
		});
	});

	it('form bodies are guarded: 415 for text/plain, 400 for oversized (criterion 22)', async () => {
		const p = await person();
		const plain = fakeEvent({
			url: 'http://localhost/pengaturan/notifikasi?/subscribe',
			routeId: ROUTE,
			db,
			user: p.user,
			sessionToken: p.token
		}).event as unknown as { request: Request };
		plain.request = new Request(plain.request.url, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'endpoint=x'
		});
		expect(
			await run(() => (page.actions.subscribe as (e: never) => unknown)(plain as never))
		).toEqual({
			kind: 'error',
			status: 415
		});
		for (const action of ['subscribe', 'unsubscribe'] as const)
			expect(await act(p, action, { endpoint: 'x'.repeat(FORM_BODY_MAX_BYTES + 1) })).toEqual({
				kind: 'error',
				status: 400
			});
	});
});

describe('unsubscribe', () => {
	it('tombstones this user’s row, blanking its keys (criterion 16)', async () => {
		const p = await person();
		const sub = await subscribed(p);
		expect(await act(p, 'unsubscribe', { endpoint: sub.endpoint })).toEqual({
			kind: 'ok',
			value: { unsubscribed: true }
		});
		const [row] = await rowsFor(sub.endpoint);
		expect(row!.deleted_at).not.toBeNull();
		expect(row).toMatchObject({ p256dh: '', auth: '', user_agent: null });
		expect(await liveCount(p.user.id)).toBe(0);
	});

	it('another user’s endpoint matches nothing and gets the same answer as a missing one (criterion 21)', async () => {
		const a = await person();
		const b = await person();
		const sub = await subscribed(a);
		const foreign = await act(b, 'unsubscribe', { endpoint: sub.endpoint });
		const missing = await act(b, 'unsubscribe', { endpoint: endpoint() });
		expect(foreign).toEqual(missing);
		expect((await rowsFor(sub.endpoint))[0]).toMatchObject({
			user_id: a.user.id,
			deleted_at: null
		});
	});
});

describe('sign-out and account deletion', () => {
	it('sign-out tombstones the subscriptions of that session only', async () => {
		const phone = await person();
		const laptop = await secondSession(phone);
		const onPhone = await subscribed(phone);
		const onLaptop = await subscribed(laptop);
		expect(await liveCount(phone.user.id)).toBe(2);

		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/signOut',
			routeId: '/(app)/pengaturan/akun',
			db,
			user: phone.user,
			sessionToken: phone.token,
			form: {}
		});
		await run(() => (akun.actions.signOut as (e: never) => unknown)(event as never));
		expect((await rowsFor(onPhone.endpoint))[0]!.deleted_at).not.toBeNull();
		expect((await rowsFor(onLaptop.endpoint))[0]!.deleted_at).toBeNull();
	});

	it('the sign-out response tells the browser to clear caches and storage (service worker, push)', async () => {
		const p = await person();
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/signOut',
			routeId: '/(app)/pengaturan/akun',
			db,
			sessionToken: p.token,
			cookies: { financer_session: p.token },
			headers: { origin: 'http://localhost' },
			form: {}
		});
		const res = await handle({
			event,
			resolve: async (e) => {
				await run(() => (akun.actions.signOut as (x: never) => unknown)(e as never));
				return new Response(null, { status: 303, headers: { location: '/masuk' } });
			}
		});
		expect(res.headers.get('clear-site-data')).toBe('"cache", "storage"');

		// An ordinary signed-in page carries no such header.
		const other = await person();
		const plain = fakeEvent({
			url: 'http://localhost/pengaturan',
			routeId: '/(app)/pengaturan',
			db,
			cookies: { financer_session: other.token }
		});
		const ok = await handle({ event: plain.event, resolve: async () => new Response('ok') });
		expect(ok.headers.get('clear-site-data')).toBeNull();
	});

	it('account deletion removes every subscription row of the user, tombstones included', async () => {
		const p = await person();
		await subscribed(p);
		const gone = await subscribed(p);
		await act(p, 'unsubscribe', { endpoint: gone.endpoint });
		const proof = await signInWithPassword(db, p.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, p.user.id, proof.hash)).toBe(true);
		const left = await d1
			.prepare('select count(*) as c from push_subscriptions where user_id = ?')
			.bind(p.user.id)
			.first<{ c: number }>();
		expect(left!.c).toBe(0);
	});
});

describe('sending (no real push service: fetch is stubbed for push hosts only)', () => {
	const realFetch = globalThis.fetch;
	let answer = 201;
	const sent: { url: string; init: RequestInit }[] = [];
	beforeEach(() => {
		sent.length = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			if (!url.startsWith('https://fcm.googleapis.com/')) return realFetch(input, init);
			sent.push({ url, init: init ?? {} });
			return new Response(null, { status: answer });
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it('sendTestPush answers 404 unless dev routes are on (criterion 18)', async () => {
		const p = await person();
		await subscribed(p);
		expect(await act(p, 'sendTestPush')).toEqual({ kind: 'error', status: 404 });
		expect(sent).toHaveLength(0);
	});

	it('sends an encrypted, VAPID-signed message to each of the user’s own devices only', async () => {
		binding.DEV_ROUTES = '1';
		answer = 201;
		const p = await person();
		const other = await person();
		const mine = [await subscribed(p), await subscribed(p)];
		await subscribed(other);
		expect(await act(p, 'sendTestPush')).toEqual({
			kind: 'ok',
			value: { testResults: ['sent', 'sent'] }
		});
		expect(sent.map((s) => s.url).sort()).toEqual(mine.map((m) => m.endpoint).sort());
		const headers = sent[0]!.init.headers as Record<string, string>;
		expect(headers['content-encoding']).toBe('aes128gcm');
		expect(headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
		const body = sent[0]!.init.body as Uint8Array;
		// RFC 8188 header: 16-octet salt, record size 4096, 65-octet sender key; never the plaintext.
		expect(body.slice(16, 21)).toEqual(new Uint8Array([0, 0, 0x10, 0, 65]));
		expect(new TextDecoder().decode(body)).not.toContain('Notifikasi');
	});

	it('a 410 tombstones the subscription before returning expired; a 500 keeps it (criterion 19)', async () => {
		binding.DEV_ROUTES = '1';
		const p = await person();
		const sub = await subscribed(p);
		answer = 500;
		expect(await act(p, 'sendTestPush')).toEqual({
			kind: 'ok',
			value: { testResults: ['failed'] }
		});
		expect((await rowsFor(sub.endpoint))[0]!.deleted_at).toBeNull();

		answer = 410;
		expect(await act(p, 'sendTestPush')).toEqual({
			kind: 'ok',
			value: { testResults: ['expired'] }
		});
		expect((await rowsFor(sub.endpoint))[0]!.deleted_at).not.toBeNull();
		// The dead endpoint is not tried again.
		sent.length = 0;
		expect(await act(p, 'sendTestPush')).toMatchObject({ kind: 'fail', status: 400 });
		expect(sent).toHaveLength(0);
	});

	it('sendPushNotification maps 404 to expired too, and refuses a non-push host before any request', async () => {
		const p = await person();
		const sub = await subscribed(p);
		const keys = vapidKeys(VAPID)!;
		answer = 404;
		const [row] = await rowsFor(sub.endpoint);
		expect(
			await sendPushNotification(
				db,
				{ ...row!, userId: p.user.id },
				{ title: 'T', body: 'B' },
				keys
			)
		).toBe('expired');
		expect((await rowsFor(sub.endpoint))[0]!.deleted_at).not.toBeNull();
		await expect(
			sendPushNotification(
				db,
				{
					userId: p.user.id,
					endpoint: 'https://evil.example/x',
					p256dh: sub.p256dh,
					auth: sub.auth
				},
				{ title: 'T', body: 'B' },
				keys
			)
		).rejects.toThrow(/push service/);
	});
	it('never follows a redirect: a 3xx from the push host is a failure, nothing goes elsewhere (L3)', async () => {
		binding.DEV_ROUTES = '1';
		const p = await person();
		const sub = await subscribed(p);
		answer = 302;
		expect(await act(p, 'sendTestPush')).toEqual({
			kind: 'ok',
			value: { testResults: ['failed'] }
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]!.init.redirect).toBe('manual');
		expect((await rowsFor(sub.endpoint))[0]!.deleted_at).toBeNull();
	});
});

describe('sessions that ended without sign-out (L1)', () => {
	for (const [label, end] of [
		['expired', 'update sessions set expires_at = ? where id = ?'],
		['revoked', 'update sessions set revoked_at = ? where id = ?']
	] as const)
		it(`a subscription whose session is ${label} is neither listed nor sent to, and is pruned`, async () => {
			binding.DEV_ROUTES = '1';
			const p = await person();
			const sub = await subscribed(p);
			await d1
				.prepare(end)
				.bind(Date.now() - 1, await sessionIdOf(p.token))
				.run();
			// A fresh session of the same person (a new sign-in) views the page.
			const now = await secondSession(p);
			expect(await load(now)).toMatchObject({ kind: 'ok', value: { endpointHashes: [] } });
			expect(await act(now, 'sendTestPush')).toMatchObject({ kind: 'fail', status: 400 });
			const [row] = await rowsFor(sub.endpoint);
			expect(row).toMatchObject({ p256dh: '', auth: '' });
			expect(row!.deleted_at).not.toBeNull();
		});
});

describe('endpoint normalisation (L2)', () => {
	it('case, :443 and a trailing dot name the same row; path and query stay exact', async () => {
		const a = await person();
		const b = await person();
		const id = `Norm-${crypto.randomUUID()}?x=AbC`;
		const canonical = `https://fcm.googleapis.com/fcm/send/${id}`;
		await subscribed(a, canonical);
		for (const variant of [
			`https://FCM.googleapis.com/fcm/send/${id}`,
			`https://fcm.googleapis.com:443/fcm/send/${id}`,
			`HTTPS://fcm.googleapis.com./fcm/send/${id}`
		])
			expect(
				await act(b, 'subscribe', { endpoint: variant, ...(await browserKeys()) })
			).toMatchObject({ kind: 'fail', status: 409 });
		const rows = await rowsFor(canonical);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ user_id: a.user.id, deleted_at: null });
		// The owner's own variant updates the same row; a different path case is a different endpoint.
		await subscribed(a, `https://FCM.GOOGLEAPIS.COM:443/fcm/send/${id}`);
		expect(await rowsFor(canonical)).toHaveLength(1);
		expect(await rowsFor(canonical.replace('Norm-', 'norm-'))).toHaveLength(0);
		// Unsubscribe compares the normalised form too.
		await act(a, 'unsubscribe', { endpoint: `https://fcm.googleapis.com.:443/fcm/send/${id}` });
		expect((await rowsFor(canonical))[0]!.deleted_at).not.toBeNull();
	});
});

describe('/pengaturan/instal', () => {
	it('works signed out: the gate lets it through and it links the public guide (FN-32)', async () => {
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/instal',
			routeId: '/(app)/pengaturan/instal',
			db
		});
		const res = await handle({ event, resolve: async () => new Response('ok') });
		expect(res.status).toBe(200);
		expect(await instal.load(event as never)).toEqual({
			guideUrl: 'http://site.localhost/pasang'
		});
	});
});
