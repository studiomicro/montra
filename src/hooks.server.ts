import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { isSiteHost } from '#lib/shared/hosts';
import { resolveLocale } from '#lib/shared/i18n';
import { splitSiteLocale } from '#lib/shared/site-locale';
import { authGate, isAppRoute } from '#lib/server/auth/gate';
import { secureDeployment } from '#lib/server/auth/session';
import {
	isTurnstileConfigured,
	TURNSTILE_ROUTE_IDS,
	withTurnstileCsp
} from '#lib/server/auth/turnstile';
import { planOf } from '#lib/server/billing/gate';
import { getDb } from '#lib/server/db';
import { getEnv } from '#lib/server/env';
import { resolveTheme, themeColors } from '#lib/server/prefs';
import { crossSiteRefusal, isBearerApiRoute, isCrossSiteForm } from '#lib/server/csrf';
import { securityHeaders } from '#lib/server/security-headers';
import { resolveCurrentSpace, spaceCookieName } from '#lib/server/spaces/access';
import { carriesInviteToken, redactedPath } from '#lib/server/spaces/invites';
import { errorLabel } from '#lib/server/util';
import type { Plan } from '#lib/shared/billing/plans';
import { allowedTheme, appleTouchIconFile } from '#lib/shared/pro-look';

/** What sign-out clears in the browser (cookies are cleared one by one by the action itself). */
const CLEAR_SITE_DATA = '"cache", "storage"';

function withSecurityHeaders(response: Response, url?: URL): Response {
	// An invite token in the URL is a bearer secret: a Referer carries at most the origin, never the path.
	// Not `no-referrer`: under it browsers send `Origin: null` on form POSTs, which the CSRF check refuses.
	if (url && carriesInviteToken(url)) response.headers.set('referrer-policy', 'strict-origin');
	for (const [name, value] of Object.entries(securityHeaders())) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	return response;
}

const transformPageChunk =
	(locals: App.Locals) =>
	({ html }: { html: string }) => {
		const colors = themeColors(locals.theme);
		return html
			.replace('%fin.lang%', locals.locale)
			.replace('%fin.theme%', locals.theme)
			.replace('%fin.themeColorLight%', colors.light)
			.replace('%fin.themeColorDark%', colors.dark)
			.replace('%fin.appleTouchIcon%', appleTouchIconFile(locals.plan));
	};

/**
 * FN-46: the plan in force for the signed-in account (billing/gate.ts planOf, one primary-key read), Gratis when
 * signed out. A failed read shows the Gratis look rather than failing the page: the look is never a reason to
 * refuse a request, and Gratis grants nothing.
 */
async function planForLook(locals: App.Locals): Promise<Plan> {
	if (!locals.user) return 'gratis';
	try {
		return await planOf(locals.db, locals.user.id, Date.now());
	} catch (e) {
		console.error('hooks: plan read failed', errorLabel(e));
		return 'gratis';
	}
}

/** The public site's own routes (FN-32): their language comes from the URL (`/en/…`), never a cookie. */
const isSiteRoute = (routeId: string | null) => routeId?.startsWith('/(site)/') ?? false;

const handleRequest: Handle = async ({ event, resolve }) => {
	// Cross-site form submissions are refused here, first, exactly as SvelteKit would (its own check is off in
	// vite.config.ts because it cannot exempt the Bearer-only public API; see lib/server/csrf.ts).
	if (!isBearerApiRoute(event.route.id) && isCrossSiteForm(event.request, event.url.origin))
		return withSecurityHeaders(crossSiteRefusal(event.request));
	event.locals.locale = isSiteRoute(event.route.id)
		? splitSiteLocale(event.url.pathname).locale
		: resolveLocale(event.cookies.get('lang'), event.request.headers.get('accept-language'));
	event.locals.theme = resolveTheme(event.cookies.get('theme'));

	// Prerendering the public site (FN-32): no bindings exist at build time and no page there reads a session,
	// so nothing touches D1. `building` is never true in the deployed Worker.
	if (building) {
		event.locals.user = null;
		event.locals.sessionToken = null;
		event.locals.space = null;
		event.locals.plan = 'gratis';
		event.locals.theme = allowedTheme(event.locals.theme, 'gratis');
		return resolve(event, { transformPageChunk: transformPageChunk(event.locals) });
	}

	// Cookie name and Secure flag follow the host, never the scheme; a deployed host is HTTPS only, so a
	// plain-http request is sent to https before any cookie is read.
	const secure = secureDeployment(event.url.hostname);
	event.locals.secure = secure;
	if (secure && event.url.protocol === 'http:') {
		const https = new URL(event.url);
		https.protocol = 'https:';
		https.port = '';
		return withSecurityHeaders(
			new Response(null, { status: 308, headers: { location: https.href } })
		);
	}

	event.locals.db = getDb(getEnv().DB);
	const early = await authGate(event, event.locals.db, secure, Date.now());
	if (early) return withSecurityHeaders(early, event.url);

	// FN-46: the Pro look follows the stored plan, never the cookie. A Pro theme from an account without a paid
	// plan in force (never paid, lapsed, signed out, or edited by hand) is shown as `system` on this very response;
	// transformPageChunk reads `locals` live, so <html data-theme>, theme-color and the touch icon all follow.
	event.locals.plan = await planForLook(event.locals);
	event.locals.theme = allowedTheme(event.locals.theme, event.locals.plan);

	// The default space of an (app) page: the `space` cookie when still a live membership, else the personal
	// space (FN-03). Routes that name a space themselves check it with requireSpaceAccess instead. Public (app)
	// pages (the install guide) resolve it too when signed in, so the sidebar keeps its space card.
	event.locals.space =
		event.locals.user && isAppRoute(event.route.id)
			? await resolveCurrentSpace(
					event.locals.db,
					event.locals.user.id,
					event.cookies.get(spaceCookieName(secure))
				)
			: null;

	const response = await resolve(event, { transformPageChunk: transformPageChunk(event.locals) });
	// The app host is the signed-in product: never indexed by search engines (the site host is, FN-32).
	if (!isSiteHost(event.url.hostname)) response.headers.set('x-robots-tag', 'noindex');
	// Signed-in pages carry personal data: never stored by shared caches or the back/forward cache.
	if (event.locals.user && !response.headers.has('cache-control'))
		response.headers.set('cache-control', 'private, no-store');
	// Pages differ by User-Agent (install guidance, iOS launch images; FN-13, FN-13b): a shared cache must key on it
	// (FN-13b red team LOW-1).
	if (response.headers.get('content-type')?.startsWith('text/html'))
		response.headers.append('vary', 'User-Agent');
	// Sign-out and account deletion: this browser drops what it holds for the origin besides cookies —
	// HTTP and Cache Storage caches, the service worker and with it the push subscription (shared devices).
	if (event.locals.clearSiteData) response.headers.set('clear-site-data', CLEAR_SITE_DATA);
	// FN-50: the Turnstile widget's origin is admitted to the CSP of the two auth pages only, and only while the
	// check is configured; every other route's policy stays byte for byte what src/lib/server/csp.ts says.
	const csp = response.headers.get('content-security-policy');
	if (
		csp &&
		event.route.id !== null &&
		TURNSTILE_ROUTE_IDS.has(event.route.id) &&
		isTurnstileConfigured(getEnv() as Env & { TURNSTILE_SITE_KEY?: string })
	)
		response.headers.set('content-security-policy', withTurnstileCsp(csp));
	return withSecurityHeaders(response, event.url);
};

/**
 * One log line per request: method, the route id (never its parameters) or, when no route matched, the path
 * with any invite token masked (`redactedPath`), status and duration. Never the query string, headers or body.
 * Workers Logs' own invocation logs carry the full URL, invite tokens included, so they are switched off in
 * wrangler.jsonc (`observability.logs.invocation_logs: false`) and this line takes their place (FN-03 red team L3).
 */
export const handle: Handle = async (input) => {
	// Prerendering the public site (FN-32) is not a request to log.
	if (building) return handleRequest(input);
	const started = Date.now();
	const response = await handleRequest(input);
	const { event } = input;
	console.log('request', {
		method: event.request.method,
		path: event.route.id ?? redactedPath(event.url),
		status: response.status,
		ms: Date.now() - started
	});
	return response;
};

/**
 * Unexpected errors: one log line with the route and `errorLabel` only — never the error message, stack or request
 * body, which can hold bound query values and so user data (red team FN-18 L2). App and framework errors (404,
 * 400 …) are not logged. The response keeps SvelteKit's defaults (`Internal Error` for unknown errors).
 */
export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind === 'unknown')
		console.error('unhandled error', event.route.id ?? '-', errorLabel(error));
};
