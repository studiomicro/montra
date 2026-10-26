import { expect, test } from '@playwright/test';
import { APP_ORIGIN, expectNoHorizontalScroll, STORAGE_STATE, waitForHydration } from './helpers';

/**
 * FN-40 Part 1: Pengaturan › Tampilan writes the `theme` cookie server-side. Each test has its own browser
 * context, so the shared e2e user's other tests never see the choice.
 */

test('without JavaScript the choice is saved by the form and the next page shows it', async ({
	browser
}) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: STORAGE_STATE
	});
	const page = await context.newPage();
	await page.goto(`${APP_ORIGIN}/pengaturan/tampilan`);
	await expect(page.getByRole('heading', { level: 1, name: 'Tampilan' })).toBeVisible();
	await expect(page.getByRole('radio', { name: /^Sistem/ })).toBeChecked();
	await page.getByRole('radio', { name: /^Hitam-putih/ }).check();
	await page.getByRole('button', { name: 'Simpan' }).first().click();
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'mono');
	await expect(page.getByRole('radio', { name: /^Hitam-putih/ })).toBeChecked();
	await page.goto(`${APP_ORIGIN}/riwayat`);
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'mono');
	await context.close();
});

test('an unknown value is refused and nothing changes', async ({ page }) => {
	const res = await page.request.post('/pengaturan/tampilan?/theme', {
		form: { theme: 'neon' },
		headers: { origin: APP_ORIGIN }
	});
	expect(res.status()).toBe(400);
	expect(res.headers()['set-cookie'] ?? '').not.toContain('theme=');
});

test('with JavaScript a picked row saves at once; rows are 44 px targets at 360 px', async ({
	page
}) => {
	await page.goto('/pengaturan');
	await page.getByRole('link', { name: /^Tampilan/ }).click();
	await expect(page).toHaveURL(/\/pengaturan\/tampilan$/);
	await waitForHydration(page);
	await expect(page.getByRole('button', { name: 'Simpan' })).toHaveCount(0);
	await page.getByRole('radio', { name: /^Gelap/ }).check();
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await expect(page.getByRole('radio', { name: /^Gelap/ })).toBeChecked();
	// Back to Sistem: the cookie is cleared and the device scheme decides again.
	await waitForHydration(page);
	await page.getByRole('radio', { name: /^Sistem/ }).check();
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
	const cookies = await page.context().cookies();
	expect(cookies.find((c) => c.name === 'theme')).toBeUndefined();
	for (const row of await page.locator('label.row').all()) {
		expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
	}
	await expectNoHorizontalScroll(page);
});
