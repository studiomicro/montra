import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db';
import { fakeEvent } from '../helpers/event';

// The public site's requests never reach D1 (no session cookie on the site host); a stand-in binding suffices.
vi.mock('#lib/server/env', () => ({ getEnv: () => ({ DB: {} }) }));

const { handle } = await import('../../src/hooks.server');
const mulai = await import('../../src/routes/(site)/site/mulai/+server');
const instal = await import('../../src/routes/(app)/pengaturan/instal/+page.server');
const db = {} as Db;
const resolveOk = vi.fn(async () => new Response('ok'));

describe('hooks.server.ts on the public site (FN-32)', () => {
	it('takes the site language from the URL, never the cookie or Accept-Language', async () => {
		const en = fakeEvent({
			url: 'http://site.localhost/en/blog',
			routeId: '/(site)/site/blog',
			db,
			cookies: { lang: 'id' },
			headers: { 'accept-language': 'id-ID' }
		});
		await handle({ event: en.event, resolve: resolveOk });
		expect(en.locals.locale).toBe('en');

		const id = fakeEvent({
			url: 'http://site.localhost/blog',
			routeId: '/(site)/site/blog',
			db,
			cookies: { lang: 'en' },
			headers: { 'accept-language': 'en-US' }
		});
		await handle({ event: id.event, resolve: resolveOk });
		expect(id.locals.locale).toBe('id');
	});

	it('keeps the cookie and Accept-Language rule for the app', async () => {
		const app = fakeEvent({
			url: 'http://localhost/masuk',
			routeId: '/(auth)/masuk',
			db,
			headers: { 'accept-language': 'en-US' }
		});
		await handle({ event: app.event, resolve: resolveOk });
		expect(app.locals.locale).toBe('en');
	});

	it('marks every app-host response noindex and leaves the site host indexable', async () => {
		const app = fakeEvent({ url: 'http://localhost/masuk', routeId: '/(auth)/masuk', db });
		expect(
			(await handle({ event: app.event, resolve: resolveOk })).headers.get('x-robots-tag')
		).toBe('noindex');
		const site = fakeEvent({
			url: 'http://site.localhost/hapus-akun',
			routeId: '/(site)/site/hapus-akun',
			db
		});
		const res = await handle({ event: site.event, resolve: resolveOk });
		expect(res.headers.get('x-robots-tag')).toBeNull();
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});
});

describe('/mulai (site → app)', () => {
	it('sends the visitor to sign-up on the app host paired with this site host', () => {
		try {
			mulai.GET({ url: new URL('http://site.localhost:8868/mulai') } as never);
			expect.unreachable();
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('http://localhost:8868/daftar');
			}
		}
		expect(mulai.prerender).toBe(false);
	});
});

describe('/pengaturan/instal (app) links the public guide', () => {
	it('points at /pasang on the paired site host, in the reader’s language', () => {
		const load = (url: string, locale: 'id' | 'en') =>
			instal.load({ url: new URL(url), locals: { locale } } as never);
		expect(load('http://localhost:8868/pengaturan/instal', 'id')).toEqual({
			guideUrl: 'http://site.localhost:8868/pasang'
		});
		expect(load('http://localhost:8868/pengaturan/instal', 'en')).toEqual({
			guideUrl: 'http://site.localhost:8868/en/pasang'
		});
	});

	it('answers null (shown as "Belum dikonfigurasi") on a host without a paired site', () => {
		expect(
			instal.load({
				url: new URL('https://montra-app-staging.example.workers.dev/pengaturan/instal'),
				locals: { locale: 'id' }
			} as never)
		).toEqual({ guideUrl: null });
	});
});
