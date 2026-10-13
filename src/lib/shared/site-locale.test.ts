import { describe, expect, it } from 'vitest';
import { localizedSitePath, splitSiteLocale, switchedSitePath } from '#lib/shared/site-locale';

describe('splitSiteLocale', () => {
	it('reads English from the /en prefix', () => {
		expect(splitSiteLocale('/en')).toEqual({ locale: 'en', path: '/' });
		expect(splitSiteLocale('/en/')).toEqual({ locale: 'en', path: '/' });
		expect(splitSiteLocale('/en/blog/x')).toEqual({ locale: 'en', path: '/blog/x' });
	});
	it('treats every other path as Indonesian, unchanged', () => {
		expect(splitSiteLocale('/')).toEqual({ locale: 'id', path: '/' });
		expect(splitSiteLocale('/blog')).toEqual({ locale: 'id', path: '/blog' });
		expect(splitSiteLocale('/english')).toEqual({ locale: 'id', path: '/english' });
		expect(splitSiteLocale('/EN/blog')).toEqual({ locale: 'id', path: '/EN/blog' });
	});
});

describe('localizedSitePath', () => {
	it('adds /en for English and nothing for Indonesian', () => {
		expect(localizedSitePath('id', '/')).toBe('/');
		expect(localizedSitePath('id', '/pasang')).toBe('/pasang');
		expect(localizedSitePath('en', '/')).toBe('/en');
		expect(localizedSitePath('en', '/pasang')).toBe('/en/pasang');
	});
	it('round-trips with splitSiteLocale', () => {
		for (const path of ['/', '/blog', '/blog/a-b', '/privasi'])
			for (const locale of ['id', 'en'] as const)
				expect(splitSiteLocale(localizedSitePath(locale, path))).toEqual({ locale, path });
	});
});

describe('switchedSitePath', () => {
	it('keeps the page for normal paths', () => {
		expect(switchedSitePath('en', '/', 200)).toBe('/en');
		expect(switchedSitePath('en', '/blog/a-b', 200)).toBe('/en/blog/a-b');
		expect(switchedSitePath('id', '/en', 200)).toBe('/');
		expect(switchedSitePath('id', '/en/privasi', 200)).toBe('/privasi');
	});
	it('collapses leading slashes and backslashes so the link stays on the site', () => {
		expect(switchedSitePath('id', '/en//evil.com', 200)).toBe('/evil.com');
		expect(switchedSitePath('id', '/en/\\evil.com', 200)).toBe('/evil.com');
		expect(switchedSitePath('en', '//evil.com', 200)).toBe('/en/evil.com');
		expect(switchedSitePath('en', '/\\evil.com', 200)).toBe('/en/evil.com');
		expect(switchedSitePath('id', '/en/\t//evil.com', 200)).toBe('/evil.com');
		// Percent-encoded slashes stay encoded: a relative path, not an authority.
		expect(switchedSitePath('id', '/en/%2F%2Fevil.com', 200)).toBe('/%2F%2Fevil.com');
		expect(switchedSitePath('en', '/%2F%2Fevil.com', 200)).toBe('/en/%2F%2Fevil.com');
	});
	it('links error pages to the language root', () => {
		for (const pathname of [
			'//evil.com',
			'/\\evil.com',
			'/%2F%2Fevil.com',
			'/en//evil.com',
			'/nope'
		]) {
			expect(switchedSitePath('id', pathname, 404)).toBe('/');
			expect(switchedSitePath('en', pathname, 404)).toBe('/en');
		}
		expect(switchedSitePath('en', '/blog', 500)).toBe('/en');
	});
	it('never yields a protocol-relative or backslash href', () => {
		for (const pathname of [
			'//evil.com',
			'/\\evil.com',
			'/en//evil.com',
			'/en/\\evil.com',
			'/en///\\x'
		])
			for (const target of ['id', 'en'] as const) {
				const href = switchedSitePath(target, pathname, 200);
				expect(href.startsWith('/')).toBe(true);
				expect(href).not.toMatch(/^\/[\\/]/);
			}
	});
});
