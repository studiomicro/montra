import type { RequestEvent } from '@sveltejs/kit';
import { createTranslator, msg } from '#lib/shared/i18n';
import type { Db } from '../db';
import { clearSessionCookie, resolveSession, sessionCookieName } from './session';

/**
 * `(app)` pages that work signed out too: the install guide (FN-13), since installing the app is a browser
 * capability, not an account feature. Exact route ids only.
 */
const PUBLIC_APP_ROUTES: ReadonlySet<string> = new Set(['/(app)/pengaturan/instal']);

/**
 * Pages that need a signed-in user: the whole `(app)` route group except PUBLIC_APP_ROUTES. `/masuk`,
 * `/daftar` and `/akun-dihapus` live in `(auth)`, the public site in `(site)`, and `/api/v1/*` routes outside
 * any group; an unmatched path (null route id) is a plain 404.
 */
export function isProtectedRoute(routeId: string | null): boolean {
	if (routeId === null || PUBLIC_APP_ROUTES.has(routeId)) return false;
	return isAppRoute(routeId);
}

/** Any page of the `(app)` group, public ones included: a signed-in visitor sees the app shell there. */
export function isAppRoute(routeId: string | null): boolean {
	return routeId !== null && (routeId === '/(app)' || routeId.startsWith('/(app)/'));
}

export const SESSION_ENDED = msg('Sesi berakhir. Silakan masuk kembali.');

/** `/masuk?next=…` for the page a signed-out request asked for (SvelteKit's own query params dropped). */
export function signInLocation(url: URL): string {
	const search = new URLSearchParams(url.search);
	search.delete('x-sveltekit-invalidated');
	search.delete('x-sveltekit-trailing-slash');
	const query = search.toString();
	const next = url.pathname + (query ? `?${query}` : '');
	return next === '/' ? '/masuk' : `/masuk?next=${encodeURIComponent(next)}`;
}

/**
 * Resolves the session cookie into `locals.user`/`locals.sessionToken` (a dead cookie is cleared), then
 * answers a signed-out request to a protected route: a GET is sent to `/masuk?next=…` (as SvelteKit's JSON
 * redirect for a client-side data request), anything else gets 401. Returns null when the request may go
 * on to `resolve()`. The response is built here, not thrown, so hooks.server.ts adds the security headers
 * to it like to every other response.
 */
export async function authGate(
	event: RequestEvent,
	db: Db,
	secure: boolean,
	now: number
): Promise<Response | null> {
	event.locals.user = null;
	event.locals.sessionToken = null;
	let cleared: string | null = null;
	const token = event.cookies.get(sessionCookieName(secure));
	if (token) {
		const user = await resolveSession(db, token, now);
		if (user) {
			event.locals.user = user;
			event.locals.sessionToken = token;
		} else {
			cleared = clearSessionCookie(event.cookies, secure);
		}
	}
	if (event.locals.user || !isProtectedRoute(event.route.id)) return null;

	let response: Response;
	const method = event.request.method;
	if (method === 'GET' || method === 'HEAD') {
		const location = signInLocation(event.url);
		response = event.isDataRequest
			? Response.json({ type: 'redirect', location })
			: new Response(null, { status: 303, headers: { location } });
	} else {
		const message = createTranslator(event.locals.locale).tr(SESSION_ENDED);
		const wantsJson = (event.request.headers.get('accept') ?? '').includes('application/json');
		response = wantsJson
			? Response.json({ type: 'error', error: { message } }, { status: 401 })
			: new Response(message, {
					status: 401,
					headers: { 'content-type': 'text/plain; charset=utf-8' }
				});
	}
	response.headers.set('cache-control', 'no-store');
	if (cleared) response.headers.append('set-cookie', cleared);
	return response;
}
