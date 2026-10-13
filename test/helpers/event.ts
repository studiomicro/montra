import type { Cookies, RequestEvent } from '@sveltejs/kit';
import type { Db } from '#lib/server/db';

/** A cookie jar standing in for SvelteKit's `Cookies`: records what a handler set or deleted. */
export function fakeCookies(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	const written = new Map<string, { value: string; options: Record<string, unknown> }>();
	const serialize = (name: string, value: string, options: Record<string, unknown>) =>
		`${name}=${value}; ${Object.entries(options)
			.map(([k, v]) => `${k}=${String(v)}`)
			.join('; ')}`;
	const cookies = {
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string, options: Record<string, unknown>) => {
			jar.set(name, value);
			written.set(name, { value, options });
		},
		delete: (name: string, options: Record<string, unknown>) => {
			jar.delete(name);
			written.set(name, { value: '', options });
		},
		serialize
	} as unknown as Cookies;
	return { cookies, written, jar };
}

export interface FakeEventInit {
	url: string;
	method?: string;
	routeId?: string | null;
	/** Form fields; pairs allow one name several times (checkbox lists). */
	form?: Record<string, string> | [string, string][];
	headers?: Record<string, string>;
	cookies?: Record<string, string>;
	db: Db;
	user?: App.Locals['user'];
	sessionToken?: string | null;
	space?: App.Locals['space'];
	plan?: App.Locals['plan'];
	params?: Record<string, string>;
	isDataRequest?: boolean;
	/** Cloudflare's `request.cf` (absent unless given, as under local dev without the edge). */
	cf?: Record<string, unknown>;
	/** The UI language (hooks.server.ts sets it from the `lang` cookie); Indonesian when not given. */
	locale?: 'id' | 'en';
}

/** A minimal RequestEvent for calling hooks, loads and actions directly in Vitest. */
export function fakeEvent(init: FakeEventInit) {
	const url = new URL(init.url);
	const method = init.method ?? (init.form ? 'POST' : 'GET');
	const headers = new Headers(init.headers);
	let body: string | undefined;
	if (init.form) {
		body = new URLSearchParams(init.form).toString();
		if (!headers.has('content-type'))
			headers.set('content-type', 'application/x-www-form-urlencoded');
	}
	const { cookies, written, jar } = fakeCookies(init.cookies);
	const locals = {
		locale: init.locale ?? 'id',
		theme: 'system',
		plan: init.plan ?? 'gratis',
		db: init.db,
		user: init.user ?? null,
		sessionToken: init.sessionToken ?? null,
		space: init.space ?? null,
		secure: false
	} as App.Locals;
	const request = new Request(url, { method, headers, body });
	if (init.cf) Object.defineProperty(request, 'cf', { value: init.cf });
	const event = {
		url,
		request,
		route: { id: init.routeId ?? null },
		params: init.params ?? {},
		locals,
		cookies,
		isDataRequest: init.isDataRequest ?? false,
		isSubRequest: false,
		setHeaders: () => {},
		getClientAddress: () => '127.0.0.1',
		fetch
	} as unknown as RequestEvent;
	return { event, written, jar, locals };
}
