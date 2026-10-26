import { canonicalSiteOrigin } from '#lib/shared/hosts';
import type { Locale } from '#lib/shared/i18n';
import { localizedSitePath } from '#lib/shared/site-locale';
import { escapeHtml } from './markdown.ts';

/** The public site's indexable pages (FN-32), as language-free paths; each is listed once per language. */
function sitePaths(postSlugs: readonly { slug: string; date: string }[]) {
	return [
		{ path: '/', lastmod: null },
		{ path: '/blog', lastmod: postSlugs[0]?.date ?? null },
		...postSlugs.map((p) => ({ path: `/blog/${p.slug}`, lastmod: p.date })),
		{ path: '/pasang', lastmod: null },
		{ path: '/privasi', lastmod: null },
		{ path: '/ketentuan', lastmod: null },
		{ path: '/hapus-akun', lastmod: null }
	];
}

const LOCALES: readonly Locale[] = ['id', 'en'];

/** sitemap.xml on the canonical site host, with each page's other-language alternate. */
export function sitemapXml(posts: readonly { slug: string; date: string }[]): string {
	const origin = canonicalSiteOrigin();
	const loc = (l: Locale, path: string) => escapeHtml(`${origin}${localizedSitePath(l, path)}`);
	const urls = sitePaths(posts).flatMap(({ path, lastmod }) =>
		LOCALES.map((l) =>
			[
				'\t<url>',
				`\t\t<loc>${loc(l, path)}</loc>`,
				...(lastmod ? [`\t\t<lastmod>${lastmod}</lastmod>`] : []),
				...LOCALES.map(
					(a) => `\t\t<xhtml:link rel="alternate" hreflang="${a}" href="${loc(a, path)}"/>`
				),
				'\t</url>'
			].join('\n')
		)
	);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
		...urls,
		'</urlset>',
		''
	].join('\n');
}

export function robotsTxt(): string {
	return `User-agent: *\nAllow: /\n\nSitemap: ${canonicalSiteOrigin()}/sitemap.xml\n`;
}
