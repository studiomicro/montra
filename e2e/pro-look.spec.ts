import { expect, test, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	waitForHydration
} from './helpers';
import { freshUser } from './ledger';

/**
 * FN-46 Pro look in a real browser at 360 px: what only a browser shows — the rendered theme after a forged
 * cookie, the no-JavaScript Emas pick, the locked rows and the badge's layout. The plan comes from the "mode uji"
 * checkout (BILLING_MOCK_ENABLED=1, no provider). Everything else (lapse, Agen, manifest bodies, contrast) is in
 * Vitest (test/integration/pro-look.test.ts, test/pro-look-ui.test.ts, test/contrast.test.ts).
 */

const PHONE = { width: 360, height: 780 };

async function upgradeToPro(page: Page) {
	await page.goto('/pengaturan/paket');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Pilih Pro (mode uji)' }).click();
	await expect(page).toHaveURL(/\/pengaturan\/paket\/uji\/mock_[A-Za-z0-9_-]+$/);
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Bayar (mode uji)' }).click();
	await expect(page.getByText('Pembayaran uji berhasil. Paketmu sekarang Pro.')).toBeVisible();
}

async function expectTargets(page: Page, selector: string) {
	for (const el of await page.locator(selector).all())
		expect((await el.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
}

test('Gratis sees locked Pro themes and a forged gold cookie renders as system; on Pro the look follows (360 px)', async ({
	browser
}, testInfo) => {
	test.skip(testInfo.project.name !== 'phone', 'one 360 px run is enough');
	const { context, page } = await freshUser(browser, testInfo, 'fn46');
	await page.setViewportSize(PHONE);
	const csp = collectCspViolations(page);

	// Gratis: the two Pro rows lead to Paket, with the reason; no badge anywhere.
	await page.goto('/pengaturan/tampilan');
	await waitForHydration(page);
	const locked = page.getByRole('link', { name: /Emas.*Perlu paket Pro atau Agen/ });
	await expect(locked).toHaveAttribute('href', '/pengaturan/paket');
	await expect(
		page.getByRole('link', { name: /Hijau tua.*Perlu paket Pro atau Agen/ })
	).toBeVisible();
	await expect(page.getByRole('radio', { name: /^Emas/ })).toHaveCount(0);
	await expectTargets(page, 'main li > a.row, main label.row');
	await expectNoHorizontalScroll(page);
	await locked.click();
	await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/paket`);

	// A hand-set Pro cookie and a forged form post change nothing.
	await context.addCookies([{ name: 'theme', value: 'gold', url: APP_ORIGIN }]);
	await page.goto('/riwayat');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
	const forged = await page.request.post('/pengaturan/tampilan?/theme', {
		form: { theme: 'gold' },
		headers: { origin: APP_ORIGIN }
	});
	expect(forged.status()).toBe(403);
	expect(forged.headers()['set-cookie'] ?? '').not.toContain('theme=gold');
	await page.goto('/pengaturan');
	await expect(page.getByTestId('pro-badge')).toHaveCount(0);
	await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
		'href',
		/\/icons\/apple-touch-icon\.png$/
	);

	// Pro: the stored plan now allows the cookie it already holds.
	await upgradeToPro(page);
	await page.goto('/pengaturan');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'gold');
	const who = page.getByTestId('settings-account');
	await expect(who.getByTestId('pro-badge')).toBeVisible();
	await expect(who).toContainText('Pencatat');
	await expectNoHorizontalScroll(page);
	await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
		'href',
		/\/icons\/apple-touch-icon-pro\.png$/
	);
	const manifest = await (await page.request.get('/manifest.webmanifest')).json();
	expect(manifest.icons.map((i: { src: string }) => i.src)).toContain('/icons/icon-192-pro.png');

	await page.goto('/pengaturan/paket');
	await expect(page.getByTestId('pro-card')).toContainText('Paketmu: Pro');
	await expectNoHorizontalScroll(page);

	await page.goto('/pengaturan/instal');
	await expect(page.getByTestId('pro-icon-note')).toContainText('memasang ulang');

	// Beranda: the hero frame (FN-54: on the greeting card, once), and Koko's crown on the first-wallet card.
	await page.goto('/');
	await expect(page.locator('section.greeting.pro')).toBeVisible();
	await expect(page.locator('section.hero.pro')).toHaveCount(0);
	expect(
		await page
			.locator('section.greeting.pro')
			.evaluate((el) => getComputedStyle(el).backgroundImage)
	).toContain('gradient');
	await expect(page.locator('.first-wallet svg.mascot rect.k-crown').first()).toBeAttached();
	await expectNoHorizontalScroll(page);

	// Without JavaScript Hijau tua is saved by the form; the next page shows it.
	const noJs = await browser.newContext({
		javaScriptEnabled: false,
		viewport: PHONE,
		storageState: await context.storageState()
	});
	const plain = await noJs.newPage();
	await plain.goto(`${APP_ORIGIN}/pengaturan/tampilan`);
	await plain.getByRole('radio', { name: /^Hijau tua/ }).check();
	await plain.getByRole('button', { name: 'Simpan' }).first().click();
	await expect(plain.getByText('Perubahan disimpan.')).toBeVisible();
	await expect(plain.locator('html')).toHaveAttribute('data-theme', 'emerald');
	await plain.goto(`${APP_ORIGIN}/riwayat`);
	await expect(plain.locator('html')).toHaveAttribute('data-theme', 'emerald');
	await expect(plain.locator('meta[name="theme-color"]').first()).toHaveAttribute(
		'content',
		'#fbfefc'
	);
	await expectTargets(plain, 'main label.row');
	await expectNoHorizontalScroll(plain);
	await noJs.close();

	expect(csp).toEqual([]);
	await context.close();
});
