import { describe, expect, it } from 'vitest';
import { listPosts } from './blog';
import { robotsTxt, sitemapXml } from './sitemap';

describe('sitemap.xml (FN-32)', () => {
	const xml = sitemapXml(listPosts('id'));
	const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

	it('lists exactly the public pages in both languages on the canonical site host', () => {
		const paths = [
			'/',
			'/blog',
			'/blog/file-unggahan-tidak-disimpan',
			'/blog/email-qris-jadi-transaksi',
			'/blog/struk-jadi-transaksi',
			'/pasang',
			'/privasi',
			'/ketentuan',
			'/hapus-akun'
		];
		const expected = paths.flatMap((p) => [
			`http://site.localhost${p}`,
			`http://site.localhost${p === '/' ? '/en' : `/en${p}`}`
		]);
		expect(locs).toEqual(expected);
	});

	it('never lists an app path or another host', () => {
		for (const loc of locs) {
			expect(loc?.startsWith('http://site.localhost/')).toBe(true);
			expect(loc).not.toMatch(/\/(riwayat|laporan|kekayaan|pengaturan|masuk|daftar|mulai)\b/);
		}
	});

	it('gives each post its date and each page its other-language alternate', () => {
		expect(xml).toContain(
			'<loc>http://site.localhost/blog/struk-jadi-transaksi</loc>\n\t\t<lastmod>2026-10-06</lastmod>'
		);
		expect(xml).toContain(
			'<xhtml:link rel="alternate" hreflang="en" href="http://site.localhost/en/pasang"/>'
		);
	});
});

describe('robots.txt', () => {
	it('allows the site and names its sitemap on the canonical host', () => {
		expect(robotsTxt()).toBe(
			'User-agent: *\nAllow: /\n\nSitemap: http://site.localhost/sitemap.xml\n'
		);
	});
});
