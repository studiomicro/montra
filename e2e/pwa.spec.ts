import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { pngSize } from '../scripts/png.ts';
import { splashMedia } from '../src/lib/shared/splash';
import { SPLASH_SCREENS } from '../src/lib/shared/splash-screens';
import {
	tickSignUpBoxes,
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	SIGNED_OUT,
	SITE_ORIGIN,
	simulatedClientIp,
	STORAGE_STATE,
	waitForHydration
} from './helpers';
import { addWallet, freshUser, ids, postExpense } from './ledger';
import { PUSH, queueOneBlocked, queueSize } from './offline-queue';

/** FN-13: manifest, service worker (offline shell only), sign-out cache hygiene, install guide, push state. */

const PASSWORD = 'terang-benderang-8';

/** Waits until the service worker is active and controls this page; returns its script URL. */
async function serviceWorkerReady(page: Page): Promise<string> {
	return page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise((r) =>
				navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
			);
		return reg.active?.scriptURL ?? '';
	});
}

/**
 * Right after sign-out the browser may still be applying `Clear-Site-Data: "storage"`, which can unregister a
 * worker the next page just registered; a later page load registers it again. Reload until one controls the page.
 */
async function serviceWorkerReadyAfterClear(page: Page): Promise<void> {
	await expect
		.poll(
			async () => {
				await page.reload();
				return page.evaluate(() =>
					Promise.race([
						navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller),
						new Promise<boolean>((r) => setTimeout(() => r(false), 3000))
					])
				);
			},
			{ timeout: 25_000, intervals: [0] }
		)
		.toBe(true);
}

/** Every cached request path, with the content type of its cached response. */
async function cachedEntries(page: Page): Promise<{ path: string; type: string }[]> {
	return page.evaluate(async () => {
		const out: { path: string; type: string }[] = [];
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			for (const request of await cache.keys()) {
				const response = await cache.match(request);
				out.push({
					path: new URL(request.url).pathname,
					type: response?.headers.get('content-type') ?? ''
				});
			}
		}
		return out;
	});
}

/** Only build files and static assets: no page, no page data, no API answer. */
function expectOnlyShell(entries: { path: string; type: string }[]) {
	for (const { path, type } of entries) {
		expect(path.startsWith('/api/'), path).toBe(false);
		expect(path.endsWith('__data.json'), path).toBe(false);
		if (type.startsWith('text/html')) expect(path, `HTML cached at ${path}`).toBe('/offline.html');
	}
}

test.describe('manifest and service worker (signed out)', () => {
	test.use({ storageState: SIGNED_OUT });

	test("HTML pages vary by User-Agent, so a shared cache never serves one browser another browser's page", async ({
		request
	}) => {
		const res = await request.get('/masuk');
		expect(res.headers()['content-type']).toContain('text/html');
		expect(res.headers()['vary']?.toLowerCase()).toContain('user-agent');
	});

	test('the manifest is linked, served as application/manifest+json, and its icons load', async ({
		page,
		request
	}) => {
		await page.goto('/masuk');
		await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
			'href',
			/manifest\.webmanifest$/
		);
		const res = await request.get('/manifest.webmanifest');
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('application/manifest+json');
		const manifest = await res.json();
		expect(manifest).toMatchObject({ display: 'standalone', start_url: '/', scope: '/' });
		expect(
			manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`)
		).toEqual([
			'192x192 any',
			'512x512 any',
			'192x192 maskable',
			'512x512 maskable',
			'512x512 monochrome'
		]);
		for (const icon of manifest.icons) {
			const img = await request.get(icon.src);
			expect(img.status(), icon.src).toBe(200);
			expect(img.headers()['content-type']).toBe('image/png');
			expect(img.headers()['x-content-type-options']).toBe('nosniff');
		}
		expect(res.headers()['x-content-type-options']).toBe('nosniff');
		expect(res.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
	});

	test('the static offline page carries its own security headers (root _headers)', async ({
		request
	}) => {
		const res = await request.get('/offline.html');
		expect(res.status()).toBe(200);
		const h = res.headers();
		expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
		expect(h['content-security-policy']).toContain("script-src 'none'");
		expect(h['x-frame-options']).toBe('DENY');
		expect(h['x-content-type-options']).toBe('nosniff');
		expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
		const sw = await request.get('/service-worker.js');
		expect(sw.headers()['x-content-type-options']).toBe('nosniff');
	});

	test('the service worker registers from bundled code, caches only the shell, no CSP violation', async ({
		page
	}) => {
		const csp = collectCspViolations(page);
		await page.goto('/masuk');
		expect(await serviceWorkerReady(page)).toBe(`${APP_ORIGIN}/service-worker.js`);
		// No inline registration script was added to the HTML.
		expect(await page.content()).not.toContain('serviceWorker.register');
		const entries = await cachedEntries(page);
		const paths = entries.map((e) => e.path);
		expect(paths).toEqual(expect.arrayContaining(['/offline.html', '/icons/icon-192.png']));
		// FN-46: the manifest depends on the account's plan (a server route, private and no-store): never precached.
		expect(paths).not.toContain('/manifest.webmanifest');
		expectOnlyShell(entries);
		// FN-13b: launch images and store screenshots are never precached (the browser asks for them itself).
		expect(paths.filter((p) => p.startsWith('/splash/') || p.startsWith('/screenshots/'))).toEqual(
			[]
		);
		expect(paths).toEqual(
			expect.arrayContaining(['/icons/shortcut-suara.png', '/icons/icon-monochrome-512.png'])
		);
		expect(await page.evaluate(() => caches.keys())).toHaveLength(1);
		expect(csp).toEqual([]);
	});

	test('offline, a page load shows the offline page; online again, the real page', async ({
		page,
		context
	}) => {
		const csp = collectCspViolations(page);
		await page.goto('/masuk');
		await serviceWorkerReady(page);
		await context.setOffline(true);
		await page.goto('/daftar').catch(() => {});
		await expect(page.getByRole('heading', { name: 'Kamu sedang offline.' })).toBeVisible();
		// Served from the cache with its stored CSP: its stylesheet loads, nothing is refused.
		expect(await page.evaluate(() => getComputedStyle(document.body).margin)).toBe('0px');
		expect(csp).toEqual([]);
		await expect(page.getByText('You are offline.')).toBeVisible();
		await context.setOffline(false);
		await page.getByRole('link', { name: 'Coba lagi · Try again' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Buat akun' })).toBeVisible();
	});
});

test.describe('sign-out on a shared device', () => {
	test.use({
		storageState: SIGNED_OUT,
		// eslint-disable-next-line no-empty-pattern
		extraHTTPHeaders: async ({}, use, testInfo) =>
			use({ 'cf-connecting-ip': simulatedClientIp(testInfo) })
	});

	test('signed-in pages are never cached, and after sign-out nothing of them is served offline', async ({
		page,
		context
	}) => {
		const email = `fn13-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
		await page.goto('/daftar');
		await waitForHydration(page);
		await page.getByLabel('Nama').fill('Budi Santoso');
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await page.waitForURL(`${APP_ORIGIN}/`);
		await serviceWorkerReady(page);

		// Browse signed-in pages (full loads and client-side navigations with __data.json).
		await page.goto('/riwayat');
		await page.goto('/pengaturan/akun');
		await waitForHydration(page);
		await expect(page.locator('main').getByText(email)).toBeVisible();
		expectOnlyShell(await cachedEntries(page));

		const signOut = page.waitForResponse(
			(r) => r.url().includes('/pengaturan/akun?/signOut') && r.request().method() === 'POST'
		);
		await page.getByRole('button', { name: 'Keluar dari akun' }).click();
		expect((await (await signOut).allHeaders())['clear-site-data']).toBe('"cache", "storage"');
		await expect(page).toHaveURL(/\/masuk/);

		// Whatever the browser kept or rebuilt since: shell only, nothing from the signed-in pages.
		expectOnlyShell(await cachedEntries(page));
		expect(await page.content()).not.toContain(email);

		// The next person on this device: the account page is not served from any cache…
		await page.goto('/pengaturan/akun');
		await expect(page).toHaveURL(/\/masuk/);
		// …and offline, a signed-in page shows only the offline page.
		await serviceWorkerReadyAfterClear(page);
		await context.setOffline(true);
		await page.goto('/riwayat').catch(() => {});
		await expect(page.getByRole('heading', { name: 'Kamu sedang offline.' })).toBeVisible();
		expect(await page.content()).not.toContain(email);
		await context.setOffline(false);
	});
});

test.describe('install guide (/pengaturan/instal)', () => {
	test.use({ storageState: SIGNED_OUT });

	test('renders signed out and links the public guide on the site host, no third-party request', async ({
		page
	}) => {
		const csp = collectCspViolations(page);
		const foreign: string[] = [];
		page.on('request', (r) => {
			if (!r.url().startsWith(APP_ORIGIN) && !r.url().startsWith('data:')) foreign.push(r.url());
		});
		await page.goto('/pengaturan/instal');
		await waitForHydration(page);
		await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/instal`);
		await expect(page.getByRole('heading', { level: 1, name: 'Pasang aplikasi' })).toBeVisible();
		// FN-32: the steps and the QR code live on the public /pasang only (one copy).
		await expect(page.getByRole('heading', { name: 'Android (Chrome)' })).toHaveCount(0);
		await expect(page.getByRole('img', { name: 'Kode QR ke panduan pemasangan' })).toHaveCount(0);
		const guide = page.getByRole('link', { name: 'Lihat panduan pemasangan' });
		await expect(guide).toHaveAttribute('href', `${SITE_ORIGIN}/pasang`);
		if (isPhone(page)) await expectNoHorizontalScroll(page);
		// The install button appears only when the browser offers its prompt (not in headless Chromium).
		await expect(page.getByRole('button', { name: 'Instal aplikasi' })).toHaveCount(0);
		expect(foreign).toEqual([]);
		expect(csp).toEqual([]);
	});

	test('an in-app browser gets the open-in-your-browser notice, dismissible for the session', async ({
		browser
	}) => {
		const context = await browser.newContext({
			storageState: SIGNED_OUT,
			viewport: { width: 360, height: 780 },
			userAgent:
				'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 Instagram 339.0.0.30.105 Android (34/14; 450dpi; 1080x2340; samsung; SM-A546E; a54x; s5e8835; id_ID; 618003347)'
		});
		const page = await context.newPage();
		await page.goto(`${APP_ORIGIN}/pengaturan/instal`);
		await waitForHydration(page);
		const notice = page.getByText('Buka di Chrome untuk memasang aplikasi ini');
		await expect(notice).toBeVisible();
		const close = page.getByRole('button', { name: 'Tutup pemberitahuan' });
		const box = await close.boundingBox();
		expect(box!.width).toBeGreaterThanOrEqual(44);
		expect(box!.height).toBeGreaterThanOrEqual(44);
		await close.click();
		await expect(notice).toHaveCount(0);
		// Focus moved to the page's main region, not lost to <body>.
		expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
		await page.reload();
		await waitForHydration(page);
		await expect(notice).toHaveCount(0);
		await context.close();
	});
});

test.describe('notifications (/pengaturan/notifikasi)', () => {
	test('without VAPID keys the switch is disabled with "Belum dikonfigurasi" and nothing asks permission', async ({
		page
	}) => {
		const csp = collectCspViolations(page);
		// Count permission requests and push subscriptions the page makes.
		await page.addInitScript(() => {
			const w = window as unknown as { __asked: number };
			w.__asked = 0;
			const ask = Notification.requestPermission.bind(Notification);
			Notification.requestPermission = (...args) => {
				w.__asked++;
				return ask(...args);
			};
			const subscribe = PushManager.prototype.subscribe;
			PushManager.prototype.subscribe = function (...args) {
				w.__asked++;
				return subscribe.apply(this, args);
			};
		});
		await page.goto('/pengaturan/notifikasi');
		await waitForHydration(page);
		const toggle = page.getByRole('switch', { name: 'Beri tahu di perangkat ini' });
		await expect(toggle).toBeDisabled();
		await expect(toggle).not.toBeChecked();
		await expect(page.locator('main').getByText('Belum dikonfigurasi')).toBeVisible();
		await page.getByText('Beri tahu di perangkat ini').click({ force: true });
		await expect(toggle).not.toBeChecked();
		expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
		// The dev-only test sender is not offered while push is unconfigured.
		await expect(page.getByRole('button', { name: 'Kirim notifikasi uji' })).toHaveCount(0);
		expect(csp).toEqual([]);
	});

	test('the settings index links both pages', async ({ page }) => {
		await page.goto('/pengaturan');
		await expect(page.locator('main').getByRole('link', { name: 'Notifikasi' })).toHaveAttribute(
			'href',
			'/pengaturan/notifikasi'
		);
		await expect(page.getByRole('link', { name: 'Pasang aplikasi' })).toHaveAttribute(
			'href',
			'/pengaturan/instal'
		);
	});
});

test.describe('updates (FN-42, /pengaturan/tentang)', () => {
	const BANNER = 'Versi baru tersedia — Muat ulang';
	/** Full document loads of this tab so far (counted by an init script in sessionStorage). */
	const loads = (page: Page) =>
		page.evaluate(() => Number(sessionStorage.getItem('fn42-loads') ?? '0'));
	/** The active and waiting workers' script names (path and query), or null. */
	const workers = (page: Page) =>
		page.evaluate(async () => {
			const reg = await navigator.serviceWorker.getRegistration();
			const name = (w: ServiceWorker | null | undefined) => {
				if (!w) return null;
				const url = new URL(w.scriptURL);
				return url.pathname.slice(1) + url.search;
			};
			return { active: name(reg?.active), waiting: name(reg?.waiting) };
		});

	test('first install activates silently; an update waits for "Muat ulang sekarang", reloads once, and an unsent offline item survives', async ({
		browser
	}, testInfo) => {
		test.setTimeout(120_000);
		const { context, page } = await freshUser(browser, testInfo, 'fn42');
		await context.addInitScript(() => {
			const n = Number(sessionStorage.getItem('fn42-loads') ?? '0') + 1;
			sessionStorage.setItem('fn42-loads', String(n));
		});
		// First install: active and in control with nothing waiting, and no banner (AC8).
		await serviceWorkerReady(page);
		expect(await workers(page)).toEqual({ active: 'service-worker.js', waiting: null });
		await expect(page.getByText(BANNER)).toHaveCount(0);

		// Nothing new: "Sudah versi terbaru", no reload (AC11).
		await page.goto('/pengaturan/tentang');
		await waitForHydration(page);
		let before = await loads(page);
		await page.getByRole('button', { name: 'Periksa pembaruan' }).click();
		await expect(page.getByText('Sudah versi terbaru')).toBeVisible();
		expect(await loads(page)).toBe(before);
		await expect(page.getByText(BANNER)).toHaveCount(0);

		// An offline write the server never confirmed: its reply is lost (the write reached the server, the
		// page saw a network error), the hardest case for a reload in the middle (AC10).
		await addWallet(page, 'BCA');
		await queueOneBlocked(context, page, 'Kopi saat pembaruan');
		// Registered on top of the abort (the newest route answers first), so no send slips through in between.
		await context.route(PUSH, async (route) => {
			await route.fetch();
			await route.abort();
		});
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect.poll(() => queueSize(page)).toBe(1);

		// Playwright cannot rewrite the worker script the browser fetches for an update check, so the "other
		// build" is the same bundle under another script URL, which the browser installs as a new version just
		// the same. Here it is the OLDER build: it installs and waits (an older worker is active), the banner
		// shows on any page and hides for this page only; then it is let in, with no reload (nobody asked).
		before = await loads(page);
		await page.evaluate(() =>
			navigator.serviceWorker.register('/service-worker.js?build=old', { type: 'module' })
		);
		await expect(page.getByText(BANNER)).toBeVisible();
		expect(await workers(page)).toEqual({
			active: 'service-worker.js',
			waiting: 'service-worker.js?build=old'
		});
		await page.getByRole('button', { name: 'Sembunyikan' }).click();
		await expect(page.getByText(BANNER)).toHaveCount(0);
		await page.evaluate(async () => {
			const reg = await navigator.serviceWorker.getRegistration();
			const changed = new Promise((r) =>
				navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
			);
			reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
			await changed;
		});
		expect(await workers(page)).toEqual({ active: 'service-worker.js?build=old', waiting: null });
		expect(await loads(page)).toBe(before);

		// The next page load registers the current build: it installs and waits while the old one runs (AC9).
		await page.goto('/pengaturan/tentang');
		await waitForHydration(page);
		await expect(page.getByText(BANNER)).toBeVisible();
		expect(await workers(page)).toEqual({
			active: 'service-worker.js?build=old',
			waiting: 'service-worker.js'
		});
		expect(await queueSize(page)).toBe(1);
		before = await loads(page);

		await page.getByRole('button', { name: 'Muat ulang sekarang' }).click();
		await expect.poll(() => loads(page).catch(() => before)).toBe(before + 1);
		await waitForHydration(page);
		// The new build took over; nothing waits any more, so no banner — and the page reloaded exactly once.
		expect(await workers(page)).toEqual({ active: 'service-worker.js', waiting: null });
		await expect(page.getByText(BANNER)).toHaveCount(0);
		await page.waitForTimeout(1500);
		expect(await loads(page)).toBe(before + 1);

		// The unconfirmed item is still queued after the reload, and is saved once when the server answers.
		expect(await queueSize(page)).toBe(1);
		await context.unroute(PUSH);
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect.poll(() => queueSize(page), { timeout: 30_000 }).toBe(0);
		await page.goto('/riwayat');
		await expect(
			page.locator('main').getByRole('link').filter({ hasText: 'Kopi saat pembaruan' })
		).toHaveCount(1);
		await context.close();
	});

	test('without JavaScript the version and "Apa yang baru" render, with no update control; 360 px fits', async ({
		browser
	}) => {
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			javaScriptEnabled: false,
			viewport: { width: 360, height: 780 }
		});
		const page = await context.newPage();
		const csp = collectCspViolations(page);
		const health = await (await page.request.get('/api/v1/health')).json();
		await page.goto(`${APP_ORIGIN}/pengaturan/tentang`);
		await expect(page.getByRole('heading', { level: 1, name: 'Tentang Montra' })).toBeVisible();
		await expect(page.getByTestId('app-version')).toHaveText(`Versi ${health.version}`);
		await expect(page.getByRole('heading', { level: 2, name: 'Apa yang baru' })).toBeVisible();
		await expect(page.getByRole('heading', { level: 3 })).toHaveCount(3);
		// FN-42b AC4: "Semua catatan rilis" leads to the full changelog, a 44 px target.
		const all = page.getByRole('link', { name: 'Semua catatan rilis', exact: true });
		await expect(all).toHaveAttribute('href', '/pengaturan/tentang/catatan-rilis');
		expect((await all.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
		await expect(page.getByRole('button', { name: 'Periksa pembaruan' })).toHaveCount(0);
		await expect(page.getByText(BANNER)).toHaveCount(0);
		await expectNoHorizontalScroll(page);
		expect(csp).toEqual([]);
		await context.close();
	});
});

test.describe('automatic update checks (FN-42b)', () => {
	const BANNER = 'Versi baru tersedia — Muat ulang';
	const loads = (page: Page) =>
		page.evaluate(() => Number(sessionStorage.getItem('fn42-loads') ?? '0'));
	/** `registration.update()` calls this page made (counted by the init script below). */
	const updates = (page: Page) =>
		page.evaluate(() => (window as unknown as { __updates: number }).__updates);
	/** Forces `document.visibilityState` and fires `visibilitychange`, as switching tabs or apps does. */
	const setVisibility = (page: Page, state: 'visible' | 'hidden') =>
		page.evaluate((s) => {
			(window as unknown as { __visibility: string }).__visibility = s;
			document.dispatchEvent(new Event('visibilitychange'));
		}, state);
	/** No further `update()` arrives within a short settle time. */
	const settle = (page: Page) => page.waitForTimeout(500);
	/** `n` checks were made and none is still running (the next trigger must not meet one in flight). */
	const expectChecks = async (page: Page, n: number) => {
		await expect.poll(() => updates(page)).toBe(n);
		await expect
			.poll(() => page.evaluate(() => (window as unknown as { __pending: number }).__pending))
			.toBe(0);
	};

	/**
	 * Counts full loads and `update()` calls, and lets the test set the page's visibility. With `hold` set in
	 * sessionStorage the page's own registration of /service-worker.js returns the existing registration (the
	 * browser has not seen the new build yet), and the next `update()` is the moment the browser finds it: it
	 * installs the current build, exactly as an update check that found new worker bytes does. Playwright cannot
	 * change the worker script the browser fetches, so this is how a "newer build" reaches an automatic check.
	 */
	function counters() {
		const n = Number(sessionStorage.getItem('fn42-loads') ?? '0') + 1;
		sessionStorage.setItem('fn42-loads', String(n));
		const w = window as unknown as {
			__updates: number;
			__pending: number;
			__visibility: DocumentVisibilityState;
			__slow?: boolean;
			__release?: () => void;
		};
		w.__updates = 0;
		w.__pending = 0;
		w.__visibility = 'visible';
		Object.defineProperty(Document.prototype, 'visibilityState', {
			configurable: true,
			get: () => w.__visibility
		});
		const register = ServiceWorkerContainer.prototype.register;
		ServiceWorkerContainer.prototype.register = function (url, options) {
			if (sessionStorage.getItem('fn42b-hold') === '1' && String(url) === '/service-worker.js')
				return this.getRegistration().then((r) => r ?? register.call(this, url, options));
			return register.call(this, url, options);
		};
		const update = ServiceWorkerRegistration.prototype.update;
		const tracked = <T>(p: Promise<T>) => {
			w.__pending++;
			return p.finally(() => w.__pending--);
		};
		ServiceWorkerRegistration.prototype.update = function () {
			w.__updates++;
			if (sessionStorage.getItem('fn42b-hold') === '1') {
				sessionStorage.removeItem('fn42b-hold');
				return tracked(
					register.call(navigator.serviceWorker, '/service-worker.js', { type: 'module' })
				);
			}
			if (w.__slow)
				return tracked(new Promise<void>((r) => (w.__release = r)).then(() => update.call(this)));
			return tracked(update.call(this));
		};
	}

	test('visible and online check after the 10-minute gap, once; a hidden page never checks; no reload', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext({ storageState: STORAGE_STATE });
		await context.addInitScript(counters);
		const page = await context.newPage();
		await page.clock.install();
		await page.goto('/');
		await waitForHydration(page);
		await serviceWorkerReady(page);
		const before = await loads(page);

		// Registering just now counts as a check: inside the gap nothing more is asked.
		await setVisibility(page, 'visible');
		await settle(page);
		expect(await updates(page)).toBe(0);

		// AC10: past the gap, becoming visible checks once; again within the gap, nothing.
		await page.clock.fastForward('10:01');
		await setVisibility(page, 'visible');
		await expectChecks(page, 1);
		await setVisibility(page, 'visible');
		await settle(page);
		expect(await updates(page)).toBe(1);
		await page.clock.fastForward('10:01');
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expectChecks(page, 2);

		// AC14: hidden for longer than the 45-minute interval: no check at all.
		await setVisibility(page, 'hidden');
		await page.clock.runFor('46:00');
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await settle(page);
		expect(await updates(page)).toBe(2);

		// Visible again: one check at once, then the 45-minute interval checks again.
		await setVisibility(page, 'visible');
		await expectChecks(page, 3);
		await page.clock.runFor('45:00');
		await expectChecks(page, 4);

		expect(await loads(page)).toBe(before);
		await expect(page.getByText(BANNER)).toHaveCount(0);
		await context.close();
	});

	test('"Periksa pembaruan" during an automatic check starts no second update()', async ({
		browser
	}) => {
		const context = await browser.newContext({ storageState: STORAGE_STATE });
		await context.addInitScript(counters);
		const page = await context.newPage();
		await page.clock.install();
		await page.goto('/pengaturan/tentang');
		await waitForHydration(page);
		await serviceWorkerReady(page);
		await page.evaluate(() => ((window as unknown as { __slow: boolean }).__slow = true));
		await page.clock.fastForward('10:01');
		await setVisibility(page, 'visible');
		await expect.poll(() => updates(page)).toBe(1);

		await page.getByRole('button', { name: 'Periksa pembaruan' }).click();
		await expect(page.getByRole('button', { name: 'Memeriksa…' })).toBeVisible();
		await settle(page);
		expect(await updates(page)).toBe(1);
		await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
		await expect(page.getByText('Sudah versi terbaru')).toBeVisible();
		expect(await updates(page)).toBe(1);
		await context.close();
	});

	test('an automatic check finds a newer build: the banner appears without a reload, and an unsent offline item survives the update', async ({
		browser
	}, testInfo) => {
		test.setTimeout(150_000);
		const { context, page } = await freshUser(browser, testInfo, 'fn42b');
		await context.addInitScript(counters);
		await page.clock.install();
		await page.goto('/');
		await waitForHydration(page);
		await serviceWorkerReady(page);

		// An offline write whose reply is lost (as in the FN-42 journey above).
		await addWallet(page, 'BCA');
		await queueOneBlocked(context, page, 'Kopi saat cek otomatis');
		await context.route(PUSH, async (route) => {
			await route.fetch();
			await route.abort();
		});
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect.poll(() => queueSize(page)).toBe(1);

		// The older build becomes active (no reload), then the page loads again without registering the current
		// build itself: the browser has not seen it yet.
		await page.evaluate(async () => {
			const reg = await navigator.serviceWorker.register('/service-worker.js?build=old', {
				type: 'module'
			});
			const installed = reg.installing ?? reg.waiting;
			if (installed && installed.state !== 'installed')
				await new Promise((r) =>
					installed.addEventListener('statechange', function done() {
						if (installed.state === 'installed')
							r(installed.removeEventListener('statechange', done));
					})
				);
			const changed = new Promise((r) =>
				navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
			);
			reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
			await changed;
			sessionStorage.setItem('fn42b-hold', '1');
		});
		await page.goto('/');
		await waitForHydration(page);
		await expect(page.getByText(BANNER)).toHaveCount(0);
		expect(await queueSize(page)).toBe(1);
		const before = await loads(page);

		// AC11: no tap on "Periksa pembaruan": the automatic check on becoming visible finds the newer build.
		await page.clock.fastForward('10:01');
		await setVisibility(page, 'visible');
		await expect(page.getByText(BANNER)).toBeVisible();
		expect(await updates(page)).toBe(1);
		expect(await loads(page)).toBe(before);
		expect(await queueSize(page)).toBe(1);

		await page.getByRole('button', { name: 'Muat ulang sekarang' }).click();
		await expect.poll(() => loads(page).catch(() => before)).toBe(before + 1);
		await waitForHydration(page);
		await expect(page.getByText(BANNER)).toHaveCount(0);
		await page.waitForTimeout(1500);
		expect(await loads(page)).toBe(before + 1);

		expect(await queueSize(page)).toBe(1);
		await context.unroute(PUSH);
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect.poll(() => queueSize(page), { timeout: 30_000 }).toBe(0);
		await page.goto('/riwayat');
		await expect(
			page.locator('main').getByRole('link').filter({ hasText: 'Kopi saat cek otomatis' })
		).toHaveCount(1);
		await context.close();
	});
});

test.describe('usage (FN-42, /pengaturan/pemakaian)', () => {
	test('a new account: real figures, no fabricated ceiling, works without JavaScript at 360 px', async ({
		browser
	}, testInfo) => {
		const { context } = await freshUser(browser, testInfo, 'fn42u');
		const state = await context.storageState();
		await context.close();
		const noJs = await browser.newContext({
			storageState: state,
			javaScriptEnabled: false,
			viewport: { width: 360, height: 780 },
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) }
		});
		const page = await noJs.newPage();
		await page.goto(`${APP_ORIGIN}/pengaturan/pemakaian`);
		await expect(page.getByRole('heading', { level: 1, name: 'Pemakaian' })).toBeVisible();
		await expect(page.getByTestId('usage-balance')).toHaveText('300');
		await expect(page.getByTestId('usage-spent')).toContainText(': 0 kredit');
		await expect(page.getByTestId('limit-spaces')).toHaveText('1 dari 1');
		await expect(page.getByTestId('limit-tokens')).toHaveText('0 dari 10');
		await expect(page.getByTestId('limit-categories')).toHaveText(/^\d+ dari 100$/);
		await expect(page.getByTestId('usage-connected')).toHaveText('0');
		await expect(page.getByTestId('usage-members')).toHaveText('Ruang pribadi');
		await expect(page.getByTestId('limit-gmail')).toHaveText('paling lama 7 hari');
		await expect(page.getByRole('link', { name: /Belum ada pemakaian AI/ })).toHaveAttribute(
			'href',
			'/pengaturan/integrasi'
		);
		await expect(page.getByTestId('usage-photos-belongings')).toHaveText('0');
		await expect(page.getByTestId('usage-photos-collectibles')).toHaveText('0');
		// The same balance as Paket & kredit.
		await page.goto(`${APP_ORIGIN}/pengaturan/paket`);
		await expect(page.getByTestId('credit-balance')).toHaveText('300');
		await page.goto(`${APP_ORIGIN}/pengaturan/pemakaian`);
		await expectNoHorizontalScroll(page);
		await noJs.close();
	});

	test('the settings index links Pemakaian after Paket & kredit and Tentang last in Aplikasi, 44 px rows', async ({
		page
	}) => {
		await page.goto('/pengaturan');
		await waitForHydration(page);
		const main = page.locator('main');
		const account = main.locator('section', { has: page.locator('#settings-account') });
		const app = main.locator('section', { has: page.locator('#settings-app') });
		const accountLinks = await account
			.getByRole('link')
			.evaluateAll((a) => a.map((x) => x.getAttribute('href')));
		expect(accountLinks.indexOf('/pengaturan/pemakaian')).toBe(
			accountLinks.indexOf('/pengaturan/paket') + 1
		);
		const appLinks = await app
			.getByRole('link')
			.evaluateAll((a) => a.map((x) => x.getAttribute('href')));
		expect(appLinks.at(-1)).toBe('/pengaturan/tentang');
		for (const href of ['/pengaturan/pemakaian', '/pengaturan/tentang']) {
			const box = await main.locator(`a[href="${href}"]`).boundingBox();
			expect(box!.height).toBeGreaterThanOrEqual(44);
		}
		await main.getByRole('link', { name: /Pemakaian/ }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Pemakaian' })).toBeVisible();
		await page.goBack();
		await main.getByRole('link', { name: /Tentang/ }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Tentang Montra' })).toBeVisible();
		if (isPhone(page)) await expectNoHorizontalScroll(page);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// FN-13b: iOS and Android platform fit. Playwright cannot install a PWA, open a keyboard or fake `env()`, so these
// assert markup, the manifest, UA-emulated pages, computed styles and overridden inset variables. What needs a real
// phone (splash, status bar, focus zoom, keyboard, shortcuts) is the manual checklist in the QA report.
// ---------------------------------------------------------------------------------------------------------------

const IPHONE_SAFARI =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1';
const IPHONE_FIREFOX =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15';
const IPHONE_EDGE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0.2849.52 Mobile/15E148 Safari/605.1.15';
const IPHONE_INSTAGRAM =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone15,2; iOS 17_5_1; id_ID; id; scale=3.00; 1179x2556; 619520717)';
const HINT_KEY = 'montra-install-hint-dismissed';

/** A 390x844 context with an iPhone user agent (Chromium underneath: markup and UA behaviour only). */
async function iphone(
	browser: Browser,
	userAgent: string,
	options: { signedIn?: boolean; locale?: 'id' | 'en' } = {}
): Promise<BrowserContext> {
	const context = await browser.newContext({
		userAgent,
		viewport: { width: 390, height: 844 },
		storageState: options.signedIn ? STORAGE_STATE : SIGNED_OUT
	});
	if (options.locale === 'en')
		await context.addCookies([{ name: 'lang', value: 'en', url: APP_ORIGIN }]);
	return context;
}

/** The installed-app state: `display-mode: standalone` (CDP) and iOS's `navigator.standalone`. */
async function emulateStandalone(page: Page): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setEmulatedMedia', {
		features: [{ name: 'display-mode', value: 'standalone' }]
	});
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'standalone', { value: true });
	});
}

const phoneOnly = (page: Page) => test.skip(!isPhone(page), 'phone viewport only');

test.describe('head and meta (FN-13b)', () => {
	test('iPhone Safari: title and status-bar metas, no "capable" tag, one launch image per device and scheme', async ({
		browser,
		request
	}) => {
		const context = await iphone(browser, IPHONE_SAFARI);
		const page = await context.newPage();
		const csp = collectCspViolations(page);
		await page.goto(`${APP_ORIGIN}/masuk`);
		await waitForHydration(page);
		await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
			'content',
			'Montra'
		);
		await expect(
			page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')
		).toHaveAttribute('content', 'default');
		await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveCount(0);
		await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveCount(0);
		const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
		expect(viewport).not.toMatch(/maximum-scale|user-scalable/);

		const links = await page
			.locator('link[rel="apple-touch-startup-image"]')
			.evaluateAll((els) => els.map((e) => [e.getAttribute('href'), e.getAttribute('media')]));
		const expected = SPLASH_SCREENS.flatMap((screen) =>
			(['light', 'dark'] as const).map((scheme) => [screen[scheme], splashMedia(screen, scheme)])
		);
		expect(links).toEqual(expected);
		expect(links).toHaveLength(36);
		for (const screen of SPLASH_SCREENS)
			for (const scheme of ['light', 'dark'] as const) {
				const res = await request.get(screen[scheme]);
				expect(res.status(), screen[scheme]).toBe(200);
				expect(res.headers()['content-type']).toBe('image/png');
				expect(pngSize(await res.body()), screen[scheme]).toEqual({
					width: screen.width * screen.scale,
					height: screen.height * screen.scale
				});
			}
		expect(csp).toEqual([]);
		await context.close();
	});

	test('no launch-image link outside Apple devices (Pixel 7 phone and desktop projects); the metas stay', async ({
		page
	}) => {
		await page.goto('/riwayat');
		await expect(page.locator('link[rel="apple-touch-startup-image"]')).toHaveCount(0);
		await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveCount(1);
	});

	test('the theme toggle moves both theme-color metas without a reload', async ({ page }) => {
		test.skip(isPhone(page), 'the sidebar toggle shows on desktop');
		await page.goto('/riwayat');
		await waitForHydration(page);
		const metas = () =>
			page.evaluate(() => [
				document.querySelector<HTMLMetaElement>('meta[name="theme-color"][media*="light"]')!
					.content,
				document.querySelector<HTMLMetaElement>('meta[name="theme-color"][media*="dark"]')!.content
			]);
		expect(await metas()).toEqual(['#ffffff', '#111112']);
		await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
		await page.getByRole('button', { name: 'Tampilan: Sistem' }).click();
		expect(await metas()).toEqual(['#ffffff', '#ffffff']);
		await page.getByRole('button', { name: 'Tampilan: Terang' }).click();
		expect(await metas()).toEqual(['#111112', '#111112']);
		await page.getByRole('button', { name: 'Tampilan: Gelap' }).click();
		expect(await metas()).toEqual(['#ffffff', '#121212']);
		await page.getByRole('button', { name: 'Tampilan: Hitam-putih' }).click();
		expect(await metas()).toEqual(['#ffffff', '#111112']);
		// No reload happened: the marker set before the first click is still there.
		expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(
			true
		);
	});

	test.describe('signed out', () => {
		test.use({ storageState: SIGNED_OUT });
		test('/offline.html carries both theme-color metas, no script, and its CSP is unchanged', async ({
			page,
			request
		}) => {
			const res = await request.get('/offline.html');
			const html = await res.text();
			expect(html).toContain(
				'<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />'
			);
			expect(html).toContain(
				'<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111112" />'
			);
			expect(html).not.toMatch(/<script/i);
			expect(res.headers()['content-security-policy']).toBe(
				"default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
			);
			void page;
		});
	});
});

test.describe('manifest in the browser (FN-13b)', () => {
	test('every icon, shortcut icon and screenshot answers 200 as a PNG of its stated size', async ({
		request
	}) => {
		const manifest = await (await request.get('/manifest.webmanifest')).json();
		const files: { src: string; sizes: string }[] = [
			...manifest.icons,
			...manifest.shortcuts.flatMap((s: { icons: { src: string; sizes: string }[] }) => s.icons),
			...manifest.screenshots
		];
		expect(files).toHaveLength(5 + 4 + 3);
		for (const file of files) {
			const res = await request.get(file.src);
			expect(res.status(), file.src).toBe(200);
			expect(res.headers()['content-type']).toBe('image/png');
			const { width, height } = pngSize(await res.body());
			expect(`${width}x${height}`, file.src).toBe(file.sizes);
		}
		expect(manifest.shortcuts.map((s: { url: string }) => s.url)).toEqual([
			'/riwayat/baru',
			'/riwayat/suara',
			'/riwayat/struk',
			'/tanya'
		]);
	});

	test.describe('signed out', () => {
		test.use({ storageState: SIGNED_OUT });
		test('each shortcut goes through sign-in with next=<that path>', async ({ page, request }) => {
			const manifest = await (await request.get('/manifest.webmanifest')).json();
			for (const { url } of manifest.shortcuts as { url: string }[]) {
				await page.goto(url);
				await expect(page).toHaveURL(`${APP_ORIGIN}/masuk?next=${encodeURIComponent(url)}`);
			}
		});
	});

	test('signed in, each shortcut renders; Struk says why when unconfigured; Suara does not start recording', async ({
		page,
		request
	}) => {
		const manifest = await (await request.get('/manifest.webmanifest')).json();
		for (const { url } of manifest.shortcuts as { url: string }[]) {
			const res = await page.goto(url);
			expect(res?.status(), url).toBe(200);
			await expect(page, url).toHaveURL(`${APP_ORIGIN}${url}`);
			await expect(page.locator('main h1').first(), url).toBeVisible();
		}
		await page.goto('/riwayat/suara');
		await waitForHydration(page);
		// A full load from a launcher shortcut never auto-starts the microphone (it needs a tap, red team L2).
		await page.waitForTimeout(1000);
		await expect(page.getByRole('button', { name: 'Berhenti merekam' })).toHaveCount(0);
	});

	test('the Struk shortcut, with a wallet and no AI key configured, says why it cannot read yet', async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn13b');
		await addWallet(page, 'BCA');
		await page.goto('/riwayat/struk');
		await expect(
			page.locator('main').getByText('Pembacaan struk dengan AI belum dikonfigurasi.')
		).toBeVisible();
		await context.close();
	});
});

test.describe('standalone offline (FN-13b)', () => {
	test.use({ storageState: SIGNED_OUT });
	test('with display-mode standalone emulated, an offline navigation shows /offline.html, no CSP violation', async ({
		page,
		context
	}) => {
		phoneOnly(page);
		await emulateStandalone(page);
		const csp = collectCspViolations(page);
		await page.goto('/masuk');
		await serviceWorkerReady(page);
		await context.setOffline(true);
		await page.goto('/daftar').catch(() => {});
		await expect(page.getByRole('heading', { name: 'Kamu sedang offline.' })).toBeVisible();
		expect(csp).toEqual([]);
		await context.setOffline(false);
	});
});

test.describe('install guidance (FN-13b)', () => {
	for (const signedIn of [false, true]) {
		test(`iPhone Safari, not standalone, ${signedIn ? 'signed in' : 'signed out'}: inline steps, sign-in note, no button, no third-party request`, async ({
			browser
		}) => {
			const context = await iphone(browser, IPHONE_SAFARI, { signedIn });
			const page = await context.newPage();
			const csp = collectCspViolations(page);
			const foreign: string[] = [];
			page.on('request', (r) => {
				if (!r.url().startsWith(APP_ORIGIN) && !r.url().startsWith('data:')) foreign.push(r.url());
			});
			await page.goto(`${APP_ORIGIN}/pengaturan/instal`);
			await waitForHydration(page);
			const steps = page.getByRole('region', { name: 'iPhone dan iPad (Safari)' });
			await expect(steps.getByRole('listitem')).toHaveText([
				'Buka aplikasinya di Safari.',
				'Ketuk tombol Bagikan (kotak dengan panah ke atas).',
				'Pilih Tambah ke Layar Utama.',
				'Jika ada pilihan Buka sebagai App Web, biarkan aktif.',
				'Ketuk Tambah.'
			]);
			await expect(
				page.getByText('Setelah terpasang, masuk sekali lagi di aplikasi.')
			).toBeVisible();
			await expect(page.getByText('buka halaman ini di Safari')).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Instal aplikasi' })).toHaveCount(0);
			await expect(page.getByRole('link', { name: 'Lihat panduan pemasangan' })).toHaveAttribute(
				'rel',
				'noopener noreferrer'
			);
			await expectNoHorizontalScroll(page);
			expect(foreign).toEqual([]);
			expect(csp).toEqual([]);
			await context.close();
		});
	}

	test('without JavaScript the iPhone steps and the sign-in note are in the server-rendered page', async ({
		browser
	}) => {
		const context = await browser.newContext({
			userAgent: IPHONE_SAFARI,
			viewport: { width: 390, height: 844 },
			storageState: SIGNED_OUT,
			javaScriptEnabled: false
		});
		const page = await context.newPage();
		await page.goto(`${APP_ORIGIN}/pengaturan/instal`);
		await expect(page.getByRole('region', { name: 'iPhone dan iPad (Safari)' })).toBeVisible();
		await expect(page.getByText('Setelah terpasang, masuk sekali lagi di aplikasi.')).toBeVisible();
		await context.close();
	});

	for (const [name, ua] of [
		['CriOS', IPHONE_CHROME],
		['FxiOS', IPHONE_FIREFOX],
		['EdgiOS', IPHONE_EDGE]
	] as const) {
		test(`iOS ${name}: asks to open the page in Safari and still lists the Safari steps`, async ({
			browser
		}) => {
			const context = await iphone(browser, ua);
			const page = await context.newPage();
			await page.goto(`${APP_ORIGIN}/pengaturan/instal`);
			await waitForHydration(page);
			await expect(page.getByText('Untuk memasang, buka halaman ini di Safari.')).toBeVisible();
			await expect(
				page.getByText(
					'Beberapa browser lain juga punya Tambah ke Layar Utama, tapi Safari yang paling pasti.'
				)
			).toBeVisible();
			await expect(page.getByRole('region', { name: 'iPhone dan iPad (Safari)' })).toBeVisible();
			await context.close();
		});
	}

	test('standalone (navigator.standalone, then display-mode): "Sudah terpasang", and no hint, steps or Safari text anywhere', async ({
		browser
	}) => {
		for (const mode of ['navigator', 'display-mode'] as const) {
			const context = await iphone(browser, IPHONE_SAFARI, { signedIn: true });
			const page = await context.newPage();
			if (mode === 'navigator')
				await page.addInitScript(() => {
					Object.defineProperty(navigator, 'standalone', { value: true });
				});
			else await emulateStandalone(page);
			await page.goto(`${APP_ORIGIN}/pengaturan/instal`);
			await waitForHydration(page);
			await expect(page.getByText('Sudah terpasang')).toBeVisible();
			await expect(page.getByRole('region', { name: 'iPhone dan iPad (Safari)' })).toHaveCount(0);
			await expect(page.getByText(/buka halaman ini di Safari/)).toHaveCount(0);
			await page.goto(`${APP_ORIGIN}/`);
			await waitForHydration(page);
			await expect(
				page.getByRole('complementary', { name: 'Pasang Montra di layar utama' })
			).toHaveCount(0);
			await context.close();
		}
	});

	test('the English interface shows the English steps, hint and note', async ({ browser }) => {
		const context = await iphone(browser, IPHONE_SAFARI, { signedIn: true, locale: 'en' });
		const page = await context.newPage();
		await page.goto(`${APP_ORIGIN}/`);
		await waitForHydration(page);
		await expect(
			page.getByRole('complementary', { name: 'Install Montra on your home screen' })
		).toBeVisible();
		await page.goto(`${APP_ORIGIN}/pengaturan/instal`);
		await waitForHydration(page);
		await expect(page.getByText('Open the app in Safari.')).toBeVisible();
		await expect(
			page.getByText('If there is an Open as Web App option, leave it on.')
		).toBeVisible();
		await expect(page.getByText('After installing, sign in once more in the app.')).toBeVisible();
		await context.close();
	});

	test('a synthetic beforeinstallprompt still shows the "Instal aplikasi" button (FN-13 behaviour)', async ({
		page
	}) => {
		await page.goto('/pengaturan/instal');
		await waitForHydration(page);
		await page.evaluate(() => {
			const event = new Event('beforeinstallprompt', { cancelable: true });
			Object.assign(event, {
				prompt: () => Promise.resolve(),
				userChoice: Promise.resolve({ outcome: 'dismissed' })
			});
			window.dispatchEvent(event);
		});
		await expect(page.getByRole('button', { name: 'Instal aplikasi' })).toBeVisible();
		await expect(page.getByRole('region', { name: 'iPhone dan iPad (Safari)' })).toHaveCount(0);
	});

	test.describe('the one-time hint', () => {
		const hint = (page: Page) =>
			page.getByRole('complementary', { name: 'Pasang Montra di layar utama' });

		test('shows once on iPhone Safari, Tutup hides it, returns focus to main and is remembered', async ({
			browser
		}) => {
			const context = await iphone(browser, IPHONE_SAFARI, { signedIn: true });
			const page = await context.newPage();
			const csp = collectCspViolations(page);
			await page.goto(`${APP_ORIGIN}/`);
			await waitForHydration(page);
			await expect(hint(page)).toBeVisible();
			await expect(hint(page).getByRole('link', { name: 'Lihat caranya' })).toHaveAttribute(
				'href',
				'/pengaturan/instal'
			);
			for (const control of [
				hint(page).getByRole('link', { name: 'Lihat caranya' }),
				hint(page).getByRole('button', { name: 'Tutup' })
			])
				expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
			await hint(page).getByRole('button', { name: 'Tutup' }).click();
			await expect(hint(page)).toHaveCount(0);
			expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
			expect(await page.evaluate((k) => localStorage.getItem(k), HINT_KEY)).toBe('1');
			await page.reload();
			await waitForHydration(page);
			await expect(hint(page)).toHaveCount(0);
			expect(csp).toEqual([]);
			await context.close();
		});

		test('opening the steps from it counts as dismissed', async ({ browser }) => {
			const context = await iphone(browser, IPHONE_SAFARI, { signedIn: true });
			const page = await context.newPage();
			await page.goto(`${APP_ORIGIN}/`);
			await waitForHydration(page);
			await hint(page).getByRole('link', { name: 'Lihat caranya' }).click();
			await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/instal`);
			expect(await page.evaluate((k) => localStorage.getItem(k), HINT_KEY)).toBe('1');
			await page.goto(`${APP_ORIGIN}/riwayat`);
			await waitForHydration(page);
			await expect(hint(page)).toHaveCount(0);
			await context.close();
		});

		test('with localStorage throwing the page still renders and the hint can be closed', async ({
			browser
		}) => {
			const context = await iphone(browser, IPHONE_SAFARI, { signedIn: true });
			const page = await context.newPage();
			await page.addInitScript(() => {
				const refuse = () => {
					throw new DOMException('blocked', 'SecurityError');
				};
				Storage.prototype.getItem = refuse;
				Storage.prototype.setItem = refuse;
			});
			await page.goto(`${APP_ORIGIN}/`);
			await waitForHydration(page);
			await expect(hint(page)).toBeVisible();
			await hint(page).getByRole('button', { name: 'Tutup' }).click();
			await expect(hint(page)).toHaveCount(0);
			await context.close();
		});

		test('never on /pengaturan/instal, in an in-app browser, in iOS Chrome, or off iOS', async ({
			browser,
			page
		}) => {
			const safari = await iphone(browser, IPHONE_SAFARI, { signedIn: true });
			const onGuide = await safari.newPage();
			await onGuide.goto(`${APP_ORIGIN}/pengaturan/instal`);
			await waitForHydration(onGuide);
			await expect(hint(onGuide)).toHaveCount(0);
			await safari.close();
			for (const ua of [IPHONE_INSTAGRAM, IPHONE_CHROME]) {
				const context = await iphone(browser, ua, { signedIn: true });
				const other = await context.newPage();
				await other.goto(`${APP_ORIGIN}/`);
				await waitForHydration(other);
				await expect(hint(other)).toHaveCount(0);
				await context.close();
			}
			// This project's own browser: Pixel 7 on the phone project, desktop Chrome on the desktop one.
			await page.goto('/');
			await waitForHydration(page);
			await expect(hint(page)).toHaveCount(0);
		});
	});

	test('the Anthropic console link keeps rel="noopener noreferrer"', async ({ page }) => {
		await page.goto('/pengaturan/integrasi');
		await expect(page.getByRole('link', { name: /console\.anthropic\.com/ })).toHaveAttribute(
			'rel',
			'noopener noreferrer'
		);
	});
});

test.describe('notifications on iOS (FN-13b)', () => {
	// The e2e server has no VAPID keys, so the page would answer "Belum dikonfigurasi". To reach the device-state
	// messages the page data is flipped to "configured" in flight; no request is changed on the server.
	async function configured(context: BrowserContext) {
		await context.route('**/pengaturan/notifikasi', async (route) => {
			if (route.request().resourceType() !== 'document') return route.continue();
			const response = await route.fetch();
			const body = (await response.text()).replace(/configured:false/, 'configured:true');
			await route.fulfill({ response, body });
		});
	}
	const spy = (page: Page) =>
		page.addInitScript(() => {
			const w = window as unknown as { __asked: number };
			w.__asked = 0;
			const ask = Notification.requestPermission.bind(Notification);
			Notification.requestPermission = (...args) => {
				w.__asked++;
				return ask(...args);
			};
		});
	const asked = (page: Page) =>
		page.evaluate(() => (window as unknown as { __asked: number }).__asked);

	test('iPhone Safari: install first, "iOS 16.4" and the guide link; nothing asks permission', async ({
		browser
	}) => {
		const context = await iphone(browser, IPHONE_SAFARI, { signedIn: true });
		await configured(context);
		const page = await context.newPage();
		await spy(page);
		await page.goto(`${APP_ORIGIN}/pengaturan/notifikasi`);
		await waitForHydration(page);
		const message = page.getByRole('status').filter({ hasText: 'Pasang dulu ke layar utama' });
		await expect(message).toContainText('iOS 16.4');
		await expect(page.getByRole('link', { name: 'Cara memasang aplikasi' })).toHaveAttribute(
			'href',
			'/pengaturan/instal'
		);
		await expect(page.getByRole('switch', { name: 'Beri tahu di perangkat ini' })).toHaveCount(0);
		expect(await asked(page)).toBe(0);
		await context.close();
	});

	test('iOS Chrome: the message says it needs Safari and links the guide', async ({ browser }) => {
		const context = await iphone(browser, IPHONE_CHROME, { signedIn: true });
		await configured(context);
		const page = await context.newPage();
		await spy(page);
		await page.goto(`${APP_ORIGIN}/pengaturan/notifikasi`);
		await waitForHydration(page);
		await expect(
			page.getByText(
				'Notifikasi di iPhone hanya untuk aplikasi yang dipasang dari Safari ke layar utama.'
			)
		).toBeVisible();
		await expect(page.getByRole('link', { name: 'Cara memasang aplikasi' })).toBeVisible();
		expect(await asked(page)).toBe(0);
		await context.close();
	});

	test('an installed iPhone app without the Push API is told its iOS is too old, with no install link', async ({
		browser
	}) => {
		const context = await iphone(browser, IPHONE_SAFARI, { signedIn: true });
		await configured(context);
		const page = await context.newPage();
		await emulateStandalone(page);
		await page.addInitScript(() => {
			// iOS below 16.4: no PushManager.
			delete (window as unknown as { PushManager?: unknown }).PushManager;
		});
		await page.goto(`${APP_ORIGIN}/pengaturan/notifikasi`);
		await waitForHydration(page);
		await expect(
			page.getByText(
				'Notifikasi di iPhone butuh iOS 16.4 atau lebih baru. Perbarui iOS, lalu buka lagi dari layar utama.'
			)
		).toBeVisible();
		await expect(page.getByRole('link', { name: 'Cara memasang aplikasi' })).toHaveCount(0);
		await expect(page.getByText('Browser ini tidak mendukung notifikasi.')).toHaveCount(0);
		await context.close();
	});

	test('without VAPID keys "Belum dikonfigurasi" still comes first on an iPhone', async ({
		browser
	}) => {
		const context = await iphone(browser, IPHONE_SAFARI, { signedIn: true });
		const page = await context.newPage();
		await page.goto(`${APP_ORIGIN}/pengaturan/notifikasi`);
		await waitForHydration(page);
		await expect(page.locator('main').getByText('Belum dikonfigurasi').first()).toBeVisible();
		await expect(page.getByText('Pasang dulu ke layar utama')).toHaveCount(0);
		await context.close();
	});
});

test.describe('layout at 360 px (FN-13b)', () => {
	const setInsets = (page: Page, v: { top: number; right: number; bottom: number; left: number }) =>
		page.evaluate((v) => {
			const root = document.documentElement.style;
			root.setProperty('--sai-top', `${v.top}px`);
			root.setProperty('--sai-right', `${v.right}px`);
			root.setProperty('--sai-bottom', `${v.bottom}px`);
			root.setProperty('--sai-left', `${v.left}px`);
		}, v);

	test('a notch: the tab bar clears the bottom inset, the title sticks below the top inset, the sheet pads the bottom', async ({
		page
	}) => {
		phoneOnly(page);
		await page.goto('/pengaturan');
		await waitForHydration(page);
		await setInsets(page, { top: 47, right: 0, bottom: 34, left: 0 });
		const bar = (await page.locator('nav.tabbar').boundingBox())!;
		expect(780 - (bar.y + bar.height)).toBeGreaterThanOrEqual(34);
		await page.evaluate(() => window.scrollTo(0, 600));
		await expect
			.poll(async () => (await page.locator('header.screen-title').boundingBox())!.y)
			.toBeGreaterThanOrEqual(47);
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.locator('button.fab').click();
		const body = page.locator('dialog[open] .sheet-body');
		await expect(body).toBeVisible();
		const padding = await body.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
		expect(padding).toBeGreaterThanOrEqual(34);
	});

	test('a landscape notch: with 44 px side insets the tab bar and the content start 44 px in', async ({
		page
	}) => {
		phoneOnly(page);
		// 640 wide: still the phone layout, and the one-column content fills the width, so its padding shows.
		await page.setViewportSize({ width: 640, height: 360 });
		await page.goto('/pengaturan');
		await waitForHydration(page);
		await setInsets(page, { top: 0, right: 44, bottom: 21, left: 44 });
		const bar = (await page.locator('nav.tabbar').boundingBox())!;
		const fab = (await page.locator('button.fab').boundingBox())!;
		expect(bar.x).toBeGreaterThanOrEqual(44);
		expect(640 - (fab.x + fab.width)).toBeGreaterThanOrEqual(44);
		const heading = (await page.locator('main h1').boundingBox())!;
		expect(heading.x).toBeGreaterThanOrEqual(44);
		await expectNoHorizontalScroll(page);
	});

	test('the Suara undo toast sits above the tab bar, also with a bottom inset', async ({
		browser
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'phone', 'phone viewport only');
		const { context, page } = await freshUser(browser, testInfo, 'fn13b');
		await addWallet(page, 'BCA');
		const { wallet, category } = await ids(page);
		const kopi = await category('Kopi');
		await postExpense(page, {
			walletId: await wallet('BCA'),
			categoryId: kopi,
			amount: '25.000',
			title: 'Kopi susu'
		});
		await page.setViewportSize({ width: 360, height: 780 });
		await page.goto('/riwayat/suara');
		await waitForHydration(page);
		await setInsets(page, { top: 0, right: 0, bottom: 34, left: 0 });
		await page.getByRole('button', { name: /^Kopi susu/ }).click();
		const toast = page.getByRole('status').filter({ hasText: 'Dicatat' });
		await expect(toast).toBeVisible();
		const [t, bar] = [
			(await toast.boundingBox())!,
			(await page.locator('nav.tabbar').boundingBox())!
		];
		expect(t.y + t.height).toBeLessThanOrEqual(bar.y);
		expect(t.x).toBeGreaterThanOrEqual(0);
		expect(t.x + t.width).toBeLessThanOrEqual(360);
		await context.close();
	});

	test('no horizontal scroll on Beranda, Riwayat, the open Tambah sheet, the install page and notifications', async ({
		page
	}) => {
		phoneOnly(page);
		for (const path of ['/', '/riwayat', '/pengaturan/instal', '/pengaturan/notifikasi']) {
			await page.goto(path);
			await waitForHydration(page);
			await expectNoHorizontalScroll(page);
		}
		await page.goto('/riwayat');
		await waitForHydration(page);
		await page.locator('button.fab').click();
		await expect(page.locator('dialog[open]')).toBeVisible();
		await expectNoHorizontalScroll(page);
	});

	/** Visible fields iOS would zoom on focus: a computed font size under 16 px. */
	const smallFields = (page: Page) =>
		page.evaluate(() => {
			const fields = document.querySelectorAll<HTMLElement>(
				'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=hidden]), select, textarea'
			);
			return [...fields]
				.filter((el) => el.getClientRects().length > 0)
				.map((el) => ({
					field: `${el.tagName.toLowerCase()}${el.getAttribute('name') ? `[name=${el.getAttribute('name')}]` : ''}`,
					size: parseFloat(getComputedStyle(el).fontSize)
				}))
				.filter((f) => f.size < 16);
		});

	test('every visible input, select and textarea is at least 16 px, on 11 signed-in routes and in the Tambah sheet', async ({
		page
	}) => {
		phoneOnly(page);
		for (const path of [
			'/',
			'/riwayat',
			'/riwayat/baru',
			'/riwayat/suara',
			'/tanya',
			'/dompet',
			'/impor',
			'/anggaran',
			'/langganan',
			'/pengaturan/api',
			'/pengaturan/aplikasi'
		]) {
			await page.goto(path);
			await waitForHydration(page);
			expect(await smallFields(page), path).toEqual([]);
		}
		await page.goto('/riwayat');
		await waitForHydration(page);
		await page.locator('button.fab').click();
		await expect(page.locator('dialog[open]')).toBeVisible();
		expect(await smallFields(page), 'Tambah sheet').toEqual([]);
	});

	test.describe('signed out', () => {
		test.use({ storageState: SIGNED_OUT });
		test('the sign-in form fields are at least 16 px too', async ({ page }) => {
			phoneOnly(page);
			await page.goto('/masuk');
			await waitForHydration(page);
			expect(await page.locator('input').count()).toBeGreaterThan(0);
			expect(await smallFields(page)).toEqual([]);
		});
	});

	test('html and body paint --bg in light and dark, so iOS overscroll shows no other colour', async ({
		page
	}) => {
		await page.goto('/riwayat');
		await waitForHydration(page);
		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			const colours = await page.evaluate(() => {
				const probe = document.createElement('div');
				probe.style.background = 'var(--bg)';
				document.body.appendChild(probe);
				const bg = getComputedStyle(probe).backgroundColor;
				probe.remove();
				return {
					bg,
					html: getComputedStyle(document.documentElement).backgroundColor,
					body: getComputedStyle(document.body).backgroundColor
				};
			});
			expect(colours.html, scheme).toBe(colours.bg);
			expect(colours.body, scheme).toBe(colours.bg);
		}
	});
});
