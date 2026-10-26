import { expect, test } from '@playwright/test';
import { collectCspViolations, expectNoHorizontalScroll, waitForHydration } from './helpers';

/**
 * FN-29 Aplikasi terhubung. The e2e server has no CONNECTED_APPS_ENCRYPTION_KEY and no provider app exists, which
 * is production's state today: every app reads "Belum dikonfigurasi" and "Hubungkan" never makes a request. The
 * configured seed → disconnect path is covered in test/integration/aplikasi.test.ts.
 */
const APPS = ['Gmail', 'Google Sheets', 'Google Calendar', 'Notion', 'Slack'];

test('settings → Aplikasi terhubung: five apps, all "Belum dikonfigurasi"; Hubungkan is disabled and silent', async ({
	page
}) => {
	const csp = collectCspViolations(page);
	await page.goto('/pengaturan');
	await waitForHydration(page);
	await page.locator('main').getByRole('link', { name: 'Aplikasi terhubung' }).click();
	await page.waitForURL(/\/pengaturan\/aplikasi$/);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'Aplikasi terhubung' })).toBeVisible();
	await expect(page.getByText('Belum ada aplikasi yang terhubung.')).toBeVisible();
	const rows = page.getByRole('listitem');
	for (const name of APPS) {
		const row = rows.filter({ hasText: name });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText('Belum dikonfigurasi');
	}
	await expect(page.getByText(/^Terhubung$/)).toHaveCount(0);
	await expectNoHorizontalScroll(page);

	// FN-19: the Gmail row opens its own page (e2e/gmail.spec.ts); the other four open the sheet.
	for (const name of APPS.filter((app) => app !== 'Gmail')) {
		await rows.filter({ hasText: name }).getByRole('link').click();
		const sheet = page.getByRole('dialog', { name });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByText(/^Nantinya /)).toBeVisible();
		const connect = sheet.getByRole('button', { name: 'Hubungkan' });
		await expect(connect).toBeDisabled();
		await expect(sheet.getByText('Belum dikonfigurasi')).toBeVisible();
		await expect(sheet.getByText('Putuskan')).toHaveCount(0);
		// AC1: clicking the disabled control sends nothing.
		const requests: string[] = [];
		const record = (r: { url: () => string }) => requests.push(r.url());
		page.on('request', record);
		await connect.click({ force: true });
		// Proves a negative: no request follows the click, so there is nothing to await; a short grace is all there is.
		await page.waitForTimeout(300);
		page.off('request', record);
		expect(requests).toEqual([]);
		await sheet.getByRole('button', { name: 'Tutup' }).click();
		await expect(sheet).toBeHidden();
	}
	expect(csp).toEqual([]);
});

test('the dev seed answers "Belum dikonfigurasi" without a key and changes nothing', async ({
	page
}) => {
	await page.goto('/pengaturan/aplikasi');
	await waitForHydration(page);
	await page.getByLabel('Aplikasi').selectOption('notion');
	await page.getByRole('button', { name: 'Tambah sambungan contoh' }).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Belum dikonfigurasi' })).toBeVisible();
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByRole('listitem').filter({ hasText: 'Notion' })).toContainText(
		'Belum dikonfigurasi'
	);
});

test('without JavaScript, ?app= shows the detail inline', async ({ browser }, testInfo) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: testInfo.project.use.storageState
	});
	const page = await context.newPage();
	await page.goto('/pengaturan/aplikasi?app=slack');
	const inline = page.locator('section.inline-detail');
	await expect(inline.getByRole('heading', { name: 'Slack' })).toBeVisible();
	await expect(inline.getByRole('button', { name: 'Hubungkan' })).toBeDisabled();
	await expect(inline.getByText('Belum dikonfigurasi')).toBeVisible();
	await context.close();
});
