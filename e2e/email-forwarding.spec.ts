import { expect, test } from '@playwright/test';
import { APP_ORIGIN, expectNoHorizontalScroll, STORAGE_STATE, waitForHydration } from './helpers';

/**
 * FN-19 forwarding, QA cycle 1. The e2e server has no INBOUND_EMAIL_DOMAIN (production's state before the owner
 * sets it up): the setup page says why and offers no create control. The configured states are covered in
 * test/integration/forwarding.test.ts.
 */
test('/pengaturan/aplikasi/email without a domain: reason shown, no create control, no horizontal scroll', async ({
	page
}) => {
	await page.goto('/pengaturan/aplikasi');
	await waitForHydration(page);
	await page
		.locator('main')
		.getByRole('link', { name: /Alamat penerusan e-mail/ })
		.first()
		.click();
	await page.waitForURL(/\/pengaturan\/aplikasi\/email$/);
	await waitForHydration(page);
	await expect(page.locator('main').getByText('Belum dikonfigurasi').first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Buat alamat' })).toHaveCount(0);
	await expectNoHorizontalScroll(page);
});

test('the setup page renders without JavaScript', async ({ browser }) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: STORAGE_STATE
	});
	const page = await context.newPage();
	await page.goto(`${APP_ORIGIN}/pengaturan/aplikasi/email`);
	await expect(page.locator('main').getByText('Belum dikonfigurasi').first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Buat alamat' })).toHaveCount(0);
	await context.close();
});
