import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveSession } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// Kit 3: bindings come from getEnv() (cloudflare:workers), which Node cannot load; tests hand it the local D1.
const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const masuk = await import('../../src/routes/(auth)/masuk/+page.server');
const daftar = await import('../../src/routes/(auth)/daftar/+page.server');
const akun = await import('../../src/routes/(app)/pengaturan/akun/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

type Action = (event: never) => unknown;
/** One named form action of a route module. */
const action = (actions: unknown, name: string) =>
	(actions as Record<string, Action>)[name] as Action;

/** Runs a load/action and returns what it threw or returned, in one shape. */
async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail' as const,
				status: value.status,
				data: value.data as unknown as Record<string, unknown>
			};
		return { kind: 'ok' as const, value };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
		throw e;
	}
}

let ip = 0;
/** A distinct client per call, so the per-client throttle does not mix tests. */
const client = () => ({ 'cf-connecting-ip': `198.51.100.${++ip}` });

async function signUpVia(email: string) {
	const { event, written } = fakeEvent({
		url: 'http://localhost/daftar',
		routeId: '/(auth)/daftar',
		db,
		headers: client(),
		form: { name: 'Budi', email, password: PASSWORD, adult: 'on', consent: 'on' }
	});
	const result = await run(() => action(daftar.actions, 'default')(event as never));
	return { result, token: written.get('financer_session')?.value };
}

const resolveOk = vi.fn(async () => new Response('ok'));

describe('hooks.server.ts route protection', () => {
	it('redirects a signed-out GET of an (app) page to /masuk?next=…', async () => {
		const { event } = fakeEvent({
			url: 'http://localhost/riwayat?bulan=2026-10',
			routeId: '/(app)/riwayat',
			db
		});
		const res = await handle({ event, resolve: resolveOk });
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/masuk?next=%2Friwayat%3Fbulan%3D2026-10');
		// Early answers carry the same security headers as resolved ones.
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('answers a signed-out data request with SvelteKit’s JSON redirect', async () => {
		const { event } = fakeEvent({
			url: 'http://localhost/laporan',
			routeId: '/(app)/laporan',
			db,
			isDataRequest: true
		});
		const res = await handle({ event, resolve: resolveOk });
		expect(await res.json()).toEqual({ type: 'redirect', location: '/masuk?next=%2Flaporan' });
	});

	it('answers a signed-out POST to an (app) action with 401, never a pass-through', async () => {
		resolveOk.mockClear();
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/signOut',
			routeId: '/(app)/pengaturan/akun',
			db,
			// A same-origin browser POST: a cross-site one is refused before the gate (lib/server/csrf.ts).
			headers: { origin: 'http://localhost' },
			form: {}
		});
		const res = await handle({ event, resolve: resolveOk });
		expect(res.status).toBe(401);
		expect(resolveOk).not.toHaveBeenCalled();
	});

	it.each([
		['/masuk', '/(auth)/masuk'],
		['/daftar', '/(auth)/daftar'],
		['/akun-dihapus', '/(auth)/akun-dihapus'],
		['/api/v1/health', '/api/v1/health'],
		['/hapus-akun', '/(site)/site/hapus-akun']
	])('serves %s without a session', async (path, routeId) => {
		const { event } = fakeEvent({ url: `http://localhost${path}`, routeId, db });
		const res = await handle({ event, resolve: resolveOk });
		expect(res.status).toBe(200);
	});

	it('signs in through the cookie, survives a reload, and clears a dead cookie', async () => {
		const { token } = await signUpVia('kuki@contoh.id');
		expect(token).toBeTruthy();
		const live = fakeEvent({
			url: 'http://localhost/',
			routeId: '/(app)',
			db,
			cookies: { financer_session: token! }
		});
		const ok = await handle({ event: live.event, resolve: resolveOk });
		expect(ok.status).toBe(200);
		expect(live.locals.user?.email).toBe('kuki@contoh.id');
		expect(ok.headers.get('cache-control')).toBe('private, no-store');

		const dead = fakeEvent({
			url: 'http://localhost/',
			routeId: '/(app)',
			db,
			cookies: { financer_session: 'tidak-berlaku' }
		});
		const res = await handle({ event: dead.event, resolve: resolveOk });
		expect(res.status).toBe(303);
		expect(res.headers.get('set-cookie')).toMatch(/^financer_session=; /);
	});

	it('sends a plain-http request to a deployed host to https first', async () => {
		const { event } = fakeEvent({
			url: 'http://montra.example/riwayat',
			routeId: '/(app)/riwayat',
			db
		});
		const res = await handle({ event, resolve: resolveOk });
		expect(res.status).toBe(308);
		expect(res.headers.get('location')).toBe('https://montra.example/riwayat');
	});
});

describe('/daftar', () => {
	it('signs up, sets an HttpOnly SameSite=Lax cookie and redirects to /', async () => {
		const { event, written } = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			headers: client(),
			form: {
				name: 'Budi',
				email: 'baru@contoh.id',
				password: PASSWORD,
				adult: 'on',
				consent: 'on'
			}
		});
		expect(await run(() => action(daftar.actions, 'default')(event as never))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/'
		});
		const cookie = written.get('financer_session');
		expect(cookie?.options).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: false
		});
	});

	it('refuses without the 18+ box, writes nothing and never echoes the password', async () => {
		const before = await d1.prepare('select count(*) as n from users').first<{ n: number }>();
		const { event } = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			headers: client(),
			form: { name: 'Budi', email: 'anak@contoh.id', password: PASSWORD, consent: 'on' }
		});
		const r = await run(() => action(daftar.actions, 'default')(event as never));
		expect(r.kind).toBe('fail');
		if (r.kind !== 'fail') return;
		expect(r.status).toBe(400);
		expect(r.data.errors).toEqual({ adult: 'Centang konfirmasi usia untuk melanjutkan.' });
		expect(JSON.stringify(r.data)).not.toContain(PASSWORD);
		const after = await d1.prepare('select count(*) as n from users').first<{ n: number }>();
		expect(after?.n).toBe(before?.n);
	});

	it('redirects a signed-in visitor to /', async () => {
		const { event } = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			user: { id: 'u', email: 'x@y.id', name: 'X', createdAt: 0 }
		});
		expect(await run(() => daftar.load(event as never))).toMatchObject({
			kind: 'redirect',
			location: '/'
		});
	});

	it('answers 415 for a JSON body and 400 for an oversized one, never 500', async () => {
		const json = fakeEvent({
			url: 'http://localhost/daftar',
			method: 'POST',
			routeId: '/(auth)/daftar',
			db,
			headers: { 'content-type': 'application/json' }
		});
		expect(await run(() => action(daftar.actions, 'default')(json.event as never))).toEqual({
			kind: 'error',
			status: 415
		});
		const big = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			form: { name: 'x'.repeat(20_000) }
		});
		expect(await run(() => action(daftar.actions, 'default')(big.event as never))).toEqual({
			kind: 'error',
			status: 400
		});
	});
});

describe('/masuk', () => {
	const attempt = async (email: string, password: string, next?: string) => {
		const { event, written } = fakeEvent({
			url: `http://localhost/masuk${next ? `?next=${encodeURIComponent(next)}` : ''}`,
			routeId: '/(auth)/masuk',
			db,
			headers: client(),
			form: { email, password }
		});
		return { result: await run(() => action(masuk.actions, 'password')(event as never)), written };
	};

	it('signs in and redirects to a safe next, never off-site', async () => {
		await signUpVia('masuk@contoh.id');
		const ok = await attempt('masuk@contoh.id', PASSWORD, '/riwayat');
		expect(ok.result).toEqual({ kind: 'redirect', status: 303, location: '/riwayat' });
		expect(ok.written.get('financer_session')?.options).toMatchObject({ httpOnly: true });
		const evil = await attempt('masuk@contoh.id', PASSWORD, '//evil.test');
		expect(evil.result).toEqual({ kind: 'redirect', status: 303, location: '/' });
	});

	it('revokes the session the browser already held when it signs in again (red team L7)', async () => {
		const { token: old } = await signUpVia('ulang-masuk@contoh.id');
		const user = await d1
			.prepare('select id, email, name, created_at as createdAt from users where email = ?')
			.bind('ulang-masuk@contoh.id')
			.first<{ id: string; email: string; name: string; createdAt: number }>();
		const { event, written } = fakeEvent({
			url: 'http://localhost/masuk',
			routeId: '/(auth)/masuk',
			db,
			headers: client(),
			user: user!,
			sessionToken: old!,
			form: { email: 'ulang-masuk@contoh.id', password: PASSWORD }
		});
		expect(await run(() => action(masuk.actions, 'password')(event as never))).toMatchObject({
			kind: 'redirect'
		});
		const fresh = written.get('financer_session')?.value;
		expect(fresh).toBeTruthy();
		expect(fresh).not.toBe(old);
		expect(await resolveSession(db, old!, Date.now())).toBeNull();
		expect((await resolveSession(db, fresh!, Date.now()))?.id).toBe(user!.id);
	});

	it('a sign-up posted from a signed-in browser also revokes the session it replaces (L7)', async () => {
		const { token: old } = await signUpVia('pertama@contoh.id');
		const { event, written } = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			headers: client(),
			sessionToken: old!,
			form: {
				name: 'Kedua',
				email: 'kedua@contoh.id',
				password: PASSWORD,
				adult: 'on',
				consent: 'on'
			}
		});
		await run(() => action(daftar.actions, 'default')(event as never));
		expect(written.get('financer_session')?.value).toBeTruthy();
		expect(await resolveSession(db, old!, Date.now())).toBeNull();
	});

	it('gives wrong password, unknown e-mail and locked account the same answer (no oracle)', async () => {
		await signUpVia('oracle@contoh.id');
		const wrong = await attempt('oracle@contoh.id', 'bukan-ini-123');
		const unknown = await attempt('tidak-ada@contoh.id', 'bukan-ini-123');
		for (let i = 0; i < 5; i++) await attempt('oracle@contoh.id', `salah-${i}-xxx`);
		const locked = await attempt('oracle@contoh.id', PASSWORD);
		// Same status and body shape; only the echoed e-mail (the visitor's own input) differs.
		const shape = (r: Awaited<ReturnType<typeof attempt>>) =>
			r.result.kind === 'fail'
				? { ...r.result, data: { ...r.result.data, values: undefined } }
				: r.result;
		expect(shape(wrong)).toEqual(shape(unknown));
		expect(shape(locked)).toEqual(shape(unknown));
		expect(shape(unknown)).toMatchObject({ kind: 'fail', status: 400 });
		expect(locked.written.size).toBe(0);
	});

	it('refuses the 21st attempt from one client before deriving any key', async () => {
		const headers = { 'cf-connecting-ip': '203.0.113.200' };
		let last;
		for (let i = 0; i < 21; i++) {
			const { event } = fakeEvent({
				url: 'http://localhost/masuk',
				routeId: '/(auth)/masuk',
				db,
				headers,
				form: { email: `spray${i}@contoh.id`, password: 'apa-saja-123' }
			});
			last = await run(() => action(masuk.actions, 'password')(event as never));
		}
		expect(last).toMatchObject({ kind: 'fail', status: 429 });
	});
});

describe('/pengaturan/akun', () => {
	async function signedIn(email: string) {
		const { token } = await signUpVia(email);
		const user = await d1
			.prepare('select id, email, name, created_at as createdAt from users where email = ?')
			.bind(email)
			.first<{ id: string; email: string; name: string; createdAt: number }>();
		return { token: token!, user: user! };
	}

	it('shows only the signed-in user’s own account', async () => {
		const { token, user } = await signedIn('lihat-akun@contoh.id');
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/akun',
			routeId: '/(app)/pengaturan/akun',
			db,
			user,
			sessionToken: token
		});
		const r = await run(() => akun.load(event as never));
		expect(r).toMatchObject({
			kind: 'ok',
			value: { account: { email: 'lihat-akun@contoh.id', name: 'Budi' } }
		});
	});

	it('signOut revokes this session only and redirects to /masuk', async () => {
		const { token, user } = await signedIn('keluar@contoh.id');
		const other = await (async () => {
			const { event, written } = fakeEvent({
				url: 'http://localhost/masuk',
				routeId: '/(auth)/masuk',
				db,
				headers: client(),
				form: { email: 'keluar@contoh.id', password: PASSWORD }
			});
			await run(() => action(masuk.actions, 'password')(event as never));
			return written.get('financer_session')!.value;
		})();
		const { event, written } = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/signOut',
			routeId: '/(app)/pengaturan/akun',
			db,
			user,
			sessionToken: token,
			form: {}
		});
		expect(await run(() => action(akun.actions, 'signOut')(event as never))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/masuk'
		});
		expect(written.get('financer_session')?.options).toMatchObject({ maxAge: 0 });
		const revoked = await d1
			.prepare('select revoked_at from sessions where user_id = ? order by created_at')
			.bind(user.id)
			.all<{ revoked_at: number | null }>();
		expect(revoked.results.filter((s) => s.revoked_at !== null)).toHaveLength(1);
		expect(other).toBeTruthy();
	});

	it('deleteAccount with a wrong password changes nothing and answers like a wrong sign-in', async () => {
		const { token, user } = await signedIn('jangan-hapus@contoh.id');
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/deleteAccount',
			routeId: '/(app)/pengaturan/akun',
			db,
			user,
			sessionToken: token,
			form: { password: 'bukan-ini-123', confirm: 'on' }
		});
		const r = await run(() => action(akun.actions, 'deleteAccount')(event as never));
		expect(r).toEqual({
			kind: 'fail',
			status: 400,
			data: { deleteError: 'E-mail atau kata sandi salah.' }
		});
		const still = await d1
			.prepare('select count(*) as n from users where id = ?')
			.bind(user.id)
			.first<{ n: number }>();
		expect(still?.n).toBe(1);
	});

	it('deleteAccount with the right password deletes and redirects to the public confirmation', async () => {
		const { token, user } = await signedIn('hapus-saya@contoh.id');
		const { event, written } = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/deleteAccount',
			routeId: '/(app)/pengaturan/akun',
			db,
			user,
			sessionToken: token,
			form: { password: PASSWORD, confirm: 'on' }
		});
		expect(await run(() => action(akun.actions, 'deleteAccount')(event as never))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/akun-dihapus'
		});
		expect(written.get('financer_session')?.options).toMatchObject({ maxAge: 0 });
		const gone = await d1
			.prepare('select count(*) as n from users where id = ?')
			.bind(user.id)
			.first<{ n: number }>();
		expect(gone?.n).toBe(0);
	});
});
