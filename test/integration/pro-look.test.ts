import { readFileSync } from 'node:fs';
import { isActionFailure } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { DAY_MS } from '#lib/shared/billing/plans';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// FN-46: the Pro look follows the plan stored in D1 (user_plan_state, read through billing/gate.ts planOf),
// never the `theme` cookie or a posted value. Hooks, the Tampilan action and the manifest route, end to end on
// local D1.
const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const daftar = await import('../../src/routes/(auth)/daftar/+page.server');
const tampilan = await import('../../src/routes/(app)/pengaturan/tampilan/+page.server');
const manifestRoute = await import('../../src/routes/manifest.webmanifest/+server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

const TEMPLATE = readFileSync('src/app.html', 'utf8').replaceAll('%sveltekit.assets%', '');
let ip = 0;

/** A fresh account through the real sign-up action; returns its session token and id. */
async function account(email: string) {
	const { event, written } = fakeEvent({
		url: 'http://localhost/daftar',
		routeId: '/(auth)/daftar',
		db,
		headers: { 'cf-connecting-ip': `198.51.100.${++ip}` },
		form: { name: 'Sari', email, password: 'kopi-pagi-2026', adult: 'on', consent: 'on' }
	});
	try {
		await (daftar.actions.default as (e: never) => Promise<unknown>)(event as never);
	} catch {
		// The redirect to / after a successful sign-up.
	}
	const token = written.get('financer_session')?.value;
	const row = await d1
		.prepare('select id from users where email = ?')
		.bind(email)
		.first<{ id: string }>();
	if (!token || !row) throw new Error('sign-up failed');
	return { token, userId: row.id };
}

/** Puts the account on `plan` until `end` (test setup only: real changes come from a payment or a voucher). */
async function setPlan(userId: string, plan: 'gratis' | 'pro' | 'agen', end: number | null) {
	await d1
		.prepare(
			"update user_plan_state set plan = ?, billing_period = case when ? = 'gratis' then null else 'monthly' end, current_period_end = ?, updated_at = ? where user_id = ?"
		)
		.bind(plan, plan, end, Date.now(), userId)
		.run();
}

/** One page request through hooks.server.ts: the HTML it would send and the locals it resolved. */
async function page(cookies: Record<string, string>, routeId = '/(app)', path = '/') {
	const { event, locals } = fakeEvent({ url: `http://localhost${path}`, routeId, db, cookies });
	let body = '';
	await handle({
		event,
		resolve: async (_event, opts) => {
			body = String(await opts?.transformPageChunk?.({ html: TEMPLATE, done: true }));
			return new Response(body, { headers: { 'content-type': 'text/html' } });
		}
	});
	return {
		locals,
		theme: /<html[^>]*data-theme="([^"]*)"/.exec(body)?.[1],
		touchIcon: /<link rel="apple-touch-icon" href="([^"]*)"/.exec(body)?.[1],
		themeColors: [...body.matchAll(/name="theme-color"[^>]*content="([^"]*)"/g)].map((m) => m[1])
	};
}

describe('hooks.server.ts: the theme cookie is a wish, the stored plan decides (AC 8, 9, 14)', () => {
	it('a forged theme=gold from a Gratis session renders as system, with today’s touch icon', async () => {
		const { token } = await account('gratis-emas@contoh.id');
		const res = await page({ financer_session: token, theme: 'gold' });
		expect(res.theme).toBe('system');
		expect(res.locals.plan).toBe('gratis');
		expect(res.touchIcon).toBe('/icons/apple-touch-icon.png');
		expect(res.themeColors).toEqual(['#ffffff', '#111112']);
	});

	it.each([
		['pro', 'gold', ['#fffdf8', '#14120d']],
		['agen', 'emerald', ['#fbfefc', '#0d1311']]
	] as const)('a %s account keeps %s, with the crowned touch icon', async (plan, theme, colors) => {
		const { token, userId } = await account(`${plan}-${theme}@contoh.id`);
		await setPlan(userId, plan, Date.now() + 30 * DAY_MS);
		const res = await page({ financer_session: token, theme });
		expect(res.theme).toBe(theme);
		expect(res.locals.plan).toBe(plan);
		expect(res.touchIcon).toBe('/icons/apple-touch-icon-pro.png');
		expect(res.themeColors).toEqual(colors);
	});

	it('the next page load after a paid period ends drops the Pro theme and the Pro icon (no sweep)', async () => {
		const { token, userId } = await account('lewat@contoh.id');
		await setPlan(userId, 'pro', Date.now() + DAY_MS);
		expect((await page({ financer_session: token, theme: 'gold' })).theme).toBe('gold');
		await setPlan(userId, 'pro', Date.now() - 1);
		const after = await page({ financer_session: token, theme: 'gold' });
		expect(after.theme).toBe('system');
		expect(after.locals.plan).toBe('gratis');
		expect(after.touchIcon).toBe('/icons/apple-touch-icon.png');
	});

	it('signed out, a Pro theme cookie shows system and the Gratis icon (no account to be Pro)', async () => {
		const res = await page({ theme: 'emerald' }, '/(auth)/masuk', '/masuk');
		expect(res.theme).toBe('system');
		expect(res.locals.plan).toBe('gratis');
		expect(res.touchIcon).toBe('/icons/apple-touch-icon.png');
	});

	it('the free themes are never touched, whatever the plan', async () => {
		const { token } = await account('mono@contoh.id');
		expect((await page({ financer_session: token, theme: 'mono' })).theme).toBe('mono');
	});
});

type Action = (event: never) => Promise<unknown>;
async function postTheme(token: string, theme: string) {
	const { event, written } = fakeEvent({
		url: 'http://localhost/pengaturan/tampilan',
		routeId: '/(app)/pengaturan/tampilan',
		db,
		cookies: { financer_session: token },
		headers: { origin: 'http://localhost' },
		form: { theme }
	});
	// Through the hook first, as a real request: it resolves the session (and the plan) into locals.
	let result: unknown;
	await handle({
		event,
		resolve: async (e) => {
			result = await (tampilan.actions.theme as Action)(e as never);
			return new Response('ok');
		}
	});
	return { result, cookie: written.get('theme') };
}

describe('Tampilan action: a Pro theme is refused, not merely hidden (AC 6, 7)', () => {
	it.each(['gold', 'emerald'])(
		'Gratis posting %s: 403, the cookie is not written',
		async (theme) => {
			const { token } = await account(`tolak-${theme}@contoh.id`);
			const { result, cookie } = await postTheme(token, theme);
			expect(isActionFailure(result)).toBe(true);
			if (!isActionFailure(result)) return;
			expect(result.status).toBe(403);
			expect(result.data).toEqual({ error: 'Perlu paket Pro atau Agen' });
			expect(cookie).toBeUndefined();
		}
	);

	it('a lapsed Pro account is refused the same way', async () => {
		const { token, userId } = await account('tolak-lewat@contoh.id');
		await setPlan(userId, 'pro', Date.now() - DAY_MS);
		const { result, cookie } = await postTheme(token, 'gold');
		expect(isActionFailure(result) && result.status).toBe(403);
		expect(cookie).toBeUndefined();
	});

	it.each([
		['pro', 'gold'],
		['agen', 'emerald']
	] as const)('%s saves %s as the cookie', async (plan, theme) => {
		const { token, userId } = await account(`simpan-${plan}@contoh.id`);
		await setPlan(userId, plan, Date.now() + DAY_MS);
		const { result, cookie } = await postTheme(token, theme);
		expect(result).toEqual({ saved: theme });
		expect(cookie?.value).toBe(theme);
	});

	it('Gratis keeps every free theme', async () => {
		const { token } = await account('bebas@contoh.id');
		const { result, cookie } = await postTheme(token, 'mono');
		expect(result).toEqual({ saved: 'mono' });
		expect(cookie?.value).toBe('mono');
	});
});

describe('/manifest.webmanifest follows the session’s plan (AC 13)', () => {
	const file = readFileSync('src/lib/server/pwa/manifest.webmanifest', 'utf8');
	async function get(cookies: Record<string, string>) {
		const { event } = fakeEvent({
			url: 'http://localhost/manifest.webmanifest',
			routeId: '/manifest.webmanifest',
			db,
			cookies
		});
		return handle({
			event,
			resolve: async (e) => manifestRoute.GET(e as never)
		});
	}

	it('signed out and Gratis: byte-identical to the file, as a manifest, never cached by others', async () => {
		const { token } = await account('manifest-gratis@contoh.id');
		for (const res of [await get({}), await get({ financer_session: token })]) {
			expect(await res.text()).toBe(file);
			expect(res.headers.get('content-type')).toBe('application/manifest+json');
			expect(res.headers.get('cache-control')).toBe('private, no-store');
			expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		}
	});

	it.each(['pro', 'agen'] as const)('%s: the crowned icons, private and no-store', async (plan) => {
		const { token, userId } = await account(`manifest-${plan}@contoh.id`);
		await setPlan(userId, plan, Date.now() + DAY_MS);
		const res = await get({ financer_session: token });
		const body = (await res.json()) as { icons: { src: string }[] };
		expect(body.icons.map((i) => i.src).filter((src) => src.endsWith('-pro.png'))).toEqual([
			'/icons/icon-192-pro.png',
			'/icons/icon-512-pro.png'
		]);
		expect(res.headers.get('cache-control')).toBe('private, no-store');
		// Lapsed: back to the file on the next request.
		await setPlan(userId, plan, Date.now() - 1);
		expect(await (await get({ financer_session: token })).text()).toBe(file);
	});
});
