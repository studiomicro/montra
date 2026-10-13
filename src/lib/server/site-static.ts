import { isLocalSiteHost, isSiteHost } from '../shared/hosts.ts';
import { cspHeader } from './csp.ts';
import { securityHeaders } from './security-headers.ts';

/**
 * Serving the prerendered public site (FN-32).
 *
 * SvelteKit prerenders the site's pages under their public paths (`/`, `/blog`, `/en/privasi` …), which overlap
 * the app's own paths (`/` is Beranda). Served as static assets they would answer on every host, so the build
 * (scripts/site-adapter.ts) keeps them out of the assets directory and bundles them into the Worker instead; this
 * wrapper answers them on the site host only, before SvelteKit runs, with the same CSP and security headers as
 * every rendered page. Every other request — the app host, the site's dynamic pages, unknown paths — goes to
 * SvelteKit unchanged.
 */

export interface PrerenderedFile {
	/** Content type SvelteKit recorded for the file. */
	type: string;
	body: string;
}

export type PrerenderedFiles = ReadonlyMap<string, PrerenderedFile>;

interface FetchHandler<E> {
	fetch(request: Request, env: E, ctx: unknown): Response | Promise<Response>;
}

/** The decoding SvelteKit applies to a pathname before matching (`%25` stays encoded). */
function decodePathname(pathname: string): string | null {
	try {
		return pathname.split('%25').map(decodeURI).join('%25');
	} catch {
		return null;
	}
}

/** Prerendered pages may be cached briefly by browsers and the edge; they hold nothing personal. */
const CACHE_CONTROL = 'public, max-age=300';

function headersFor(file: PrerenderedFile): Headers {
	const headers = new Headers({ 'content-type': file.type, 'cache-control': CACHE_CONTROL });
	if (file.type.startsWith('text/html')) headers.set('content-security-policy', cspHeader());
	for (const [name, value] of Object.entries(securityHeaders())) headers.set(name, value);
	return headers;
}

/**
 * The response for a prerendered site file, a 308 to drop a trailing slash from one, or null to hand the
 * request to SvelteKit. A plain-http request to a deployed host is left to hooks.server.ts (its 308 to https).
 */
export function prerenderedResponse(request: Request, files: PrerenderedFiles): Response | null {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null;
	const url = new URL(request.url);
	if (!isSiteHost(url.hostname)) return null;
	if (url.protocol === 'http:' && !isLocalSiteHost(url.hostname)) return null;
	const path = decodePathname(url.pathname);
	if (path === null) return null;

	const file = files.get(path);
	if (file) {
		return new Response(request.method === 'HEAD' ? null : file.body, {
			status: 200,
			headers: headersFor(file)
		});
	}
	if (path.length > 1 && path.endsWith('/') && files.has(path.slice(0, -1))) {
		const headers = new Headers({ location: `${url.pathname.slice(0, -1)}${url.search}` });
		for (const [name, value] of Object.entries(securityHeaders())) headers.set(name, value);
		return new Response(null, { status: 308, headers });
	}
	return null;
}

/** Wraps the SvelteKit Worker: prerendered site files first, everything else unchanged. */
export function withPrerenderedSite<E>(app: FetchHandler<E>, files: PrerenderedFiles) {
	return {
		fetch(request: Request, env: E, ctx: unknown): Response | Promise<Response> {
			return prerenderedResponse(request, files) ?? app.fetch(request, env, ctx);
		}
	};
}
