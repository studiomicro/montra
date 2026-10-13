import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	tickSignUpBoxes,
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration
} from './helpers';

/**
 * FN-25 journeys: add net-worth items in the sheet and see the total. Each test signs up its own fictional user.
 * No price source is reached here: the e2e server's KV starts empty (the cron never runs), so a priced item
 * shows "Belum ada harga" — the cold-cache state — and its figure is never invented.
 */
const PASSWORD = 'terang-benderang-8';

async function freshUser(browser: Browser, testInfo: TestInfo) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) }
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pemilik Aset');
	await page
		.getByLabel('E-mail')
		.fill(`fn25-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${APP_ORIGIN}/`);
	return { context, page };
}

async function addItem(
	page: Page,
	item: {
		kind: string;
		name: string;
		value?: string;
		source?: string;
		symbol?: string;
		quantity?: string;
	}
) {
	await page.getByRole('link', { name: 'Tambah aset' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah aset' });
	await expect(sheet).toBeVisible();
	await sheet.getByRole('radio', { name: item.kind, exact: true }).check();
	await sheet.getByLabel('Nama aset').fill(item.name);
	if (item.source) await sheet.getByLabel('Sumber nilai').selectOption({ label: item.source });
	if (item.symbol) await sheet.getByLabel('Kode koin').fill(item.symbol);
	if (item.quantity) await sheet.getByLabel(/^Jumlah/).fill(item.quantity);
	if (item.value) await sheet.getByLabel(/^Nilai/).fill(item.value);
	await sheet.getByRole('button', { name: 'Tambah aset' }).click();
	return sheet;
}

const hero = (page: Page) => page.locator('.net-worth .figure');

test('net worth: empty → add a house and a debt → total = assets − debts, kept on reload, 360 px', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	await page.setViewportSize({ width: 360, height: 780 });
	await page.goto('/kekayaan');
	await waitForHydration(page);
	await expect(
		page.getByText('Belum ada aset. Catat rumah, emas, kripto, saham atau utang.')
	).toBeVisible();
	await expect(hero(page)).toHaveCount(0);

	let sheet = await addItem(page, { kind: 'Properti', name: 'Rumah', value: '1250000000' });
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Aset ditambahkan.')).toBeVisible();
	await expect(hero(page)).toHaveText('Rp1.250.000.000');

	sheet = await addItem(page, { kind: 'Utang', name: 'KPR', value: '250000000' });
	await expect(sheet).toBeHidden();
	await expect(hero(page)).toHaveText('Rp1.000.000.000');
	await expect(page.getByRole('listitem').filter({ hasText: 'KPR' })).toContainText(
		'−Rp 250.000.000'
	);
	await expect(page.getByText('Perubahan tampil setelah satu hari pencatatan.')).toBeVisible();
	await expect(page.getByText(/bukan saran investasi/)).toBeVisible();
	await expectNoHorizontalScroll(page);

	await page.reload();
	await waitForHydration(page);
	await expect(hero(page)).toHaveText('Rp1.000.000.000');
	expect(csp).toEqual([]);
	await context.close();
});

test('crypto: over-precise quantity is refused in the sheet; a cold price cache shows "Belum ada harga"', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.goto('/kekayaan');
	await waitForHydration(page);

	const sheet = await addItem(page, {
		kind: 'Kripto',
		name: 'Bitcoin',
		source: 'Harga Indodax (kripto)',
		symbol: 'BTC',
		quantity: '0,123456789'
	});
	await expect(
		sheet.getByText('Jumlah punya terlalu banyak angka di belakang koma.')
	).toBeVisible();
	await sheet.getByLabel(/^Jumlah/).fill('0,015');
	await sheet.getByRole('button', { name: 'Tambah aset' }).click();
	await expect(sheet).toBeHidden();

	const row = page.getByRole('listitem').filter({ hasText: 'Bitcoin' });
	await expect(row).toContainText('0,015 BTC');
	await expect(row).toContainText('Belum ada harga');
	await expect(page.getByText('1 aset belum punya harga dan belum dihitung.')).toBeVisible();
	await expect(hero(page)).toHaveText('Rp0');
	await context.close();
});
