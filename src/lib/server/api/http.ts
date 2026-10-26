import { isHttpError, json, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import type { z } from 'zod';
import { API_REQUESTS_PER_WINDOW } from '#lib/shared/api-tokens';
import { createTranslator } from '#lib/shared/i18n';
import { resolveApiToken, type ApiCaller } from '../auth/api-tokens';
import { overAttemptLimit, overTokenAttemptLimit, THROTTLE_WINDOW_MS } from '../auth/throttle';
import type { Db } from '../db';
import { readRawBody } from '../forms';
import { requireSpaceAccess, type SpaceAccess, type SpaceScope } from '../spaces/access';
import { errorLabel } from '../util';
import type { ApiEndpoint } from './endpoints';
import type { ApiErrorBody, ApiErrorCode } from './schemas';

/**
 * FN-38: how every public-API route authenticates and answers. Authenticated by a Bearer token only — the
 * `Authorization` header resolved through `resolveApiToken` — never by a session: `locals.user`, `locals.space`
 * and every cookie are never read here (the hook may have filled `locals.user` from a cookie; it is ignored), so
 * a request with only a session cookie gets the same 401 as one with nothing. Conversely no `(app)` route and
 * no other `/api/v1` route reads the `Authorization` header, so a token works nowhere else.
 *
 * Checked in this order, each before the next touches anything:
 * 1. `Authorization: Bearer <token>` of a live token of an active user (401, one fixed body for every reason).
 *    The token is looked up first (constant work, see `resolveApiToken`); only a request without a valid token
 *    counts one failure against its client (an IPv6 client by its /64), and once a client is past
 *    API_AUTH_FAILURES_PER_WINDOW such requests get 429 + Retry-After instead of 401. Tokens are 256 random
 *    bits, so guessing is infeasible anyway; the budget only bounds the lookup load.
 * 2. The token's own budget, API_REQUESTS_PER_WINDOW per THROTTLE_WINDOW_MS (429 + Retry-After; fails closed).
 * 3. The route's scope: a `read` token on a write route gets 403 before any data is read or written.
 * 4. The query against the route's schema (400), then `space_id`: outside the token's restriction, or not a
 *    live membership (`requireSpaceAccess`), the same fixed 404.
 * 5. A body route: `application/json` (415) within API_BODY_MAX_BYTES (413), parseable (400), of the route's
 *    schema (400).
 * Every answer is JSON with `cache-control: no-store`; an error is `{ error: { code, message, fields? } }` and
 * never holds a path, SQL text or a stack (an unexpected failure is logged with `errorLabel` only).
 */

/** Requests without a valid token one client may send per throttle window before it gets 429. */
export const API_AUTH_FAILURES_PER_WINDOW = 20;

/** Largest request body: one transaction's fields are a few hundred bytes. */
const API_BODY_MAX_BYTES = 8 * 1024;

const en = createTranslator('en');
const NO_STORE = { 'cache-control': 'no-store' };

/** A refusal a handler throws; `apiRoute` answers it in the fixed error shape. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiErrorCode,
		message: string,
		readonly fields?: Record<string, string>,
		readonly headers: Record<string, string> = {}
	) {
		super(message);
	}
}

function errorResponse(e: ApiError): Response {
	const body: ApiErrorBody = {
		error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}) }
	};
	return json(body, { status: e.status, headers: { ...NO_STORE, ...e.headers } });
}

const UNAUTHORIZED = () =>
	new ApiError(401, 'unauthorized', 'A valid API token is required.', undefined, {
		'www-authenticate': 'Bearer realm="montra"'
	});
export const NOT_FOUND = () => new ApiError(404, 'not_found', 'Not found');

/** `walletId` → `wallet_id`: the API's field names for a form's field errors. */
const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * A form's field errors (msg() phrases from transactions/validation.ts) as the API's 400: the same messages,
 * in English, keyed by the API's field names. `message` is the first one.
 */
export function validationError(errors: Partial<Record<string, string>>): ApiError {
	const fields: Record<string, string> = {};
	for (const [name, phrase] of Object.entries(errors))
		if (typeof phrase === 'string')
			fields[name === 'amountMinor' ? 'amount_minor' : snake(name)] = en.tr(phrase);
	const first = Object.values(fields)[0] ?? 'Invalid request.';
	return new ApiError(400, 'validation_failed', first, fields);
}

/**
 * zod issues as field errors keyed by their top-level name (JSON types and query shapes only): `Required.`
 * when `input` (the parsed query or body) has no such own field, else `Invalid value.`.
 */
function issueFields(issues: readonly z.core.$ZodIssue[], input: unknown): Record<string, string> {
	const fields: Record<string, string> = {};
	const given = (key: string) =>
		typeof input === 'object' &&
		input !== null &&
		Object.hasOwn(input, key) &&
		(input as Record<string, unknown>)[key] !== undefined;
	for (const issue of issues) {
		const key = String(issue.path[0] ?? '');
		fields[key] ??= key && !given(key) ? 'Required.' : 'Invalid value.';
	}
	return fields;
}

/** The query's known parameters only (first value of each), so no other key reaches the schema. */
function queryObject(schema: z.ZodObject, params: URLSearchParams): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(schema.shape)) {
		const value = params.get(key);
		if (value !== null) out[key] = value;
	}
	return out;
}

async function readJsonBody(request: Request): Promise<unknown> {
	const type = (request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
	if (type !== 'application/json')
		throw new ApiError(415, 'unsupported_media_type', 'Send the body as application/json.');
	let bytes: Uint8Array;
	try {
		bytes = await readRawBody(request, API_BODY_MAX_BYTES);
	} catch (e) {
		if (isHttpError(e) && e.status === 408)
			throw new ApiError(400, 'invalid_request', 'The request body did not arrive in time.');
		throw new ApiError(413, 'payload_too_large', 'The request body is too large.');
	}
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
	}
}

/** A handler's answer with another status than the route's success status (e.g. 200 for a replayed write). */
export class Answer<T> {
	constructor(
		readonly status: number,
		readonly body: T
	) {}
}

type Infer<T> = T extends z.ZodObject ? z.infer<T> : undefined;

export interface ApiContext<E extends ApiEndpoint> {
	db: Db;
	now: number;
	caller: ApiCaller;
	query: Infer<E['query']>;
	body: Infer<E['body']>;
	/** The admitted space and the scope its writes use; null on a route without `space_id`. */
	access: SpaceAccess | null;
	scope: SpaceScope | null;
	params: Partial<Record<string, string>>;
}

/** The space a route works on, admitted for the token's user (and within its restriction), or the fixed 404. */
async function admitSpace(db: Db, caller: ApiCaller, spaceId: string): Promise<SpaceAccess> {
	if (caller.restrictedSpaceId !== null && caller.restrictedSpaceId !== spaceId) throw NOT_FOUND();
	try {
		return await requireSpaceAccess(db, caller.userId, spaceId);
	} catch (e) {
		if (isHttpError(e) && e.status === 404) throw NOT_FOUND();
		throw e;
	}
}

/**
 * The RequestHandler of one public-API route: the checks above, then `handler`, whose result is sent with
 * the route's success status (a handler may name another, e.g. 200 for an already-applied write).
 */
export function apiRoute<E extends ApiEndpoint>(
	endpoint: E,
	handler: (
		ctx: ApiContext<E>
	) => Promise<z.infer<E['success']['schema']> | Answer<z.infer<E['success']['schema']>>>
): RequestHandler {
	return async (event: RequestEvent) => {
		try {
			const db = event.locals.db;
			const now = Date.now();
			const retryAfter = {
				'retry-after': String(Math.ceil((THROTTLE_WINDOW_MS - (now % THROTTLE_WINDOW_MS)) / 1000))
			};
			const request = event.request;
			const header = request.headers.get('authorization') ?? '';
			const match = /^Bearer ([^\s]+)$/i.exec(header);
			const caller = match ? await resolveApiToken(db, match[1] as string, now) : null;
			if (!caller) {
				// Only a failure counts against the client, and only a failing request is ever refused for it: a
				// valid token keeps working from a shared address however many guesses come from there.
				if (await overAttemptLimit(db, request, now, 'api-auth', API_AUTH_FAILURES_PER_WINDOW))
					throw new ApiError(
						429,
						'rate_limited',
						'Too many failed requests.',
						undefined,
						retryAfter
					);
				throw UNAUTHORIZED();
			}
			if (
				await overTokenAttemptLimit(db, caller.tokenId, now, 'api-request', API_REQUESTS_PER_WINDOW)
			) {
				throw new ApiError(
					429,
					'rate_limited',
					'Too many requests for this token.',
					undefined,
					retryAfter
				);
			}
			if (endpoint.scope === 'read_write' && caller.scope !== 'read_write')
				throw new ApiError(403, 'insufficient_scope', 'This token can only read.');

			let query: unknown = undefined;
			if (endpoint.query) {
				const raw = queryObject(endpoint.query, event.url.searchParams);
				const parsed = endpoint.query.safeParse(raw);
				if (!parsed.success)
					throw new ApiError(
						400,
						'invalid_request',
						'Invalid query parameters.',
						issueFields(parsed.error.issues, raw)
					);
				query = parsed.data;
			}
			const spaceId = (query as { space_id?: string } | undefined)?.space_id;
			const access = spaceId === undefined ? null : await admitSpace(db, caller, spaceId);

			let body: unknown = undefined;
			if (endpoint.body) {
				const raw = await readJsonBody(event.request);
				const parsed = endpoint.body.safeParse(raw);
				if (!parsed.success)
					throw new ApiError(
						400,
						'validation_failed',
						'Invalid request body.',
						issueFields(parsed.error.issues, raw)
					);
				body = parsed.data;
			}

			const result = await handler({
				db,
				now,
				caller,
				query: query as Infer<E['query']>,
				body: body as Infer<E['body']>,
				access,
				scope: access ? { spaceId: access.space.id, userId: caller.userId } : null,
				params: event.params
			});
			return result instanceof Answer
				? json(result.body, { status: result.status, headers: NO_STORE })
				: json(result, { status: endpoint.success.status, headers: NO_STORE });
		} catch (e) {
			if (e instanceof ApiError) return errorResponse(e);
			if (isHttpError(e) && e.status === 404) return errorResponse(NOT_FOUND());
			console.error('api: request failed', endpoint.operationId, errorLabel(e));
			return errorResponse(
				new ApiError(500, 'internal_error', 'Something went wrong. Try again later.')
			);
		}
	};
}
