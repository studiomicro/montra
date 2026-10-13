/**
 * What the service worker (src/service-worker/index.ts) caches and how it answers each request (FN-13). Pure,
 * so the rules are unit-tested: only the build's own files and the static folder are ever cached; pages,
 * `__data.json` and `/api/*` always go to the network and are never stored, so nothing of one signed-in
 * user can be shown to the next person on a shared device.
 */

/** The static page shown for a navigation while the device is offline. */
export const OFFLINE_PAGE = '/offline.html';

/**
 * The on-device OCR engine (FN-16g, about 20 MB under `/_ocr/<version>/`): downloaded only when someone reads an
 * image, so it is never precached on install and left to the browser's HTTP cache (the folder is immutable).
 */
const isOcrPath = (path: string) => path.startsWith('/_ocr/');

/**
 * Fonts (owner decision 2026-10-10): only the one file `app.html` preloads, Geist (about 70 KB), is precached, so
 * the shell and the offline page keep the typeface offline. Geist Mono (code samples on a few settings pages),
 * the licence texts and any later version stay with the browser's immutable HTTP cache (`_headers`).
 */
const SHELL_FONT = '/fonts/geist/1.7.2/Geist-Variable.woff2';
const isOtherFontPath = (path: string) => path.startsWith('/fonts/') && path !== SHELL_FONT;

/** True for a path that may carry a person's data: never cached. */
function isDataPath(path: string): boolean {
	return path.startsWith('/api/') || path.endsWith('/__data.json') || path === '/__data.json';
}

/**
 * Static folders the browser or the OS asks for by itself (iOS launch images, Chrome's install-dialog
 * screenshots, FN-13b): large, and only one per device, so they are served from the network and never
 * downloaded by every visitor on install.
 */
const NETWORK_ONLY_DIRS = ['/splash/', '/screenshots/'] as const;

/**
 * The absolute paths the service worker caches on install: the build's immutable files and the static
 * folder (`$app/manifest` `immutable` and `assets`, relative to the base path), minus any data path, the
 * launch-image and screenshot folders, the OCR engine and every font but Geist.
 */
export function shellPaths(
	immutable: readonly { path: string }[],
	assets: readonly { path: string }[]
): string[] {
	const paths = [...immutable, ...assets].map(({ path }) =>
		path.startsWith('/') ? path : `/${path}`
	);
	return [...new Set(paths)].filter(
		(p) =>
			!isDataPath(p) &&
			!isOcrPath(p) &&
			!isOtherFontPath(p) &&
			!NETWORK_ONLY_DIRS.some((dir) => p.startsWith(dir))
	);
}

export type RequestPolicy =
	/** A cached shell file: cache first, network if missing. */
	| 'shell'
	/** A page load: network only; the offline page when the network fails. Never cached. */
	| 'navigate'
	/** Anything else: left to the browser, never cached. */
	| 'network';

export function requestPolicy(
	request: { method: string; url: string; mode: string },
	origin: string,
	shell: ReadonlySet<string>
): RequestPolicy {
	if (request.method !== 'GET') return 'network';
	const url = new URL(request.url);
	if (url.origin !== origin) return 'network';
	if (request.mode === 'navigate') return 'navigate';
	if (isOcrPath(url.pathname)) return 'network';
	if (url.search === '' && shell.has(url.pathname) && !isDataPath(url.pathname)) return 'shell';
	return 'network';
}
