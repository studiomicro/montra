import { ENDPOINTS } from './api/endpoints';

/**
 * Cross-site form protection, moved from SvelteKit into hooks.server.ts (FN-38 cycle 2). SvelteKit 3's own
 * check (`csrf.trustedOrigins`, https://svelte.dev/docs/kit/configuration#csrf) is all-or-nothing: it refuses
 * every POST/PUT/PATCH/DELETE without a JSON-like Content-Type whose Origin is not this origin, before any hook
 * runs, and offers no per-route exemption. That refused a plain `DELETE` from an API script (no body, no
 * Content-Type, no Origin) with a plain-text 403. So vite.config.ts sets `trustedOrigins: ['*']` (Kit's
 * documented way to turn its check off) and this module applies the identical rule — same methods, same form
 * content types, same origin comparison, same answer — to every request except the FN-38 public-API routes,
 * which authenticate by `Authorization: Bearer` only and never by a cookie, so a forged cross-site request
 * carries no credential they accept.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** What an HTML form can send (Kit's list, `application/x-sveltekit-formdata` included). */
const FORM_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	'application/x-sveltekit-formdata'
]);

/** Route ids of the FN-38 Bearer-only routes (`/api/v1/transactions/{id}` is `…/[id]`). */
const BEARER_ROUTES: ReadonlySet<string> = new Set(
	Object.values(ENDPOINTS).map((e) => e.path.replace('{id}', '[id]'))
);

export function isBearerApiRoute(routeId: string | null): boolean {
	return routeId !== null && BEARER_ROUTES.has(routeId);
}

/** SvelteKit's `is_csrf_forbidden` with no trusted origins: a cross-site (or Origin-less) form submission. */
export function isCrossSiteForm(request: Request, selfOrigin: string): boolean {
	const type = request.headers.get('content-type');
	const formType = (type?.split(';', 1)[0] ?? '').trim().toLowerCase();
	return (
		(!type || FORM_TYPES.has(formType)) &&
		MUTATING.has(request.method) &&
		request.headers.get('origin') !== selfOrigin
	);
}

/** SvelteKit's own refusal, unchanged: JSON for `Accept: application/json`, else plain text. */
export function crossSiteRefusal(request: Request): Response {
	const message = `Cross-site ${request.method} form submissions are forbidden`;
	return request.headers.get('accept') === 'application/json'
		? Response.json({ message }, { status: 403 })
		: new Response(message, {
				status: 403,
				headers: { 'content-type': 'text/plain;charset=UTF-8' }
			});
}
