import { createHash } from 'node:crypto';
import {
	expect,
	test,
	type Browser,
	type BrowserContext,
	type BrowserContextOptions,
	type ConsoleMessage,
	type Page,
	type TestInfo
} from '@playwright/test';

/** Session of the shared fictional e2e user, written once per run by auth.setup.ts (gitignored). */
export const E2E_PORT = process.env.E2E_PORT ?? '8787';
export const STORAGE_STATE = `playwright/.auth/user-${E2E_PORT}.json`;
// FN-41 personal AI keys for the e2e server only: a fixed, local-only 32-byte sealing key, not a real secret.
export const E2E_AI_KEYS_KEY = 'ZTJlLWFpLWtleXMtbG9jYWwtb25seS1ub3QtcmVhbCE';

/** A context that starts signed out, for journeys that must not carry the shared session. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/**
 * A simulated client address for one test (and `n`-th context in it), in the benchmarking range 198.18.0.0/15.
 * The sign-in/sign-up throttle counts 20 attempts per client per 10 minutes; under `wrangler dev` every request
 * would otherwise come from loopback and share one budget across the whole run. Wrangler passes a client-sent
 * CF-Connecting-IP through (production Cloudflare overwrites it), so each test gets its own budget, exactly as
 * separate real users would, without any test-only switch in the app.
 */
export function simulatedClientIp(testInfo: TestInfo, n = 0): string {
	const seed = `${testInfo.testId}|${testInfo.project.name}|${testInfo.retry}|${testInfo.repeatEachIndex}|${n}`;
	const [a = 0, b = 0, c = 0] = createHash('sha256').update(seed).digest();
	return `198.${18 + (a & 1)}.${b}.${c}`;
}

/** CSP violations reported in the console by the page or any of its workers. */
export function collectCspViolations(page: Page): string[] {
	const violations: string[] = [];
	const onConsole = (m: ConsoleMessage) => {
		if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
	};
	page.on('console', onConsole);
	page.on('worker', (w) => w.on('console', onConsole));
	return violations;
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Wait until the page is hydrated, so clicks and typing reach Svelte handlers: the root layout sets
 * `data-hydrated` on <html> in its onMount (src/routes/+layout.svelte). A client-side navigation keeps the
 * root layout, so after one this returns at once; wait for its URL or content instead.
 */
export async function waitForHydration(page: Page): Promise<void> {
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
}

/** A transaction's edit page `/riwayat/<id>/edit`. */
export const TX_PAGE = /\/riwayat\/[^/?]+\/edit$/;
/** A recurring series' page `/riwayat/berulang/<id>` (not baru). */
export const SERIES_PAGE = /\/riwayat\/berulang\/(?!baru)[^/?]+$/;

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;

/** Port of the app under test; parallel runs set E2E_PORT (see playwright.config.ts). */
export const APP_ORIGIN = `http://localhost:${E2E_PORT}`;
export const SITE_ORIGIN = `http://site.localhost:${E2E_PORT}`;

/** Ticks the sign-up form's required boxes: 18+ (FN-01) and the terms/privacy/cross-border consent (FN-31). */
export async function tickSignUpBoxes(page: Page): Promise<void> {
	await page.getByRole('checkbox', { name: /18 tahun/ }).check();
	await page.getByRole('checkbox', { name: /Saya menyetujui/ }).check();
}

/** The password every fictional e2e user signs up with, unless a test is about the password itself. */
export const PASSWORD = 'terang-benderang-8';

/** A unique, throwaway e-mail address: `<prefix>-<time>-<random>@example.test`. */
export function uniqueEmail(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/**
 * Fills and submits the sign-up form on `/daftar` and waits for the server's redirect away from it (a navigation
 * started before it lands would abort the sign-up). `js: false` skips the hydration wait, for a context without
 * JavaScript.
 */
export async function signUp(
	page: Page,
	o: {
		email: string;
		name?: string;
		password?: string;
		next?: string;
		js?: boolean;
		timeout?: number;
	}
): Promise<void> {
	await page.goto(o.next ? `/daftar?next=${encodeURIComponent(o.next)}` : '/daftar');
	if (o.js !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill(o.name ?? 'Budi Santoso');
	await page.getByLabel('E-mail').fill(o.email);
	await page.getByLabel('Kata sandi').fill(o.password ?? PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL((url) => url.pathname !== '/daftar', { timeout: o.timeout });
}

let devices = 0;

/**
 * A signed-out context with its own simulated client address (the `n`-th of this worker), for specs that open
 * several "devices" in one test. `opts` are plain Playwright context options.
 */
export async function newDevice(
	browser: Browser,
	opts: BrowserContextOptions = {}
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		baseURL: APP_ORIGIN,
		locale: 'id-ID',
		storageState: SIGNED_OUT,
		...opts,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(test.info(), ++devices) }
	});
	return { context, page: await context.newPage() };
}

export type UserOptions = {
	/** E-mail prefix, to tell a spec's users apart in the local D1. */
	prefix?: string;
	name?: string;
	password?: string;
	/** Which simulated client address of this test the context uses. */
	n?: number;
	sapaanOff?: boolean;
} & BrowserContextOptions;

/**
 * A new fictional user in its own signed-out context (own simulated client address `n`), signed up through the
 * real form and landed on Beranda. Returns the e-mail too, so a spec that seeds the local D1 can find this
 * user's own space. `sapaanOff` sets the FN-54 device cookie that keeps the once-a-day greeting sheet from
 * covering Beranda (only e2e/sapaan.spec.ts wants it on). `opts` are plain Playwright context options.
 */
export async function newUser(browser: Browser, testInfo: TestInfo, o: UserOptions = {}) {
	const { prefix = 'e2e', name, password, n = 1, sapaanOff = false, ...opts } = o;
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		...opts,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, n) }
	});
	const page = await context.newPage();
	const email = uniqueEmail(prefix);
	await signUp(page, { email, name, password, js: opts.javaScriptEnabled !== false });
	await page.waitForURL(`${APP_ORIGIN}/`);
	if (sapaanOff)
		await context.addCookies([{ name: 'montra-sapaan-off', value: '1', url: APP_ORIGIN }]);
	return { context, page, email };
}
