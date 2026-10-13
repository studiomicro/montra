import type { Locale } from './i18n.ts';

/**
 * Public site language (FN-32): the URL decides it, so a prerendered page is one static file per language.
 * Indonesian lives at the bare path (`/blog`), English under `/en` (`/en/blog`). The app keeps its cookie and
 * Accept-Language rule (resolveLocale).
 */
const EN_PREFIX = '/en';

/** `/en/blog` → `{ locale: 'en', path: '/blog' }`; `/en` → `/`; anything else is Indonesian, unchanged. */
export function splitSiteLocale(pathname: string): { locale: Locale; path: string } {
	if (pathname === EN_PREFIX) return { locale: 'en', path: '/' };
	if (pathname.startsWith(`${EN_PREFIX}/`))
		return { locale: 'en', path: pathname.slice(EN_PREFIX.length) };
	return { locale: 'id', path: pathname };
}

/** The public path of `path` (a language-free site path such as `/` or `/blog`) in `locale`. */
export function localizedSitePath(locale: Locale, path: string): string {
	if (locale === 'id') return path;
	return path === '/' ? EN_PREFIX : `${EN_PREFIX}${path}`;
}

/**
 * The href of the language switch: the current page in `target`. Error pages (any status but 200) link to the
 * language root, and leading slashes, backslashes or whitespace collapse to one `/`, so a crafted 404
 * path such as `/en//evil.com` can never become a protocol-relative link (red team L1).
 */
export function switchedSitePath(target: Locale, pathname: string, status: number): string {
	if (status !== 200) return localizedSitePath(target, '/');
	const path = splitSiteLocale(pathname).path.replace(/^[\\/\s]+/, '/');
	return localizedSitePath(target, path.startsWith('/') ? path : '/');
}
