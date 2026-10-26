import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	newUser,
	simulatedClientIp,
	waitForHydration
} from './helpers';
import { addWalletInSheet } from './ledger';

/**
 * FN-25b journeys on /kekayaan: the empty chart, the "Belum dihitung" cards pre-filling the add sheet, the
 * allocation bar with debts as their own minus line, the credit-card and Dompet sections, the eye button over
 * every figure, the range control, the phone and desktop layouts and the no-JavaScript paths. Each test signs up
 * its own fictional user. No snapshot exists in e2e (the cron never runs), so the chart shows its empty text.
 */

function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	viewport: { width: number; height: number }
) {
	const phone = viewport.width < 1024;
	// A phone has a coarse pointer, where every control is at least 44 px tall.
	return newUser(browser, testInfo, {
		prefix: 'fn25b',
		name: 'Pemilik Kekayaan',
		viewport,
		hasTouch: phone,
		isMobile: phone
	});
}

async function addWallet(page: Page, name: string, type: string, balance?: string) {
	await page.goto('/dompet');
	await waitForHydration(page);
	await addWalletInSheet(page, { name, type, balance });
}

async function openKekayaan(page: Page) {
	await page.goto('/kekayaan');
	await waitForHydration(page);
}

const missing = (page: Page) => page.getByRole('region', { name: 'Belum dihitung' });
const chips = (page: Page) => page.locator('.allocation .chips');

test('phone 360: suggestions pre-fill the sheet, bar + debt line, cards, sections, eye and range', async ({
	browser
}, testInfo) => {
	test.skip(testInfo.project.name !== 'phone', 'phone layout journey');
	const { context, page } = await freshUser(browser, testInfo, { width: 360, height: 780 });
	const csp = collectCspViolations(page);
	await openKekayaan(page);

	// New user: no figure, the chart's empty text, both suggestion cards.
	await expect(page.locator('.net-worth .figure')).toHaveCount(0);
	await expect(page.getByText('Grafik tampil setelah beberapa hari pencatatan.')).toBeVisible();
	await expect(missing(page).getByRole('link', { name: /Emas/ })).toBeVisible();
	await expect(missing(page).getByRole('link', { name: /Dana pensiun/ })).toBeVisible();
	await expectNoHorizontalScroll(page);

	// The gold card opens the add sheet as gold priced by gold-api, not saved by itself.
	await missing(page).getByRole('link', { name: /Emas/ }).click();
	let sheet = page.getByRole('dialog', { name: 'Tambah aset' });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('radio', { name: 'Emas', exact: true })).toBeChecked();
	await expect(sheet.getByLabel('Sumber nilai')).toHaveValue('gold_api');
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();

	// The pension card pre-fills a manual "Aset lain" with an editable name; saved only on submit.
	await missing(page)
		.getByRole('link', { name: /Dana pensiun/ })
		.click();
	sheet = page.getByRole('dialog', { name: 'Tambah aset' });
	await expect(sheet.getByRole('radio', { name: 'Aset lain', exact: true })).toBeChecked();
	await expect(sheet.getByLabel('Nama aset')).toHaveValue('Dana pensiun BPJS JHT/DPLK');
	await sheet.getByLabel(/^Nilai/).fill('20000000');
	await sheet.getByRole('button', { name: 'Tambah aset' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Aset ditambahkan.')).toBeVisible();
	await expect(missing(page).getByRole('link', { name: /Dana pensiun/ })).toHaveCount(0);
	await expect(missing(page).getByRole('link', { name: /Emas/ })).toBeVisible();

	// A debt from the header's Tambah: a minus line under the bar, never a chip.
	await page.getByRole('link', { name: 'Tambah aset' }).first().click();
	sheet = page.getByRole('dialog', { name: 'Tambah aset' });
	await sheet.getByRole('radio', { name: 'Utang', exact: true }).check();
	await sheet.getByLabel('Nama aset').fill('KPR');
	await sheet.getByLabel(/^Nilai/).fill('5000000');
	await sheet.getByRole('button', { name: 'Tambah aset' }).click();
	await expect(sheet).toBeHidden();

	await addWallet(page, 'BCA', 'Bank', '2000000');
	await addWallet(page, 'Visa', 'Kartu kredit');
	await openKekayaan(page);
	await expect(page.locator('.net-worth .figure')).toHaveText('Rp17.000.000');
	await expect(chips(page).getByRole('listitem')).toHaveText([
		/Dompet\s*Rp2\sjt · 9%/,
		/Properti & aset\s*Rp20\sjt · 91%/
	]);
	await expect(chips(page)).not.toContainText('Utang');
	await expect(page.locator('.allocation .outside')).toContainText(/Utang\s*−Rp\s5\.000\.000/);

	const cards = page.getByRole('region', { name: 'Kartu kredit' });
	await expect(cards.getByRole('link', { name: /Visa/ })).toContainText('Rp 0');
	const wallets = page.getByRole('region', { name: 'Dompet', exact: true });
	await expect(wallets.locator('.subtotal')).toHaveText('Rp 2.000.000');
	await expect(wallets.getByRole('link', { name: /BCA/ })).toHaveAttribute(
		'href',
		/\/dompet\?ubah=/
	);
	await expectNoHorizontalScroll(page);

	// The eye hides every figure on the page, and brings them back.
	await page.getByRole('button', { name: 'Sembunyikan nominal' }).click();
	await expect(chips(page)).not.toContainText('Rp');
	// Owner decision 2026-10-13: the shares hide too.
	await expect(chips(page)).not.toContainText('%');
	await expect(wallets).not.toContainText('Rp');
	await expect(cards).not.toContainText('Rp');
	await expect(page.locator('.allocation .outside')).not.toContainText('Rp');
	await page.getByRole('button', { name: 'Sembunyikan nominal' }).click();
	await expect(wallets.locator('.subtotal')).toHaveText('Rp 2.000.000');

	// A range is a server reload with its own URL.
	await page.getByRole('radio', { name: '3 bln' }).check();
	await expect(page).toHaveURL(`${APP_ORIGIN}/kekayaan?rentang=3m`);
	await expect(page.getByRole('radio', { name: '3 bln' })).toBeChecked();
	await expect(page.getByText('Grafik tampil setelah beberapa hari pencatatan.')).toBeVisible();

	// Touch targets of the new controls (coarse pointer).
	for (const target of [
		page.getByRole('radio', { name: '1 bln' }).locator('..'),
		cards.getByRole('link', { name: /Visa/ }),
		missing(page).getByRole('link', { name: /Emas/ })
	]) {
		const box = await target.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	}
	expect(csp).toEqual([]);
	await context.close();
});

test('desktop 1280: two columns — hero, chart and lists left; bar, suggestions and cards right', async ({
	browser
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'desktop layout');
	const { context, page } = await freshUser(browser, testInfo, { width: 1280, height: 900 });
	await addWallet(page, 'Visa', 'Kartu kredit');
	await addWallet(page, 'BCA', 'Bank', '1000000');
	await openKekayaan(page);
	const hero = await page.locator('.hero-area').boundingBox();
	const side = await page.locator('aside.side').boundingBox();
	const main = await page.locator('.layout .main').boundingBox();
	expect(hero && side && main).toBeTruthy();
	expect(side!.x).toBeGreaterThan(hero!.x + hero!.width);
	expect(Math.abs(side!.y - hero!.y)).toBeLessThan(40);
	expect(main!.x).toBe(hero!.x);
	await expect(page.locator('aside.side')).toContainText('Kartu kredit');
	await expect(page.locator('aside.side')).toContainText('Belum dihitung');
	await expectNoHorizontalScroll(page);

	// One column below 860 px (from 860 px the tablet tier keeps two columns; app +layout.svelte).
	await page.setViewportSize({ width: 840, height: 900 });
	const narrowHero = await page.locator('.hero-area').boundingBox();
	const narrowSide = await page.locator('aside.side').boundingBox();
	expect(narrowSide!.x).toBe(narrowHero!.x);
	expect(narrowSide!.y).toBeGreaterThan(narrowHero!.y);
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('without JavaScript: a suggestion link opens the pre-filled inline form; the range is a GET form', async ({
	browser
}, testInfo) => {
	test.skip(testInfo.project.name !== 'phone', 'no-JS paths once');
	const { context } = await freshUser(browser, testInfo, { width: 360, height: 780 });
	const noJs = await browser.newContext({
		storageState: await context.storageState(),
		javaScriptEnabled: false,
		viewport: { width: 360, height: 780 },
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) }
	});
	const page = await noJs.newPage();
	await page.goto('/kekayaan');
	await missing(page)
		.getByRole('link', { name: /Dana pensiun/ })
		.click();
	await expect(page).toHaveURL(/aset=baru&saran=pensiun/);
	const form = page.getByRole('region', { name: 'Tambah aset' });
	await expect(form.getByLabel('Nama aset')).toHaveValue('Dana pensiun BPJS JHT/DPLK');
	await form.getByLabel(/^Nilai/).fill('1500000');
	await form.getByRole('button', { name: 'Tambah aset' }).click();
	await expect(page.getByText('Aset ditambahkan.')).toBeVisible();
	await expect(missing(page).getByRole('link', { name: /Dana pensiun/ })).toHaveCount(0);

	await page.getByRole('radio', { name: '1 thn' }).check();
	await page.getByRole('button', { name: 'Tampilkan' }).click();
	await expect(page).toHaveURL(/rentang=1y/);
	await expect(page.getByRole('radio', { name: '1 thn' })).toBeChecked();
	await noJs.close();
	await context.close();
});
