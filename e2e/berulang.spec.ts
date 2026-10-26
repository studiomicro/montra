import { expect, test, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	SERIES_PAGE,
	waitForHydration
} from './helpers';
import { addWallet, freshUser, rp } from './ledger';

/**
 * FN-36 journeys. Every test signs up its own fictional user in its own context, so its personal space starts
 * without series or wallets. The cron that creates instances is covered by Vitest against local D1
 * (test/integration/recurring.test.ts); here: the pages, the Riwayat chip, 360 px, both themes, no JavaScript.
 */
const main = (page: Page) => page.locator('main');
const seriesRow = (page: Page, title: string) =>
	main(page).locator('a[href^="/riwayat/berulang/"]').filter({ hasText: title });

async function fillSeries(page: Page, title: string, amount: string) {
	await page.getByLabel('Jumlah').fill(amount);
	await main(page)
		.locator('label.tile')
		.filter({ has: page.locator('.tile-name', { hasText: /^Tempat Tinggal$/ }) })
		.click();
	await page.getByLabel('Judul (opsional)').fill(title);
}

async function expectTargets(page: Page, targets: ReturnType<Page['locator']>[]) {
	const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
	if (!coarse) return;
	for (const target of targets) {
		const box = await target.boundingBox();
		expect(
			box?.height,
			await target.evaluate((e) => e.outerHTML.slice(0, 80))
		).toBeGreaterThanOrEqual(44);
	}
}

for (const colorScheme of ['light', 'dark'] as const) {
	test(`create, pause and resume a monthly series; the Aktif berulang chip (${colorScheme})`, async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn36');
		await page.emulateMedia({ colorScheme });
		const csp = collectCspViolations(page);
		await addWallet(page, 'BCA');

		await page.goto('/riwayat/berulang');
		await waitForHydration(page);
		await expect(main(page).getByText('Belum ada transaksi berulang')).toBeVisible();
		await expectNoHorizontalScroll(page);
		await main(page).getByRole('link', { name: 'Tambah transaksi berulang' }).click();
		await page.waitForURL(`${APP_ORIGIN}/riwayat/berulang/baru`);
		await waitForHydration(page);

		await fillSeries(page, 'Sewa kos', '1500000');
		await page.getByLabel('Tanggal', { exact: true }).selectOption('31');
		// Weekly shows the weekday field instead of the day of month (CSS on the checked radio).
		await page.getByRole('radio', { name: 'Mingguan' }).check();
		await expect(page.getByLabel('Hari', { exact: true })).toBeVisible();
		await expect(page.getByLabel('Tanggal', { exact: true })).toBeHidden();
		await page.getByRole('radio', { name: 'Bulanan' }).check();
		await expectNoHorizontalScroll(page);
		await expectTargets(page, [
			page.getByLabel('Tanggal', { exact: true }),
			main(page).getByLabel('Dompet'),
			page.getByRole('button', { name: 'Simpan transaksi berulang' })
		]);
		await page.getByRole('button', { name: 'Simpan transaksi berulang' }).click();

		await page.waitForURL(/\/riwayat\/berulang\?saved=created/);
		await expect(page.getByText('Transaksi berulang disimpan.')).toBeVisible();
		const row = seriesRow(page, 'Sewa kos');
		await expect(row).toContainText('Tiap tanggal 31');
		await expect(row).toContainText(`−${rp('1.500.000')}`);
		await expectNoHorizontalScroll(page);
		await expectTargets(page, [row, main(page).getByRole('link', { name: 'Tambah' })]);

		// Pause, then resume (success shown only after the server's redirect).
		await row.click();
		await page.waitForURL(SERIES_PAGE);
		await waitForHydration(page);
		await expect(page.getByRole('heading', { name: 'Ubah seri' })).toBeVisible();
		await expectNoHorizontalScroll(page);
		await expectTargets(page, [page.getByRole('button', { name: 'Jeda' })]);
		await page.getByRole('button', { name: 'Jeda' }).click();
		await page.waitForURL(/saved=paused/);
		await expect(page.getByText('Seri dijeda.')).toBeVisible();
		await expect(seriesRow(page, 'Sewa kos')).toContainText('Dijeda');
		await seriesRow(page, 'Sewa kos').click();
		await page.waitForURL(SERIES_PAGE);
		await waitForHydration(page);
		await page.getByRole('button', { name: 'Lanjutkan' }).click();
		await page.waitForURL(/saved=resumed/);
		await expect(seriesRow(page, 'Sewa kos')).toContainText('Berikutnya');

		// Transaksi: the chip toggles `berulang=1` and keeps the page within 360 px.
		await page.goto('/riwayat');
		await waitForHydration(page);
		const chip = main(page).getByRole('link', { name: 'Aktif berulang' });
		await expectTargets(page, [
			chip,
			main(page).getByRole('link', { name: 'Berulang', exact: true })
		]);
		await chip.click();
		await page.waitForURL(/berulang=1/);
		await expect(main(page).getByRole('link', { name: 'Aktif berulang' })).toHaveAttribute(
			'aria-current',
			'true'
		);
		await expectNoHorizontalScroll(page);
		expect(csp).toEqual([]);
		await context.close();
	});
}

test('without JavaScript: a refused series shows its error; a valid one is saved and listed', async ({
	browser
}, testInfo) => {
	const { context: signedIn, page: setup } = await freshUser(browser, testInfo, 'fn36nojs');
	await addWallet(setup, 'BCA');
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: await signedIn.storageState()
	});
	const page = await context.newPage();
	await page.goto('/riwayat/berulang/baru');
	await fillSeries(page, 'Gaji', '0');
	await page.getByRole('button', { name: 'Simpan transaksi berulang' }).click();
	await expect(
		page.getByText('Isi jumlah lebih dari 0 dengan angka bulat, tanpa sen.')
	).toBeVisible();
	await fillSeries(page, 'Sewa kos', '1.250.000');
	await page.getByRole('button', { name: 'Simpan transaksi berulang' }).click();
	await expect(page).toHaveURL(/\/riwayat\/berulang\?saved=created/);
	await expect(page.getByText('Transaksi berulang disimpan.')).toBeVisible();
	await expect(seriesRow(page, 'Sewa kos')).toContainText(`−${rp('1.250.000')}`);
	await context.close();
	await signedIn.close();
});
