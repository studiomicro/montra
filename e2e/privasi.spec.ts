import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	tickSignUpBoxes,
	waitForHydration
} from './helpers';

/**
 * FN-31 journeys: the privacy page at 360 px, the statistics switch persisting, and the account export as a
 * real browser download (fetch → blob → save under the strict CSP). Each test signs up its own user.
 */
const PASSWORD = 'terang-benderang-8';

async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: { javaScriptEnabled?: boolean } = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		acceptDownloads: true,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) },
		...opts
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pemilik Privasi');
	await page
		.getByLabel('E-mail')
		.fill(`fn31-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${APP_ORIGIN}/`);
	return { context, page };
}

test('privacy page: consent shown, statistics switch persists, export downloads a ZIP', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	await page.goto('/pengaturan');
	await page.locator('main').getByRole('link', { name: 'Privasi' }).click();
	await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/privasi`);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Privasi' })).toBeVisible();
	await expectNoHorizontalScroll(page);

	// Consent recorded at sign-up: the three kinds, each with its version.
	for (const label of [
		'Ketentuan layanan',
		'Kebijakan privasi',
		'Pemberitahuan pemrosesan di luar Indonesia'
	])
		await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
	await expect(page.getByText(/Versi 8 Okt 2026, disetujui/).first()).toBeVisible();
	await expect(page.getByRole('link', { name: 'Buka Pengaturan › Akun' })).toHaveAttribute(
		'href',
		'/pengaturan/akun'
	);

	// Statistics: on by default; off is stored and survives a reload.
	const stats = page.getByRole('switch', { name: 'Kirim statistik pemakaian' });
	await expect(stats).toBeChecked();
	await stats.click();
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await expect(stats).not.toBeChecked();
	await page.reload();
	await expect(page.getByRole('switch', { name: 'Kirim statistik pemakaian' })).not.toBeChecked();

	// Export: a real download of a ZIP; success shows only once it has fully arrived.
	await waitForHydration(page);
	const downloading = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Ekspor semua data' }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toMatch(/^montra-ekspor-\d{4}-\d{2}-\d{2}\.zip$/);
	const bytes = readFileSync((await download.path())!);
	expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
	expect(bytes.includes(Buffer.from('account.json'))).toBe(true);
	expect(bytes.includes(Buffer.from('transactions-01-pribadi.csv'))).toBe(true);
	await expect(page.getByText('Ekspor selesai. File sudah diunduh.')).toBeVisible();

	expect(csp).toEqual([]);
	await context.close();
});

test('without JavaScript the export still downloads and the switch saves with its button', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/pengaturan/privasi');
	// Keyboard, not a pointer: on a phone the floating tab bar may cover the button's position.
	const downloading = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Ekspor semua data' }).press('Enter');
	expect((await downloading).suggestedFilename()).toMatch(/\.zip$/);

	await page.goto('/pengaturan/privasi');
	await page.getByRole('switch', { name: 'Kirim statistik pemakaian' }).uncheck();
	await page.getByRole('button', { name: 'Simpan' }).press('Enter');
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await page.goto('/pengaturan/privasi');
	await expect(page.getByRole('switch', { name: 'Kirim statistik pemakaian' })).not.toBeChecked();
	await context.close();
});
