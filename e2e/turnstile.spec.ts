import { expect, test, type Browser, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration
} from './helpers';

/**
 * FN-50 Part A in a real browser, against Cloudflare's documented Turnstile test keys. The e2e server reads them
 * from `.dev.vars` (never committed): QA_TS_MODE=pass has the always-pass site key and secret, QA_TS_MODE=fail the
 * always-pass site key with the always-fail secret. Without QA_TS_MODE the file is skipped (Turnstile is unset on
 * the default e2e server). The widget script loads from challenges.cloudflare.com, so this needs network access.
 */
const MODE = process.env.QA_TS_MODE;
test.skip(!MODE, 'needs Turnstile test keys in .dev.vars (QA_TS_MODE=pass|fail)');
test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: 180_000 });

const PASSWORD = 'terang-benderang-8';
const BOT_FAILED = 'Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.';
const freshEmail = (tag: string) =>
	`fn50ts-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

let contexts = 0;
async function newDevice(
	browser: Browser,
	opts: { javaScriptEnabled?: boolean; locale?: string } = {}
) {
	const context = await browser.newContext({
		baseURL: APP_ORIGIN,
		locale: opts.locale ?? 'id-ID',
		viewport: { width: 360, height: 780 },
		hasTouch: opts.javaScriptEnabled !== false,
		isMobile: opts.javaScriptEnabled !== false,
		javaScriptEnabled: opts.javaScriptEnabled ?? true,
		storageState: SIGNED_OUT
	});
	// The simulated client address goes to the app only: a custom header on Cloudflare's own requests would break the widget.
	const ip = simulatedClientIp(test.info(), ++contexts);
	await context.route(`${APP_ORIGIN}/**`, (route) =>
		route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } })
	);
	return { context, page: await context.newPage() };
}

const token = (page: Page) => page.locator('input[name="cf-turnstile-response"]');

test.describe('turnstile pass keys', () => {
	test.skip(MODE !== 'pass');

	test('the widget fits a 360 px column on /daftar and /masuk, asks for Indonesian, CSP clean; the dummy token is refused (hostname example.com)', async ({
		browser
	}) => {
		const { context, page } = await newDevice(browser);
		const csp = collectCspViolations(page);
		const asked: string[] = [];
		page.on('request', (r) => {
			if (r.url().includes('challenges.cloudflare.com/cdn-cgi')) asked.push(r.url());
		});
		const response = await page.goto('/daftar');
		expect(response!.headers()['content-security-policy']).toContain(
			'https://challenges.cloudflare.com'
		);
		await waitForHydration(page);
		await expect(page.getByTestId('turnstile')).toHaveAttribute('data-action', 'sign-up');
		await expect(token(page)).not.toHaveValue('', { timeout: 30_000 });
		await expectNoHorizontalScroll(page);
		await page.goto('/masuk');
		await waitForHydration(page);
		await expect(page.getByTestId('turnstile')).toHaveAttribute('data-action', 'sign-in');
		await expect(token(page)).not.toHaveValue('', { timeout: 30_000 });
		await expectNoHorizontalScroll(page);
		const box = await page.locator('[data-testid="turnstile"] > div').boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(360);
		expect(asked.some((u) => u.includes('lang=id'))).toBe(true);
		await page.screenshot({ path: 'test-results/qa-turnstile-masuk-360.png' });
		// Cloudflare's always-pass dummy secret answers hostname "example.com" and no action: the strict check
		// (AC 6) refuses it, so the success path is covered by the stubbed integration test, and a real widget by AC 15.
		await page.getByLabel('E-mail').fill(freshEmail('pass'));
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await expect(page.getByText(BOT_FAILED)).toBeVisible({ timeout: 30_000 });
		expect(csp).toEqual([]);
		await context.close();
	});

	test('English UI asks the widget for English; CSP of / is unchanged (no widget origin)', async ({
		browser
	}) => {
		const { context, page } = await newDevice(browser, { locale: 'en-US' });
		await context.addCookies([{ name: 'lang', value: 'en', url: APP_ORIGIN }]);
		const asked: string[] = [];
		page.on('request', (r) => {
			if (r.url().includes('challenges.cloudflare.com/cdn-cgi')) asked.push(r.url());
		});
		await page.goto('/masuk');
		await waitForHydration(page);
		await expect(token(page)).not.toHaveValue('', { timeout: 30_000 });
		expect(asked.some((u) => u.includes('lang=en'))).toBe(true);
		const res = await page.request.get('/pengaturan/akun', { maxRedirects: 0 });
		expect(res.headers()['content-security-policy'] ?? '').not.toContain(
			'challenges.cloudflare.com'
		);
		await context.close();
	});

	test('JavaScript off: the noscript line is shown and a post without a token is refused, never signed in', async ({
		browser
	}) => {
		const { context, page } = await newDevice(browser, { javaScriptEnabled: false });
		await page.goto('/masuk');
		// Playwright's text locators skip <noscript>; innerText shows what the user sees.
		await expect(page.locator('body')).toContainText(
			'Verifikasi keamanan membutuhkan JavaScript. Aktifkan JavaScript lalu muat ulang.',
			{ useInnerText: true }
		);
		await page.getByLabel('E-mail').fill(freshEmail('nojs'));
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await expect(page.getByText(BOT_FAILED)).toBeVisible();
		await expect(page).toHaveURL(/\/masuk/);
		await context.close();
	});
});

test.describe('turnstile fail secret', () => {
	test.skip(MODE !== 'fail');

	test('a refused token shows the message, resets the widget and a second attempt works without reload', async ({
		browser
	}) => {
		const { context, page } = await newDevice(browser);
		await page.goto('/masuk');
		await waitForHydration(page);
		await expect(token(page)).not.toHaveValue('', { timeout: 30_000 });
		await page.getByLabel('E-mail').fill(freshEmail('fail'));
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		const first = await token(page).inputValue();
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await expect(page.getByText(BOT_FAILED)).toBeVisible({ timeout: 30_000 });
		// Widget reset: a fresh token (the spent one is replaced) without a page reload.
		await expect.poll(async () => token(page).inputValue(), { timeout: 30_000 }).not.toBe(first);
		await expect(token(page)).not.toHaveValue('');
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await expect(page.getByText(BOT_FAILED)).toBeVisible();
		await expect(page).toHaveURL(/\/masuk/);
		await context.close();
	});
});
