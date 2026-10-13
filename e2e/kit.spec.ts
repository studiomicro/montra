import { expect, test } from '@playwright/test';
import {
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	STORAGE_STATE,
	waitForHydration,
	APP_ORIGIN
} from './helpers';

for (const colorScheme of ['light', 'dark'] as const) {
	test(`/dev/ui renders in ${colorScheme} without overflow or CSP violations`, async ({
		browser
	}) => {
		const context = await browser.newContext({
			colorScheme,
			viewport: { width: 360, height: 780 },
			storageState: STORAGE_STATE
		});
		const page = await context.newPage();
		const csp = collectCspViolations(page);
		await page.goto(`${APP_ORIGIN}/dev/ui`);
		await waitForHydration(page);
		await expect(page.getByRole('heading', { level: 1, name: 'UI kit' })).toBeVisible();
		await expect(page.getByText('Data demo')).toBeVisible();
		await expectNoHorizontalScroll(page);
		expect(csp).toEqual([]);
		await context.close();
	});
}

test('kit controls meet the 40 px design-system minimum on phone (Ruling R2)', async ({ page }) => {
	test.skip(!isPhone(page), 'phone only');
	await page.goto('/dev/ui');
	const controls = page.locator('main button:not([disabled]), main [role="radio"]');
	for (const control of await controls.all()) {
		const box = await control.boundingBox();
		if (box) expect(box.height, await control.innerText()).toBeGreaterThanOrEqual(40);
	}
});

test('small pill buttons are 44 px touch targets on phone (Riwayat "Ekspor CSV")', async ({
	page
}) => {
	test.skip(!isPhone(page), 'phone only');
	await page.goto('/riwayat');
	const box = await page.getByRole('link', { name: 'Ekspor CSV' }).boundingBox();
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test('AmountInput produces integer minor units', async ({ page }) => {
	await page.goto('/dev/ui');
	await waitForHydration(page);
	await page.getByLabel('Jumlah').fill('25000');
	await expect(page.getByText('amount_minor = 2500000')).toBeVisible();
	await expect(page.getByLabel('Jumlah')).toHaveValue('25.000');
});
