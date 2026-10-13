import { describe, expect, it, vi } from 'vitest';
import { cspHeader } from './csp';
import { prerenderedResponse, withPrerenderedSite, type PrerenderedFile } from './site-static';

const HTML: PrerenderedFile = { type: 'text/html; charset=utf-8', body: '<h1>Situs</h1>' };
const XML: PrerenderedFile = { type: 'application/xml; charset=utf-8', body: '<urlset/>' };
const FILES = new Map([
	['/', HTML],
	['/blog', HTML],
	['/en/blog', HTML],
	['/sitemap.xml', XML]
]);

const get = (url: string, method = 'GET') => new Request(url, { method });

describe('prerenderedResponse', () => {
	it('answers a prerendered page on the site host with the CSP and security headers', async () => {
		const res = prerenderedResponse(get('http://site.localhost:8787/blog'), FILES);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe('<h1>Situs</h1>');
		expect(res?.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(res?.headers.get('content-security-policy')).toBe(cspHeader());
		expect(res?.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res?.headers.get('strict-transport-security')).toContain('max-age=');
		expect(res?.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
		expect(res?.headers.get('cross-origin-opener-policy')).toBe('same-origin');
	});

	it('serves non-HTML files with their own type and no page CSP', () => {
		const res = prerenderedResponse(get('http://site.localhost/sitemap.xml'), FILES);
		expect(res?.headers.get('content-type')).toBe('application/xml; charset=utf-8');
		expect(res?.headers.get('content-security-policy')).toBeNull();
		expect(res?.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('never answers on the app host: its / is Beranda, its /blog is not the site', () => {
		for (const path of ['/', '/blog', '/en/blog', '/sitemap.xml'])
			expect(prerenderedResponse(get(`http://localhost:8787${path}`), FILES)).toBeNull();
	});

	it('answers HEAD without a body and leaves POST and other methods to SvelteKit', async () => {
		const head = prerenderedResponse(get('http://site.localhost/', 'HEAD'), FILES);
		expect(head?.status).toBe(200);
		expect(await head?.text()).toBe('');
		expect(prerenderedResponse(get('http://site.localhost/', 'POST'), FILES)).toBeNull();
	});

	it('decodes the path the way SvelteKit does', () => {
		expect(prerenderedResponse(get('http://site.localhost/bl%6Fg'), FILES)?.status).toBe(200);
		// An encoded slash stays encoded: not a prerendered path.
		expect(prerenderedResponse(get('http://site.localhost/en%2Fblog'), FILES)).toBeNull();
		expect(prerenderedResponse(get('http://site.localhost/%E0%A4%A'), FILES)).toBeNull();
	});

	it('redirects a trailing slash to the prerendered path, keeping the query', () => {
		const res = prerenderedResponse(get('http://site.localhost/blog/?a=1'), FILES);
		expect(res?.status).toBe(308);
		expect(res?.headers.get('location')).toBe('/blog?a=1');
		expect(res?.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('hands unknown and dynamic site paths to SvelteKit', () => {
		for (const path of ['/hapus-akun', '/mulai', '/nope', '/BLOG', '//blog'])
			expect(prerenderedResponse(get(`http://site.localhost${path}`), FILES)).toBeNull();
	});
});

describe('withPrerenderedSite', () => {
	it('falls through to the wrapped Worker for everything it does not serve', async () => {
		const app = { fetch: vi.fn(() => new Response('app')) };
		const worker = withPrerenderedSite(app, FILES);
		expect(await (await worker.fetch(get('http://localhost/'), {}, {})).text()).toBe('app');
		expect(await (await worker.fetch(get('http://site.localhost/'), {}, {})).text()).toBe(
			'<h1>Situs</h1>'
		);
		expect(app.fetch).toHaveBeenCalledTimes(1);
	});
});
