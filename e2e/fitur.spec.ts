import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	tickSignUpBoxes,
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration
} from './helpers';

/**
 * FN-12 journeys. Every test signs up its own fictional user in its own context (own simulated client address):
 * flags are per user, so parallel tests never see each other's choices and the shared e2e user keeps the
 * default nav that shell.spec.ts counts.
 */
const BASE = APP_ORIGIN;
const PASSWORD = 'terang-benderang-8';
const MODULES = ['Kekayaan', 'Langganan', 'Barang', 'Koleksi', 'Ruang bersama'];
const NO_NAV = 'Belum ada menu untuk disembunyikan';

async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: { javaScriptEnabled?: boolean } = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) },
		...opts
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pemilik Fitur');
	await page
		.getByLabel('E-mail')
		.fill(`fn12-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	return { context, page };
}

const nav = (page: Page) =>
	page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });

/** Nav link labels in order, as the visible nav (tab bar on phone, sidebar on desktop) shows them. */
const navLabels = async (page: Page) =>
	Promise.all(
		(await nav(page).getByRole('link').all()).map(
			async (l) => (await l.getAttribute('aria-label')) ?? (await l.innerText()).trim()
		)
	);

/** The tab bar pill holds its icon tabs in equal cells (no gap left by a hidden tab); Tambah is the round button beside it. */
async function expectTabBarFilled(page: Page, cells: number) {
	const bar = await nav(page).boundingBox();
	const boxes = await Promise.all(
		(await nav(page).locator(':scope > a, :scope > button').all()).map((c) => c.boundingBox())
	);
	expect(boxes).toHaveLength(cells);
	await expect(
		page.getByRole('button', { name: 'Tambah' }).filter({ visible: true })
	).toBeVisible();
	const widths = boxes.map((b) => b!.width);
	for (const w of widths) expect(Math.abs(w - widths[0]!)).toBeLessThanOrEqual(1);
	const last = boxes[boxes.length - 1]!;
	// Only the pill's own 8 px padding remains to its right.
	expect(bar!.x + bar!.width - (last.x + last.width)).toBeLessThanOrEqual(8);
	for (const b of boxes) expect(b!.height).toBeGreaterThanOrEqual(44);
}

test('defaults on; hiding Kekayaan removes it from the nav without a gap, survives reload, and comes back in place', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	await page.goto('/pengaturan');
	await page.locator('main').getByRole('link', { name: 'Fitur' }).click();
	await expect(page).toHaveURL(`${BASE}/pengaturan/fitur`);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Fitur' })).toBeVisible();

	for (const name of MODULES) await expect(page.getByRole('switch', { name })).toBeChecked();
	// Only the module without a nav entry says so (Langganan has one since FN-26, Barang since FN-27,
	// Koleksi since FN-28).
	for (const name of MODULES.slice(0, 4))
		await expect(page.getByRole('switch', { name })).not.toHaveAccessibleDescription(NO_NAV);
	for (const name of MODULES.slice(4))
		await expect(page.getByRole('switch', { name })).toHaveAccessibleDescription(NO_NAV);
	// With JavaScript the switch saves itself: no per-row Simpan button.
	await expect(page.getByRole('button', { name: 'Simpan' })).toHaveCount(0);
	await expectNoHorizontalScroll(page);

	// Kekayaan's entry is "Kekayaan bersih" in the desktop sidebar's Fitur section (APP_PARITY § 1); the phone
	// tab bar holds Dompet (wallets), which no module hides.
	const full = await navLabels(page);
	if (isPhone(page)) {
		expect(full).toEqual(['Beranda', 'Riwayat', 'Laporan', 'Dompet']);
		await expectTabBarFilled(page, 4);
	} else expect(full).toContain('Kekayaan bersih');

	await page.getByRole('switch', { name: 'Kekayaan' }).click();
	await expect(page.getByRole('status')).toHaveText('Perubahan disimpan.');
	await expect(page.getByRole('switch', { name: 'Kekayaan' })).not.toBeChecked();
	await expect(nav(page).getByRole('link', { name: 'Kekayaan' })).toHaveCount(0);
	expect(await navLabels(page)).toEqual(full.filter((l) => l !== 'Kekayaan bersih'));
	if (isPhone(page)) await expectTabBarFilled(page, 4);

	await page.reload();
	await expect(page.getByRole('switch', { name: 'Kekayaan' })).not.toBeChecked();
	await expect(nav(page).getByRole('link', { name: 'Kekayaan' })).toHaveCount(0);

	// The route itself still loads directly, with a way back to the setting.
	await page.goto('/kekayaan');
	await expect(page.getByRole('heading', { level: 1, name: 'Kekayaan bersih' })).toBeVisible();
	await expect(
		page.getByText('Kekayaan disembunyikan dari menu. Angkanya tetap dihitung.')
	).toBeVisible();
	await page.getByRole('link', { name: 'Tampilkan lagi di menu' }).click();
	await expect(page).toHaveURL(`${BASE}/pengaturan/fitur`);
	await waitForHydration(page);

	await page.getByRole('switch', { name: 'Kekayaan' }).click();
	await expect(page.getByRole('status')).toHaveText('Perubahan disimpan.');
	await expect(page.getByRole('switch', { name: 'Kekayaan' })).toBeChecked();
	expect(await navLabels(page)).toEqual(full);
	if (isPhone(page)) await expectTabBarFilled(page, 4);
	await page.goto('/kekayaan');
	await expect(page.getByText('Kekayaan disembunyikan dari menu.', { exact: false })).toHaveCount(
		0
	);
	expect(csp).toEqual([]);
	await context.close();
});

test('Barang and Koleksi persist and leave the nav; the switch without a nav entry is disabled', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.goto('/pengaturan/fitur');
	await waitForHydration(page);
	const before = await navLabels(page);
	// Ruang bersama has no menu entry to hide: its switch is disabled, with the reason as its description.
	await expect(page.getByRole('switch', { name: 'Ruang bersama' })).toBeDisabled();
	for (const name of MODULES.slice(2, 4)) {
		await page.getByRole('switch', { name }).click();
		await expect(page.getByRole('switch', { name })).not.toBeChecked();
		await expect(page.getByRole('switch', { name })).toBeEnabled();
	}
	await page.reload();
	for (const name of MODULES.slice(2, 4))
		await expect(page.getByRole('switch', { name })).not.toBeChecked();
	await expect(page.getByRole('switch', { name: 'Ruang bersama' })).toBeChecked();
	for (const name of MODULES.slice(0, 2))
		await expect(page.getByRole('switch', { name })).toBeChecked();
	// Barang (FN-27) and Koleksi (FN-28) have sidebar entries (desktop only); the phone tab bar never had them.
	expect(await navLabels(page)).toEqual(before.filter((l) => l !== 'Barang' && l !== 'Koleksi'));
	// The hidden module's page still loads, says so, and links back to the setting.
	await page.goto('/barang');
	await expect(
		page.getByText('Barang disembunyikan dari menu. Angkanya tetap dihitung.')
	).toBeVisible();
	await page.goto('/koleksi');
	await expect(
		page.getByText('Koleksi disembunyikan dari menu. Angkanya tetap dihitung.')
	).toBeVisible();
	await context.close();
});

test('works without JavaScript: the row form posts and the nav follows', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/pengaturan/fitur');
	const row = page
		.locator('main form')
		.filter({ has: page.getByRole('switch', { name: 'Kekayaan' }) });
	await row.getByRole('switch', { name: 'Kekayaan' }).uncheck();
	await row.getByRole('button', { name: 'Simpan' }).click();
	await expect(page.getByRole('status')).toHaveText('Perubahan disimpan.');
	await expect(page.getByRole('switch', { name: 'Kekayaan' })).not.toBeChecked();
	await expect(nav(page).getByRole('link', { name: 'Kekayaan' })).toHaveCount(0);

	await page.goto('/pengaturan/fitur');
	const again = page
		.locator('main form')
		.filter({ has: page.getByRole('switch', { name: 'Kekayaan' }) });
	await again.getByRole('switch', { name: 'Kekayaan' }).check();
	await again.getByRole('button', { name: 'Simpan' }).click();
	await expect(page.getByRole('switch', { name: 'Kekayaan' })).toBeChecked();
	await expect(nav(page).getByRole('link', { name: 'Kekayaan' })).toHaveCount(
		isPhone(page) ? 0 : 1
	);
	await context.close();
});

test('English labels and the signed-out redirect', async ({ browser }, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await context.addCookies([{ name: 'lang', value: 'en', url: BASE }]);
	await page.goto('/pengaturan/fitur');
	await expect(page.getByRole('heading', { level: 1, name: 'Features' })).toBeVisible();
	await expect(page.getByRole('switch', { name: 'Net worth' })).toBeChecked();
	await expect(page.getByRole('switch', { name: 'Shared spaces' })).toHaveAccessibleDescription(
		'No menu entry to hide yet'
	);
	await context.close();

	const anon = await browser.newContext({ storageState: SIGNED_OUT });
	const p = await anon.newPage();
	await p.goto('/pengaturan/fitur');
	await expect(p).toHaveURL(`${BASE}/masuk?next=%2Fpengaturan%2Ffitur`);
	await anon.close();
});

test('the Fitur sheet (Jelajahi fitur) switches a module, the nav follows, and it persists', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	await waitForHydration(page);
	// Desktop: the sidebar entry; phone: Beranda's link. Both open the same sheet.
	const opener = isPhone(page)
		? page.locator('main').getByRole('link', { name: 'Jelajahi fitur' })
		: nav(page).getByRole('link', { name: 'Jelajahi fitur' });
	await opener.click();
	const sheet = page.getByRole('dialog', { name: 'Fitur' });
	await expect(sheet).toBeVisible();
	await expect(page).toHaveURL(`${BASE}/`);
	for (const name of ['Kekayaan bersih', 'Barang', 'Langganan', 'Koleksi'])
		await expect(sheet.getByRole('switch', { name })).toBeChecked();
	await expect(sheet.getByRole('switch', { name: 'Ruang bersama' })).toHaveCount(0);
	await expect(sheet.getByRole('link', { name: 'Barang' })).toBeVisible();

	await sheet.getByRole('switch', { name: 'Barang' }).click();
	await expect(sheet.getByRole('status')).toHaveText('Perubahan disimpan.');
	await expect(sheet.getByRole('switch', { name: 'Barang' })).not.toBeChecked();
	await expect(sheet.getByRole('link', { name: 'Barang' })).toHaveCount(0);
	if (!isPhone(page)) await expect(nav(page).getByRole('link', { name: 'Barang' })).toHaveCount(0);

	// Escape closes it and focus returns to the opener; the choice is stored on the server.
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(opener).toBeFocused();
	await page.goto('/pengaturan/fitur');
	await expect(page.getByRole('switch', { name: 'Barang' })).not.toBeChecked();

	// And back on from the sheet.
	await page.goto('/');
	await waitForHydration(page);
	await opener.click();
	await sheet.getByRole('switch', { name: 'Barang' }).click();
	await expect(sheet.getByRole('switch', { name: 'Barang' })).toBeChecked();
	await expect(sheet.getByRole('status')).toHaveText('Perubahan disimpan.');
	if (!isPhone(page)) await expect(nav(page).getByRole('link', { name: 'Barang' })).toHaveCount(1);
	await expectNoHorizontalScroll(page);
	expect(csp).toEqual([]);
	await context.close();
});
