/**
 * An in-memory stand-in for a KV namespace (only `get(key, 'text')` and `put`), recording each put's options.
 * `failing` makes every call throw, as during a KV outage.
 */
export function fakeKv() {
	const store = new Map<string, string>();
	const puts: { key: string; ttl: number | undefined }[] = [];
	const state = { failing: false };
	const kv = {
		async get(key: string) {
			if (state.failing) throw new Error('KV unavailable');
			return store.get(key) ?? null;
		},
		async put(key: string, value: string, opts?: { expirationTtl?: number }) {
			if (state.failing) throw new Error('KV unavailable');
			store.set(key, value);
			puts.push({ key, ttl: opts?.expirationTtl });
		}
	} as unknown as KVNamespace;
	return { kv, store, puts, state };
}

/** A fetch stub: answers by URL from `routes` (a Response or a function), records every URL asked for. */
export function stubFetch(routes: Record<string, () => Response | Promise<Response>>): {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		fetch: async (url: string) => {
			calls.push(url);
			const route = routes[url];
			if (!route) throw new TypeError(`unexpected fetch ${url}`);
			return route();
		}
	};
}

export const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init
	});
