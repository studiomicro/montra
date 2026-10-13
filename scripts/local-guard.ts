export const LOCAL_STATE_DIR = '.wrangler/state';

const FORBIDDEN = /^(--remote|--preview|--env|-e)(=.*)?$/;

/** Seed and reset only ever touch the local D1. Any flag that could point elsewhere stops the script. */
export function assertLocalOnly(argv: readonly string[]): void {
	const bad = argv.find((a) => FORBIDDEN.test(a));
	if (bad)
		throw new Error(
			`Refusing: "${bad}" is not allowed; this script only touches the local database.`
		);
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A script that drives a running app (FN-13b's screenshot capture) only ever talks to this machine: an http(s)
 * URL whose host is exactly `localhost`, `127.0.0.1` or `[::1]`. Anything else throws; returns the parsed URL.
 */
export function assertLocalBaseUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Refusing: "${raw}" is not a URL.`);
	}
	if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOCAL_HOSTS.has(url.hostname))
		throw new Error(
			`Refusing: ${url.origin} is not a local address; this script only drives localhost.`
		);
	if (url.username || url.password)
		throw new Error('Refusing: a base URL with credentials is not allowed.');
	return url;
}
