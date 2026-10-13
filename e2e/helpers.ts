import { createHash } from 'node:crypto';
import { expect, type Page, type TestInfo } from '@playwright/test';

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

export function collectCspViolations(page: Page): string[] {
	const violations: string[] = [];
	page.on('console', (m) => {
		if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
	});
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
