import { TURNSTILE_ORIGIN } from '#lib/shared/turnstile';

/**
 * FN-50 Part A: Cloudflare Turnstile on sign-in and sign-up. The check is on only when both `TURNSTILE_SITE_KEY`
 * (public, rendered into the page) and `TURNSTILE_SECRET_KEY` (server only) are set (Owner decision 1); a half
 * configuration behaves as unset, is shown as `partial` on the admin page and logged once per auth action.
 * Nothing here logs or returns a token or the secret.
 */

export interface TurnstileEnv {
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
}

export const SITEVERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;
/** The form field the widget fills. */
export const TURNSTILE_FIELD = 'cf-turnstile-response';
/** Longest token read; anything longer is refused before any call. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;
/** How long siteverify may take before the attempt is refused. */
const TURNSTILE_TIMEOUT_MS = 5000;
/** The widget actions the two pages render and the server expects back. */
export type TurnstileAction = 'sign-in' | 'sign-up';

const present = (value: string | undefined) => (value ?? '').trim() !== '';

export function isTurnstileConfigured(env: TurnstileEnv | undefined): boolean {
	return present(env?.TURNSTILE_SITE_KEY) && present(env?.TURNSTILE_SECRET_KEY);
}

/** `ok` / `partial` / `missing` for the admin status page: names and states only. */
export function turnstileState(env: TurnstileEnv | undefined): 'ok' | 'partial' | 'missing' {
	const set = [env?.TURNSTILE_SITE_KEY, env?.TURNSTILE_SECRET_KEY].filter(present).length;
	return set === 2 ? 'ok' : set === 1 ? 'partial' : 'missing';
}

/** The public site key for the page, or null when the check is off (the secret is never returned). */
export function turnstileSiteKey(env: TurnstileEnv | undefined): { siteKey: string } | null {
	return isTurnstileConfigured(env) ? { siteKey: env!.TURNSTILE_SITE_KEY!.trim() } : null;
}

type TurnstileRefusal =
	| 'missing'
	| 'too_long'
	| 'timeout'
	| 'network'
	| 'status'
	| 'non_json'
	| 'failed'
	| 'action'
	| 'hostname';

export type TurnstileResult = { ok: true } | { ok: false; reason: TurnstileRefusal };

interface SiteverifyAnswer {
	success?: unknown;
	action?: unknown;
	hostname?: unknown;
}

/**
 * Verifies a widget token with siteverify: `secret`, `response`, `remoteip` (the connecting IP Cloudflare already
 * has, Owner decision 3) and a fresh UUID `idempotency_key`, under a 5 s timeout. `ok` only when the answer has
 * `success: true` and the expected `action` and `hostname`; everything else (timeout, network error, non-2xx,
 * non-JSON, `timeout-or-duplicate`, a wrong action or host) is refused with a reason label for the log line. The
 * token is never logged or returned.
 */
export async function verifyTurnstile(
	env: TurnstileEnv,
	token: string,
	expected: { action: TurnstileAction; hostname: string },
	remoteip: string | null,
	fetchFn: typeof fetch = fetch
): Promise<TurnstileResult> {
	if (!token) return { ok: false, reason: 'missing' };
	if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) return { ok: false, reason: 'too_long' };
	const body = new URLSearchParams({
		secret: env.TURNSTILE_SECRET_KEY!.trim(),
		response: token,
		idempotency_key: crypto.randomUUID()
	});
	if (remoteip) body.set('remoteip', remoteip);
	let response: Response;
	try {
		response = await fetchFn(SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS)
		});
	} catch (e) {
		const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
		return { ok: false, reason: timedOut ? 'timeout' : 'network' };
	}
	if (!response.ok) return { ok: false, reason: 'status' };
	let answer: SiteverifyAnswer;
	try {
		answer = (await response.json()) as SiteverifyAnswer;
	} catch {
		return { ok: false, reason: 'non_json' };
	}
	if (typeof answer !== 'object' || answer === null || answer.success !== true)
		return { ok: false, reason: 'failed' };
	if (answer.action !== expected.action) return { ok: false, reason: 'action' };
	if (answer.hostname !== expected.hostname) return { ok: false, reason: 'hostname' };
	return { ok: true };
}

/** The route ids whose CSP admits the widget (and whose actions run the check). */
export const TURNSTILE_ROUTE_IDS: ReadonlySet<string> = new Set([
	'/(auth)/masuk',
	'/(auth)/daftar'
]);

/**
 * The response CSP of an auth page with `https://challenges.cloudflare.com` added to `script-src` and
 * `frame-src` (added as `'self'` plus the origin when the policy had no `frame-src`, so the fallback to
 * `default-src` is not loosened). Every other directive is kept byte for byte.
 */
export function withTurnstileCsp(header: string): string {
	const directives = header
		.split(';')
		.map((d) => d.trim())
		.filter(Boolean);
	const add = (name: string, fallback: string) => {
		const index = directives.findIndex((d) => d === name || d.startsWith(`${name} `));
		if (index === -1) directives.push(`${name} ${fallback} ${TURNSTILE_ORIGIN}`);
		else if (!directives[index]!.includes(TURNSTILE_ORIGIN))
			directives[index] = `${directives[index]} ${TURNSTILE_ORIGIN}`;
	};
	add('script-src', "'self'");
	add('frame-src', "'self'");
	return directives.join('; ');
}
