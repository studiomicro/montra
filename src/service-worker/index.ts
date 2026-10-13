/**
 * MONTRA service worker (FN-13): a read-only offline shell and Web Push display.
 *
 * - install: caches the build's files and the static folder (manifest, icons, offline page) under one cache
 *   named after the build `version`; a first install then activates at once, while an update (an older worker
 *   is active) waits until a page posts SKIP_WAITING ("Muat ulang sekarang", FN-42; src/lib/shared/sw-update.ts);
 * - activate: deletes every other cache and takes control of the open pages;
 * - fetch: shell files cache-first; page loads network-only with the offline page as the fallback when the
 *   network fails; everything else (pages, `__data.json`, `/api/*`) untouched and never stored
 *   (rules in src/lib/shared/sw-policy.ts);
 * - push / notificationclick: shows the decrypted payload, opens its in-app path on tap.
 *
 * Registered by src/lib/ui/pwa/update.svelte.ts (started from src/routes/+layout.svelte) from bundled code
 * (never under `vite dev`), so the CSP needs no change. Sign-out answers with `Clear-Site-Data`, which removes this worker and its cache altogether.
 */
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { self } from '$app/service-worker';
import { parsePushPayload } from '../lib/shared/push.ts';
import { OFFLINE_PAGE, requestPolicy, shellPaths } from '../lib/shared/sw-policy.ts';
import { isSkipWaitingMessage, skipWaitingOnInstall } from '../lib/shared/sw-update.ts';

const CACHE = `shell-${version}`;
const SHELL = shellPaths(immutable, assets);
const SHELL_SET = new Set(SHELL);

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(SHELL);
			if (skipWaitingOnInstall(self.registration.active !== null)) await self.skipWaiting();
		})()
	);
});

// FN-42: the waiting update takes over only when the person asks for it (src/lib/ui/pwa/update.svelte.ts).
self.addEventListener('message', (event) => {
	if (isSkipWaitingMessage(event.data)) event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
			await self.clients.claim();
		})()
	);
});

async function fromShell(request: Request): Promise<Response> {
	const cached = await caches.match(request, { cacheName: CACHE });
	return cached ?? fetch(request);
}

async function navigate(request: Request): Promise<Response> {
	try {
		return await fetch(request);
	} catch {
		const offline = await caches.match(OFFLINE_PAGE, { cacheName: CACHE });
		return offline ?? Response.error();
	}
}

self.addEventListener('fetch', (event) => {
	const policy = requestPolicy(event.request, self.location.origin, SHELL_SET);
	if (policy === 'shell') event.respondWith(fromShell(event.request));
	else if (policy === 'navigate') event.respondWith(navigate(event.request));
	// 'network': not intercepted, so the browser handles it and nothing is stored.
});

self.addEventListener('push', (event) => {
	const payload = event.data ? parsePushPayload(event.data.text()) : null;
	if (!payload) return;
	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			icon: '/icons/icon-192.png',
			badge: '/icons/icon-192.png',
			data: { url: payload.url }
		})
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const data = event.notification.data as { url?: unknown } | null;
	const path = typeof data?.url === 'string' && data.url.startsWith('/') ? data.url : '/';
	const target = new URL(path, self.location.origin);
	if (target.origin !== self.location.origin) return;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			for (const client of windows) {
				if (new URL(client.url).origin === target.origin && 'focus' in client) {
					await client.focus();
					await client.navigate(target.href);
					return;
				}
			}
			await self.clients.openWindow(target.href);
		})()
	);
});
