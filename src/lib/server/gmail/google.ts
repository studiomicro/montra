import { z } from 'zod';

/**
 * The only module that calls Google (FN-19 Gmail PRD § 3, 5, 7, 8). Every call has a timeout, `redirect:
 * 'manual'` (a redirect is a failure, never followed), a capped response read and a zod-checked answer; every
 * failure is a fixed code, never Google's error text (which must not reach a page or a log). Tokens travel only in
 * request bodies and the Authorization header, never in a URL. Tests inject `fetchFn`; nothing here logs.
 *
 * Endpoints and limits from Google's docs (re-checked 2026-10-10): OAuth 2.0 for web server apps (token and
 * revoke endpoints, `invalid_grant`), Gmail API reference (`users.messages.list` maxResults ≤ 500,
 * `users.messages.get` format=full, `users.getProfile` allowed under `gmail.readonly`), Gmail error handling (401,
 * 403 rate reasons, 429, 5xx).
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export const OAUTH_TIMEOUT_MS = 10_000;
export const GMAIL_TIMEOUT_MS = 15_000;
/** `messages.get` answers above this are `too_large` (a payment notification is far smaller). */
export const MESSAGE_MAX_BYTES = 2 * 1024 * 1024;
const SMALL_MAX_BYTES = 64 * 1024;

/**
 * - `auth`: 401 (refresh the access token once, then retry);
 * - `invalid_grant`: the refresh token is expired or revoked (reconnect);
 * - `rate`: 429 or 403 rateLimitExceeded/userRateLimitExceeded (back off);
 * - `server`: 5xx, a network failure or a timeout (back off);
 * - `forbidden`: any other refusal (that one mail or call is given up);
 * - `gone`: 404; `too_large`: the answer passed its cap; `malformed`: it did not fit the expected shape.
 */
export type GoogleFailure =
	'auth' | 'invalid_grant' | 'rate' | 'server' | 'forbidden' | 'gone' | 'too_large' | 'malformed';

export type GoogleResult<T> = ({ ok: true } & T) | { ok: false; error: GoogleFailure };

/** The body read to at most `max` bytes; null when it is longer (the rest is never read). */
async function readCapped(response: Response, max: number): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > max) return null;
			chunks.push(value);
		}
	} finally {
		reader.cancel().catch(() => {});
	}
	const all = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		all.set(c, at);
		at += c.byteLength;
	}
	return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(all);
}

const RATE_REASONS = new Set(['ratelimitexceeded', 'userratelimitexceeded']);

/** A Gmail API error status → its failure code (the body is read only for a 403's reason). */
function apiFailure(status: number, body: string | null): GoogleFailure {
	if (status === 401) return 'auth';
	if (status === 429) return 'rate';
	if (status === 404) return 'gone';
	if (status >= 500) return 'server';
	if (status === 403) {
		try {
			const json = JSON.parse(body ?? '') as {
				error?: { errors?: { reason?: unknown }[]; status?: unknown };
			};
			const reasons = (json.error?.errors ?? []).map((e) => String(e.reason ?? '').toLowerCase());
			if (reasons.some((r) => RATE_REASONS.has(r))) return 'rate';
		} catch {
			// An unreadable 403 is a plain refusal.
		}
	}
	return 'forbidden';
}

const tokenAnswer = z.object({
	access_token: z.string().min(1).max(4096),
	expires_in: z.number().int().positive().max(86_400).optional(),
	refresh_token: z.string().min(1).max(4000).optional(),
	scope: z.string().max(2000).optional()
});
const oauthError = z.object({ error: z.string().max(100) });
const profileAnswer = z.object({ emailAddress: z.string().min(3).max(320) });
const listAnswer = z.object({
	messages: z
		.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }))
		.max(500)
		.optional(),
	nextPageToken: z.string().min(1).max(512).optional()
});

export interface TokenGrant {
	accessToken: string;
	/** Seconds the access token lives (Google's default 3,599 when not given). */
	expiresIn: number;
	refreshToken: string | null;
	scope: string;
}

export function googleClient(fetchFn: typeof fetch = fetch) {
	async function call(
		url: string,
		init: RequestInit,
		timeoutMs: number,
		max: number
	): Promise<{ status: number; body: string | null } | null> {
		try {
			const response = await fetchFn(url, {
				...init,
				redirect: 'manual',
				signal: AbortSignal.timeout(timeoutMs)
			});
			return { status: response.status, body: await readCapped(response, max) };
		} catch {
			return null;
		}
	}

	/** POST to the token endpoint; Google answers errors as `{ "error": "<code>" }`. */
	async function token(form: Record<string, string>): Promise<GoogleResult<TokenGrant>> {
		const r = await call(
			GOOGLE_TOKEN_URL,
			{
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(form).toString()
			},
			OAUTH_TIMEOUT_MS,
			SMALL_MAX_BYTES
		);
		if (!r) return { ok: false, error: 'server' };
		if (r.body === null) return { ok: false, error: 'too_large' };
		let json: unknown;
		try {
			json = JSON.parse(r.body);
		} catch {
			return { ok: false, error: r.status >= 500 ? 'server' : 'malformed' };
		}
		if (r.status !== 200) {
			if (r.status === 429) return { ok: false, error: 'rate' };
			if (r.status >= 500) return { ok: false, error: 'server' };
			const e = oauthError.safeParse(json);
			return {
				ok: false,
				error: e.success && e.data.error === 'invalid_grant' ? 'invalid_grant' : 'forbidden'
			};
		}
		const parsed = tokenAnswer.safeParse(json);
		if (!parsed.success) return { ok: false, error: 'malformed' };
		return {
			ok: true,
			accessToken: parsed.data.access_token,
			expiresIn: parsed.data.expires_in ?? 3599,
			refreshToken: parsed.data.refresh_token ?? null,
			scope: parsed.data.scope ?? ''
		};
	}

	/** GET on the Gmail API with the access token, capped at `max`. */
	async function api(
		path: string,
		accessToken: string,
		max: number
	): Promise<GoogleResult<{ json: unknown }>> {
		const r = await call(
			`${GMAIL_API_URL}${path}`,
			{ headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } },
			GMAIL_TIMEOUT_MS,
			max
		);
		if (!r) return { ok: false, error: 'server' };
		if (r.status !== 200) return { ok: false, error: apiFailure(r.status, r.body) };
		if (r.body === null) return { ok: false, error: 'too_large' };
		try {
			return { ok: true, json: JSON.parse(r.body) as unknown };
		} catch {
			return { ok: false, error: 'malformed' };
		}
	}

	return {
		/** Authorization code → tokens (PKCE verifier and client secret both sent; PRD § 3). */
		exchangeCode(input: {
			clientId: string;
			clientSecret: string;
			code: string;
			verifier: string;
			redirectUri: string;
		}) {
			return token({
				client_id: input.clientId,
				client_secret: input.clientSecret,
				code: input.code,
				code_verifier: input.verifier,
				grant_type: 'authorization_code',
				redirect_uri: input.redirectUri
			});
		},

		/** Refresh token → a fresh access token. */
		refresh(input: { clientId: string; clientSecret: string; refreshToken: string }) {
			return token({
				client_id: input.clientId,
				client_secret: input.clientSecret,
				refresh_token: input.refreshToken,
				grant_type: 'refresh_token'
			});
		},

		/** Revokes a token (and with it every scope granted to the project): 200, or 400 `invalid_token`, = gone. */
		async revoke(tokenValue: string): Promise<boolean> {
			const r = await call(
				GOOGLE_REVOKE_URL,
				{
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ token: tokenValue }).toString()
				},
				OAUTH_TIMEOUT_MS,
				SMALL_MAX_BYTES
			);
			if (!r) return false;
			if (r.status === 200) return true;
			if (r.status !== 400) return false;
			const e = oauthError.safeParse(
				(() => {
					try {
						return JSON.parse(r.body ?? '') as unknown;
					} catch {
						return null;
					}
				})()
			);
			return e.success && e.data.error === 'invalid_token';
		},

		/** The connected mailbox's address (`users.getProfile`). */
		async profile(accessToken: string): Promise<GoogleResult<{ address: string }>> {
			const r = await api('/profile', accessToken, SMALL_MAX_BYTES);
			if (!r.ok) return r;
			const parsed = profileAnswer.safeParse(r.json);
			return parsed.success
				? { ok: true, address: parsed.data.emailAddress.trim().toLowerCase() }
				: { ok: false, error: 'malformed' };
		},

		/** One page of message ids matching `q` (`maxResults` ≤ 500). */
		async list(
			accessToken: string,
			input: { q: string; pageToken: string | null; maxResults: number }
		): Promise<GoogleResult<{ ids: string[]; nextPageToken: string | null }>> {
			const params = new URLSearchParams({ q: input.q, maxResults: String(input.maxResults) });
			if (input.pageToken) params.set('pageToken', input.pageToken);
			const r = await api(`/messages?${params.toString()}`, accessToken, SMALL_MAX_BYTES * 2);
			if (!r.ok) return r;
			const parsed = listAnswer.safeParse(r.json);
			if (!parsed.success) return { ok: false, error: 'malformed' };
			return {
				ok: true,
				ids: (parsed.data.messages ?? []).map((m) => m.id),
				nextPageToken: parsed.data.nextPageToken ?? null
			};
		},

		/** One message in `format=full` (headers and body parts; attachments only by id, never fetched). */
		get(accessToken: string, gmailId: string): Promise<GoogleResult<{ json: unknown }>> {
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(gmailId))
				return Promise.resolve({ ok: false, error: 'malformed' });
			return api(`/messages/${gmailId}?format=full`, accessToken, MESSAGE_MAX_BYTES);
		}
	};
}

export type GoogleClient = ReturnType<typeof googleClient>;
