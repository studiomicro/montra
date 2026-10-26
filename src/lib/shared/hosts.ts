import { splitSiteLocale } from './site-locale.ts';

/**
 * Hosts that serve the public site (the rest serve the app). The production domains are an owner decision
 * (docs/TASKS.md); add them here when chosen, together with their app host in APP_HOST_FOR_SITE. The first
 * entry is the canonical site host: canonical links and the sitemap name it (FN-32).
 */
const SITE_HOSTS: readonly string[] = ['site.localhost'];

const APP_HOST_FOR_SITE: Readonly<Record<string, string>> = { 'site.localhost': 'localhost' };

function normalize(hostname: string): string {
	return hostname.toLowerCase().replace(/\.$/, '');
}

export function isSiteHost(hostname: string): boolean {
	return SITE_HOSTS.includes(normalize(hostname));
}

const PASSTHROUGH = /^\/(_app|api)(\/|$)/;

/** Internal pathname for SvelteKit routing. Unknown internal path → no route → 404. */
export function routeFor(url: URL): string {
	const path = url.pathname;
	if (isSiteHost(url.hostname)) {
		if (PASSTHROUGH.test(path)) return path;
		// `/en/…` is the English copy of the same page (FN-32): same route, the language comes from the URL.
		const site = splitSiteLocale(path).path;
		return site === '/' ? '/site' : `/site${site}`;
	}
	// SvelteKit decodes the reroute result afterwards, so test the decoded path.
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		return '/__not_found';
	}
	if (/^\/site(\/|$)/i.test(decoded.replace(/^\/+/, '/'))) return '/__not_found';
	return path;
}

export function appOriginForSite(hostname: string, port: string, protocol: string): string {
	const appHost = APP_HOST_FOR_SITE[normalize(hostname)] ?? normalize(hostname);
	return `${protocol}//${appHost}${port ? `:${port}` : ''}`;
}

/**
 * Route of a prerender request (FN-32). Only the public site is prerendered, so the crawler's path resolves as
 * the same path on the canonical site host would; never used outside the build.
 */
export function prerenderRoute(url: URL): string {
	const site = new URL(canonicalSiteOrigin());
	site.pathname = url.pathname;
	site.search = url.search;
	return routeFor(site);
}

/** A site host served over plain http: only local names (`site.localhost`); every deployed host is HTTPS. */
export function isLocalSiteHost(hostname: string): boolean {
	return /(^|\.)localhost$/.test(normalize(hostname));
}

/** Origin of the canonical site host (the first SITE_HOSTS entry). */
export function canonicalSiteOrigin(): string {
	const host = SITE_HOSTS[0] as string;
	return `${isLocalSiteHost(host) ? 'http' : 'https'}://${host}`;
}

/** The site origin paired with this app host (same port and scheme), or null when none is configured. */
export function siteOriginForApp(hostname: string, port: string, protocol: string): string | null {
	const app = normalize(hostname);
	const site = Object.keys(APP_HOST_FOR_SITE).find((s) => APP_HOST_FOR_SITE[s] === app);
	return site ? `${protocol}//${site}${port ? `:${port}` : ''}` : null;
}
