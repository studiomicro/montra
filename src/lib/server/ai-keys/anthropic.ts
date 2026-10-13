import type { AiKeyTestOutcome } from '#lib/shared/ai-keys';

/**
 * "Tes koneksi" (FN-41): one minimal Messages API call with the user's own key, through the app's Cloudflare AI
 * Gateway (`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic/v1/messages`). The key travels in
 * the request's own `x-api-key` header, which the gateway forwards to Anthropic as it is, so the user's Anthropic
 * account is what is billed, never one of the owner's (there is no app-wide key). The only provider call of
 * FN-41; later AI features reuse `classifyAnthropicResponse`, not the test prompt.
 *
 * Nothing here logs, and neither the key nor the provider's response body leaves this module: the caller gets
 * one of four outcomes. Tests inject `fetchFn`; no automated test calls the real gateway or Anthropic.
 */

export interface AiGatewayEnv {
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_ID?: string;
}

/** A Cloudflare account id or gateway id as it may appear in the URL path (no `/`, `?`, `.` or `%`). */
const GATEWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The Anthropic API version header every Messages call names. */
export const ANTHROPIC_VERSION = '2023-06-01';
/**
 * The model of the one-token test call: the small current Claude 5 model. Model ids are retired over time —
 * re-check Anthropic's model list (docs.anthropic.com › Models) when changing this; a retired id shows the
 * `model_unavailable` outcome, never "invalid key".
 */
export const ANTHROPIC_TEST_MODEL = 'claude-haiku-5-5';
/** "every AI call … has a timeout" (engineering checklist › Cost). */
export const ANTHROPIC_TEST_TIMEOUT_MS = 10_000;
/** Most bytes of an error body read to classify it (Anthropic's error bodies are a few hundred bytes). */
const ERROR_BODY_MAX_BYTES = 4096;

/** The gateway's Anthropic base URL, or null when either id is unset or malformed. */
export function anthropicGatewayUrl(env: AiGatewayEnv | undefined): string | null {
	const account = env?.AI_GATEWAY_ACCOUNT_ID?.trim() ?? '';
	const gateway = env?.AI_GATEWAY_ID?.trim() ?? '';
	if (!GATEWAY_ID.test(account) || !GATEWAY_ID.test(gateway)) return null;
	return `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/anthropic`;
}

export function isAiGatewayConfigured(env: AiGatewayEnv | undefined): boolean {
	return anthropicGatewayUrl(env) !== null;
}

/** At most `max` bytes of a response body as text; '' when it cannot be read (also used by FN-15). */
export async function cappedText(response: Response, max: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < max) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} catch {
		return '';
	} finally {
		reader.cancel().catch(() => {});
	}
	const all = new Uint8Array(Math.min(size, max));
	let at = 0;
	for (const c of chunks) {
		const part = c.subarray(0, all.length - at);
		all.set(part, at);
		at += part.length;
	}
	return new TextDecoder().decode(all);
}

/** Anthropic's error type (`{"type":"error","error":{"type":…}}`), 'gateway' for a Cloudflare error body, or null. */
function errorType(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (typeof parsed !== 'object' || parsed === null) return null;
		const error = (parsed as { error?: unknown }).error;
		if (typeof error === 'object' && error !== null) {
			const type = (error as { type?: unknown }).type;
			return typeof type === 'string' ? type : null;
		}
		return Array.isArray((parsed as { errors?: unknown }).errors) ? 'gateway' : null;
	} catch {
		return null;
	}
}

/**
 * One of the four outcomes for a provider answer (never conflated):
 * - 2xx → ok;
 * - 401/403 from Anthropic → invalid (a Cloudflare-shaped error body means the gateway refused, not the key);
 * - 429, 402, or a `billing_error`/`rate_limit_error` body → quota (the user's own Anthropic account status);
 * - 404 or a `not_found_error` body → model_unavailable (the test model is gone; Anthropic authenticates first,
 *   so the key was accepted, but nothing is stored about it);
 * - anything else (5xx, 529 overloaded, an unexpected 4xx) → network: nothing is known about the key.
 */
export function classifyAnthropicResponse(status: number, body: string): AiKeyTestOutcome {
	if (status >= 200 && status < 300) return 'ok';
	const type = errorType(body);
	if (type === 'billing_error' || type === 'rate_limit_error') return 'quota';
	if (status === 429 || status === 402) return 'quota';
	if (status === 401 || status === 403) return type === 'gateway' ? 'network' : 'invalid';
	if (type === 'authentication_error' || type === 'permission_error') return 'invalid';
	if (type === 'not_found_error' || (status === 404 && type !== 'gateway'))
		return 'model_unavailable';
	return 'network';
}

/**
 * Tests `rawKey` with one Messages call (one output token) through the gateway; null when the gateway is not
 * configured (the caller shows "Belum dikonfigurasi" and never gets here). A timeout or a failed fetch is
 * `network`.
 */
export async function testAnthropicKey(
	env: AiGatewayEnv | undefined,
	rawKey: string,
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = ANTHROPIC_TEST_TIMEOUT_MS
): Promise<AiKeyTestOutcome | null> {
	const base = anthropicGatewayUrl(env);
	if (!base) return null;
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetchFn(`${base}/v1/messages`, {
			method: 'POST',
			headers: {
				'x-api-key': rawKey,
				'anthropic-version': ANTHROPIC_VERSION,
				'content-type': 'application/json',
				// AI Gateway request headers (developers.cloudflare.com/ai-gateway › Caching, › Logging): the body is
				// the same for every user, so a cached answer would test someone else's key; and the test is kept
				// out of the owner's gateway logs.
				'cf-aig-skip-cache': 'true',
				'cf-aig-collect-log': 'false'
			},
			body: JSON.stringify({
				model: ANTHROPIC_TEST_MODEL,
				max_tokens: 1,
				messages: [{ role: 'user', content: 'ping' }]
			}),
			redirect: 'manual',
			signal
		});
		if (response.ok) {
			await response.body?.cancel().catch(() => {});
			return 'ok';
		}
		return classifyAnthropicResponse(
			response.status,
			await cappedText(response, ERROR_BODY_MAX_BYTES)
		);
	} catch {
		return 'network';
	}
}
