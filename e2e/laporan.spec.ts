import { expect, test, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	expectNoHorizontalScroll,
	simulatedClientIp,
	waitForHydration
} from './helpers';
import { addWallet, freshUser, ids, postExpense, rp } from './ledger';

/**
 * Laporan (FN-09, layout parity wave B): tapping a heatmap day opens that day's transactions, and the
 * Bulanan/Tahunan switch changes the view. Every test signs up its own fictional user in its own context.
 */

const main = (page: Page) => page.locator('main');

/** A wallet and two expenses today (one in Kopi, one in Makan). */
async function seed(page: Page) {
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	const walletId = await wallet('BCA');
	await postExpense(page, {
		walletId,
		categoryId: await category('Kopi'),
		amount: '25000',
		title: 'Kopi Kenangan'
	});
	await postExpense(page, {
		walletId,
		categoryId: await category('Makan'),
		amount: '45000',
		title: 'Warteg'
	});
}

test('tapping today in the heatmap opens that day’s transactions in Riwayat', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'lapb');
	await seed(page);
	await page.goto('/laporan');
	await waitForHydration(page);
	const calendar = main(page).getByRole('group', { name: 'Pengeluaran per hari' });
	const today = calendar.locator('a[aria-current="date"]');
	await expect(today).toHaveCount(1);
	await expect(today).toHaveAccessibleName(new RegExp(rp('70.000')));
	await today.click();
	await page.waitForURL(/\/riwayat\?type=expense&period=range&from=(\d{4}-\d{2}-\d{2})&to=\1$/);
	await expect(main(page).getByText(`2 transaksi · ${rp('70.000')} keluar`)).toBeVisible();
	await context.close();
});

test('the Bulanan/Tahunan switch changes the view and back; no horizontal scroll', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'lapb');
	await seed(page);
	await page.goto('/laporan');
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'Tren harian' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Ke mana uangnya' })).toBeVisible();
	await expectNoHorizontalScroll(page);

	const year = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).slice(0, 4);
	await page.getByRole('radio', { name: 'Tahunan' }).check();
	await page.waitForURL(`${APP_ORIGIN}/laporan?y=${year}`);
	await expect(page.getByRole('heading', { name: 'Tren bulanan' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Kategori dari waktu ke waktu' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Tren harian' })).toHaveCount(0);
	await expect(page.getByRole('radio', { name: 'Tahunan' })).toBeChecked();
	await expectNoHorizontalScroll(page);

	await page.getByRole('radio', { name: 'Bulanan' }).check();
	await page.waitForURL(`${APP_ORIGIN}/laporan`);
	await expect(page.getByRole('heading', { name: 'Tren harian' })).toBeVisible();
	await context.close();
});

test('without JavaScript the Bulanan/Tahunan form switches the view', async ({
	browser
}, testInfo) => {
	const signedUp = await freshUser(browser, testInfo, 'lapb');
	await seed(signedUp.page);
	const storageState = await signedUp.context.storageState();
	await signedUp.context.close();
	const context = await browser.newContext({
		storageState,
		javaScriptEnabled: false,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
	});
	const page = await context.newPage();
	expect((await page.goto('/laporan'))?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: 'Tren harian' })).toBeVisible();
	await page.getByRole('radio', { name: 'Tahunan' }).check();
	await page.getByRole('button', { name: 'Tampilkan' }).click();
	await page.waitForURL(/\/laporan\?p=\d{4}-\d{2}&m=tahun$/);
	await expect(page.getByRole('heading', { name: 'Tren bulanan' })).toBeVisible();
	await expect(page.getByRole('radio', { name: 'Tahunan' })).toBeChecked();
	await context.close();
});
