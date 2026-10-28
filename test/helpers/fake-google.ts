import PostalMime from 'postal-mime';
import { base64urlEncode } from '#lib/shared/base64url';
import { GMAIL_SCOPE } from '#lib/server/gmail/google';
import { fixtureText } from './mail';

/**
 * FN-19 Gmail test double: a fake `fetch` answering Google's OAuth token and revoke endpoints and the Gmail API
 * (`profile`, `messages.list`, `messages.get`) from in-memory state. No test reaches Google. Every call is
 * recorded (endpoint, URL, body) so tests can assert what was sent and that `attachments.get` is never called.
 * Fixtures are FICTIONAL (src/lib/shared/inbound/fixtures): a mocked capture never counts as verified.
 */

export type Endpoint = 'exchange' | 'refresh' | 'revoke' | 'profile' | 'list' | 'get' | 'other';

interface FakeCall {
	endpoint: Endpoint;
	url: string;
	body: string;
	authorization: string | null;
}

export function fakeGoogle() {
	const state = {
		calls: [] as FakeCall[],
		/** Gmail id → `messages.get` answer. */
		messages: new Map<string, unknown>(),
		/** The ids `messages.list` returns (default: every message, in insertion order). */
		listIds: null as string[] | null,
		exchange: {
			status: 200,
			body: {
				access_token: 'ya29.access-from-code',
				expires_in: 3599,
				refresh_token: '1//refresh-token-secret',
				scope: GMAIL_SCOPE,
				token_type: 'Bearer'
			} as Record<string, unknown>
		},
		refresh: { status: 200, body: { access_token: 'ya29.access-refreshed', expires_in: 3599 } } as {
			status: number;
			body: Record<string, unknown>;
		},
		revokeStatus: 200,
		revokeBody: '{}',
		profile: 'pemilik@gmail.example',
		/** Status answered by `messages.list` (200 = normal). */
		listStatus: 200,
		listBody: null as unknown,
		/** Gmail id → status answered by `messages.get` instead of the message. */
		getStatus: new Map<string, { status: number; body?: unknown }>(),
		/** When set, `messages.get` waits for it (a slow Google). */
		getGate: null as Promise<void> | null,
		/** Statuses answered by the next Gmail API calls, in order (then normal again). */
		apiQueue: [] as { status: number; body?: unknown }[]
	};

	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body ?? {}), {
			status,
			headers: { 'content-type': 'application/json' }
		});

	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const body = typeof init?.body === 'string' ? init.body : '';
		const headers = new Headers(init?.headers);
		const record = (endpoint: Endpoint) =>
			state.calls.push({
				endpoint,
				url: url.toString(),
				body,
				authorization: headers.get('authorization')
			});
		if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
			const grant = new URLSearchParams(body).get('grant_type');
			if (grant === 'refresh_token') {
				record('refresh');
				return json(state.refresh.status, state.refresh.body);
			}
			record('exchange');
			return json(state.exchange.status, state.exchange.body);
		}
		if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/revoke') {
			record('revoke');
			return new Response(state.revokeBody, { status: state.revokeStatus });
		}
		if (url.origin === 'https://gmail.googleapis.com') {
			const path = url.pathname.replace('/gmail/v1/users/me', '');
			const queued = state.apiQueue.shift();
			if (path === '/profile') {
				record('profile');
				return queued
					? json(queued.status, queued.body)
					: json(200, { emailAddress: state.profile });
			}
			if (path === '/messages') {
				record('list');
				if (queued) return json(queued.status, queued.body);
				if (state.listStatus !== 200) return json(state.listStatus, state.listBody);
				const ids = state.listIds ?? [...state.messages.keys()];
				const size = Number(url.searchParams.get('maxResults') ?? '100');
				const from = Number(url.searchParams.get('pageToken') ?? '0');
				const page = ids.slice(from, from + size);
				return json(200, {
					messages: page.map((id) => ({ id, threadId: `t-${id}` })),
					...(from + size < ids.length ? { nextPageToken: String(from + size) } : {}),
					resultSizeEstimate: ids.length
				});
			}
			const get = /^\/messages\/([^/]+)$/.exec(path);
			if (get) {
				record('get');
				if (state.getGate) await state.getGate;
				if (queued) return json(queued.status, queued.body);
				const id = get[1] as string;
				const failure = state.getStatus.get(id);
				if (failure) return json(failure.status, failure.body);
				const message = state.messages.get(id);
				return message ? json(200, message) : json(404, { error: { code: 404 } });
			}
		}
		record('other');
		return json(404, {});
	}) as typeof fetch;

	return {
		state,
		fetchFn,
		count: (endpoint: Endpoint) => state.calls.filter((c) => c.endpoint === endpoint).length
	};
}
export type FakeGoogle = ReturnType<typeof fakeGoogle>;

const b64 = (text: string) => base64urlEncode(new TextEncoder().encode(text));

/**
 * A forwarding fixture as Gmail's `messages.get` (format=full) would answer it: the same headers (topmost
 * first), the plain and HTML parts in a multipart/alternative, `internalDate` from the Date header.
 */
export async function gmailFromFixture(
	name: string,
	id: string,
	options: { labelIds?: string[]; to?: string; authResults?: string | null } = {}
): Promise<Record<string, unknown>> {
	const mail = await PostalMime.parse(fixtureText(name, options.to ?? 'pemilik@gmail.example'));
	let headers = mail.headers.map((h) => ({ name: h.originalKey ?? h.key, value: h.value }));
	if (options.authResults !== undefined) {
		headers = headers.filter((h) => h.name.toLowerCase() !== 'authentication-results');
		if (options.authResults !== null)
			headers.unshift({ name: 'Authentication-Results', value: options.authResults });
	}
	const parts: Record<string, unknown>[] = [];
	if (mail.text !== undefined)
		parts.push({
			partId: '0',
			mimeType: 'text/plain',
			filename: '',
			headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
			body: { size: mail.text.length, data: b64(mail.text) }
		});
	if (mail.html !== undefined)
		parts.push({
			partId: '1',
			mimeType: 'text/html',
			filename: '',
			headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
			body: { size: mail.html.length, data: b64(mail.html) }
		});
	const date = mail.date ? Date.parse(mail.date) : Date.now();
	return {
		id,
		threadId: `t-${id}`,
		labelIds: options.labelIds ?? ['INBOX', 'CATEGORY_UPDATES'],
		snippet: '',
		internalDate: String(Number.isFinite(date) ? date : Date.now()),
		payload: {
			partId: '',
			mimeType: 'multipart/alternative',
			filename: '',
			headers,
			body: { size: 0 },
			parts
		}
	};
}

/** A plain-text Gmail message built from parts (for vectors no fixture covers). */
export function gmailMessage(input: {
	id: string;
	from: string;
	subject: string;
	text: string;
	messageId?: string | null;
	labelIds?: string[];
	internalDate?: number;
	attachments?: { filename: string; text: string }[];
	/** `Authentication-Results` values, topmost first (prepended above the other headers). */
	authResults?: string[];
}): Record<string, unknown> {
	const headers = [
		...(input.authResults ?? []).map((value) => ({ name: 'Authentication-Results', value })),
		{ name: 'From', value: input.from },
		{ name: 'Subject', value: input.subject },
		{ name: 'Date', value: new Date(input.internalDate ?? Date.now()).toUTCString() }
	];
	if (input.messageId !== null)
		headers.push({ name: 'Message-ID', value: input.messageId ?? `<${input.id}@contoh.example>` });
	return {
		id: input.id,
		threadId: `t-${input.id}`,
		labelIds: input.labelIds ?? ['INBOX'],
		internalDate: String(input.internalDate ?? Date.now()),
		payload: {
			mimeType: 'multipart/mixed',
			filename: '',
			headers,
			body: { size: 0 },
			parts: [
				{
					mimeType: 'text/plain',
					filename: '',
					headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
					body: { size: input.text.length, data: b64(input.text) }
				},
				...(input.attachments ?? []).map((a, i) => ({
					mimeType: 'text/plain',
					filename: a.filename,
					headers: [],
					body: { size: a.text.length, data: b64(a.text), attachmentId: `att-${i}` }
				}))
			]
		}
	};
}
