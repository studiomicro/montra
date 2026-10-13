import { expect, test } from '@playwright/test';
import { APP_ORIGIN, collectCspViolations, waitForHydration } from './helpers';

/**
 * Geist (owner decision 2026-10-10): the page text is set in Geist and the font file comes from the app's own
 * origin (CSP `font-src 'self'`, no third-party request), immutable-cached from its versioned path.
 */
const SANS = '/fonts/geist/1.7.2/Geist-Variable.woff2';

test('body uses Geist, served from the app origin, with no foreign font request', async ({
	page
}) => {
	const csp = collectCspViolations(page);
	const fontRequests: string[] = [];
	page.on('request', (r) => {
		if (r.resourceType() === 'font' || /\.(woff2?|ttf|otf)(\?|$)/.test(r.url()))
			fontRequests.push(r.url());
	});
	const served = page.waitForResponse((r) => new URL(r.url()).pathname === SANS);
	await page.goto('/');
	await waitForHydration(page);

	const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
	expect(family).toMatch(/^"?Geist"?,/);

	const response = await served;
	expect(new URL(response.url()).origin).toBe(APP_ORIGIN);
	expect(response.status()).toBe(200);
	expect(response.headers()['content-type']).toContain('font/woff2');

	// The face was used, not only declared: Geist is loaded for regular and bold text.
	const loaded = await page.evaluate(async () => {
		await document.fonts.ready;
		return [document.fonts.check('400 16px Geist'), document.fonts.check('700 16px Geist')];
	});
	expect(loaded).toEqual([true, true]);

	// Every font request went to this origin; nothing to Google or any other host.
	const origin = new URL(page.url()).origin;
	expect(fontRequests.length).toBeGreaterThan(0);
	for (const url of fontRequests) expect(new URL(url).origin).toBe(origin);
	expect(csp).toEqual([]);
});

test('the font is cached as immutable and amounts keep tabular figures', async ({ page }) => {
	const response = await page.request.get(SANS);
	expect(response.status()).toBe(200);
	expect(response.headers()['cache-control']).toMatch(/immutable/);
	expect(response.headers()['cache-control']).toMatch(/max-age=31536000/);
	await page.goto('/');
	await waitForHydration(page);
	const numeric = await page.evaluate(() => {
		const el = document.querySelector('.num');
		return el ? getComputedStyle(el).fontVariantNumeric : null;
	});
	expect(numeric).toContain('tabular-nums');
});
