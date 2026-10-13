import { describe, expect, it } from 'vitest';
import {
	appOriginForSite,
	canonicalSiteOrigin,
	isLocalSiteHost,
	isSiteHost,
	prerenderRoute,
	routeFor,
	siteOriginForApp
} from '#lib/shared/hosts';

const u = (s: string) => new URL(s);

describe('isSiteHost', () => {
	it('matches site.localhost case-insensitively, ignoring port and a trailing dot', () => {
		expect(isSiteHost(u('http://SITE.localhost:8787/').hostname)).toBe(true);
		expect(isSiteHost('site.localhost.')).toBe(true);
	});
	it('does not match the app host or look-alikes', () => {
		expect(isSiteHost('localhost')).toBe(false);
		expect(isSiteHost('evil-site.localhost')).toBe(false);
		expect(isSiteHost('site.localhost.evil.com')).toBe(false);
	});
});

describe('routeFor', () => {
	it('maps site host paths into /site', () => {
		expect(routeFor(u('http://site.localhost:8787/'))).toBe('/site');
		expect(routeFor(u('http://site.localhost:8787/privasi'))).toBe('/site/privasi');
		expect(routeFor(u('http://site.localhost:8787/blog/a-b'))).toBe('/site/blog/a-b');
	});
	it('leaves app paths alone', () => {
		expect(routeFor(u('http://localhost:8787/'))).toBe('/');
		expect(routeFor(u('http://localhost:8787/riwayat'))).toBe('/riwayat');
	});
	it('hides the site tree on the app host', () => {
		expect(routeFor(u('http://localhost:8787/site'))).toBe('/__not_found');
		expect(routeFor(u('http://localhost:8787/site/privasi'))).toBe('/__not_found');
		expect(routeFor(u('http://localhost:8787/SITE/privasi'))).toBe('/__not_found');
	});
	it('hides encoded, double-slash and malformed variants of the site tree', () => {
		for (const p of [
			'/%73ite/privasi',
			'/site%2Fprivasi',
			'/%53ITE',
			'//site/privasi',
			'/%E0%A4%A'
		]) {
			expect(routeFor(u(`http://localhost:8787${p}`))).toBe('/__not_found');
		}
	});
	it('keeps the original path for normal encoded app paths', () => {
		expect(routeFor(u('http://localhost:8787/riwayat%20x'))).toBe('/riwayat%20x');
	});
	it('does not hide app paths that merely start with "site"', () => {
		expect(routeFor(u('http://localhost:8787/sitemap.xml'))).toBe('/sitemap.xml');
	});
	it('leaves SvelteKit internals alone on the site host', () => {
		expect(routeFor(u('http://site.localhost:8787/_app/version.json'))).toBe('/_app/version.json');
		expect(routeFor(u('http://site.localhost:8787/api/v1/health'))).toBe('/api/v1/health');
	});
});

describe('appOriginForSite', () => {
	it('drops the site. prefix locally and keeps the port', () => {
		expect(appOriginForSite('site.localhost', '8787', 'http:')).toBe('http://localhost:8787');
	});
});

describe('site language prefix (FN-32)', () => {
	it('routes /en and /en/… on the site host to the same site route as the Indonesian path', () => {
		expect(routeFor(u('http://site.localhost:8787/en'))).toBe('/site');
		expect(routeFor(u('http://site.localhost:8787/en/'))).toBe('/site');
		expect(routeFor(u('http://site.localhost:8787/en/blog/a-b'))).toBe('/site/blog/a-b');
		expect(routeFor(u('http://site.localhost:8787/en/privasi'))).toBe('/site/privasi');
	});
	it('strips one prefix only and leaves look-alikes alone', () => {
		expect(routeFor(u('http://site.localhost:8787/en/en'))).toBe('/site/en');
		expect(routeFor(u('http://site.localhost:8787/english'))).toBe('/site/english');
		expect(routeFor(u('http://site.localhost:8787/EN/blog'))).toBe('/site/EN/blog');
	});
	it('does not give the app host a language prefix', () => {
		expect(routeFor(u('http://localhost:8787/en'))).toBe('/en');
		expect(routeFor(u('http://localhost:8787/en/site'))).toBe('/en/site');
	});
});

describe('prerenderRoute (FN-32 build only)', () => {
	it('resolves crawler paths exactly as the canonical site host would', () => {
		const crawler = (p: string) => new URL(p, 'http://sveltekit-prerender');
		expect(prerenderRoute(crawler('/'))).toBe('/site');
		expect(prerenderRoute(crawler('/en/blog'))).toBe('/site/blog');
		expect(prerenderRoute(crawler('/_app/version.json'))).toBe('/_app/version.json');
	});
	it('keeps a protocol-relative-looking path a path', () => {
		expect(prerenderRoute(new URL('http://sveltekit-prerender//evil.example/x'))).toBe(
			'/site//evil.example/x'
		);
	});
});

describe('canonical site origin and the app → site pairing', () => {
	it('names the first site host, plain http only for local names', () => {
		expect(canonicalSiteOrigin()).toBe('http://site.localhost');
		expect(isLocalSiteHost('site.localhost')).toBe(true);
		expect(isLocalSiteHost('montra.example')).toBe(false);
		expect(isLocalSiteHost('localhost.example')).toBe(false);
	});
	it('finds the site paired with an app host, keeping its port and scheme', () => {
		expect(siteOriginForApp('localhost', '8868', 'http:')).toBe('http://site.localhost:8868');
		expect(siteOriginForApp('LOCALHOST', '', 'http:')).toBe('http://site.localhost');
		expect(siteOriginForApp('LOCALHOST.', '', 'https:')).toBe('https://site.localhost');
	});
	it('answers null for an app host without a paired site (e.g. staging on workers.dev)', () => {
		expect(siteOriginForApp('montra-app-staging.example.workers.dev', '', 'https:')).toBeNull();
		expect(siteOriginForApp('site.localhost', '', 'http:')).toBeNull();
	});
});
