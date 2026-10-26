import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	newUser,
	simulatedClientIp,
	waitForHydration
} from './helpers';
import {} from './ledger';

/**
 * FN-34b journeys at 360 px: the Beranda streak chip opens /beruntun (empty, then one closed day with the
 * calendar, milestones and the budget streak), and the evening reminder's hour is set on /pengaturan/notifikasi,
 * with and without JavaScript. Each test signs up its own fictional user. No VAPID keys in e2e: the per-device
 * switch shows "Belum dikonfigurasi" while the reminder preference still saves.
 */
const PASSWORD = 'beruntun-pagi-8';

async function freshUser(browser: Browser, testInfo: TestInfo, javaScriptEnabled = true) {
	const phone = { viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true };
	const user = await newUser(browser, testInfo, {
		prefix: 'fn34b',
		name: 'Beruntun',
		password: PASSWORD,
		n: 3,
		...phone
	});
	if (javaScriptEnabled) return user;
	// The same session in a JavaScript-disabled context.
	const state = await user.context.storageState();
	await user.context.close();
	const noJs = await browser.newContext({
		storageState: state,
		javaScriptEnabled: false,
		viewport: phone.viewport,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 3) }
	});
	return { context: noJs, page: await noJs.newPage() };
}

test('the streak chip opens /beruntun: empty, then today closed with calendar, milestones and budget streak', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	const main = page.locator('main');

	// The chip is a link with a ≥ 44 px hit area; before the first closed day it reads "Mulai hari ini".
	const chipLink = main.getByRole('link', { name: 'Mulai hari ini' });
	await expect(chipLink).toBeVisible();
	expect((await chipLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await chipLink.click();
	await page.waitForURL(`${APP_ORIGIN}/beruntun`);
	await expect(page.getByRole('heading', { level: 1, name: 'Beruntun' })).toBeVisible();
	await expect(main.getByText('Belum ada hari berturut-turut.', { exact: false })).toBeVisible();
	await expect(main.getByText('Beruntun anggaran')).toBeVisible();
	await expect(
		main.getByText('Ruang ini belum punya anggaran bulanan', { exact: false })
	).toBeVisible();
	await expect(main.getByRole('link', { name: /Pengingat tutup hari/ })).toContainText(
		'Aktif · 20.00 WIB'
	);
	await expectNoHorizontalScroll(page);

	// Close today on Beranda, then the page shows the run.
	await page.goto('/');
	await waitForHydration(page);
	await main.locator('section.today').getByRole('button', { name: 'Tutup hari ini' }).click();
	await expect(main.locator('.day-chip')).toHaveText('1 hari berturut-turut');
	await main.getByRole('link', { name: '1 hari berturut-turut' }).click();
	await page.waitForURL(`${APP_ORIGIN}/beruntun`);
	await expect(main.locator('.big')).toHaveText('1');
	await expect(main.getByText('1 hari berturut-turut · Hari ini ditutup')).toBeVisible();
	const calendar = main.getByRole('group', { name: /^Hari ditutup,/ });
	await expect(calendar).toBeVisible();
	await expect(calendar.locator('.cell.closed')).toHaveCount(1);
	await expect(calendar.locator('[aria-current="date"]')).toHaveCount(0);
	for (const cell of await calendar.locator('.cell').all())
		expect((await cell.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	// Milestones: none reached yet, plain text with a star or check, never a coin.
	for (const n of [7, 30, 100])
		await expect(
			main.getByRole('listitem').filter({ hasText: `${n} hari berturut-turut` })
		).toContainText('Belum tercapai');
	// The month stepper is bounded: last month and back, nothing before it.
	await main.getByRole('link', { name: 'Periode sebelumnya' }).click();
	await page.waitForURL(/\/beruntun\?bulan=/);
	await expect(main.getByRole('link', { name: 'Periode sebelumnya' })).toHaveCount(0);
	await main.getByRole('link', { name: 'Periode berikutnya' }).click();
	await page.waitForURL(`${APP_ORIGIN}/beruntun`);
	await expectNoHorizontalScroll(page);

	// English.
	await context.addCookies([{ name: 'lang', value: 'en', url: APP_ORIGIN }]);
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Streak' })).toBeVisible();
	await expect(main.getByText('Best run').first()).toBeVisible();
	await expect(main.getByRole('listitem').filter({ hasText: '7 days in a row' })).toContainText(
		'Not reached yet'
	);
	await expectNoHorizontalScroll(page);
	expect(csp).toEqual([]);
	await context.close();
});

test('the reminder hour saves on /pengaturan/notifikasi; push stays "Belum dikonfigurasi"', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.goto('/beruntun');
	await waitForHydration(page);
	await page
		.locator('main')
		.getByRole('link', { name: /Pengingat tutup hari/ })
		.click();
	await page.waitForURL(`${APP_ORIGIN}/pengaturan/notifikasi`);
	await waitForHydration(page);
	await expect(
		page.getByRole('switch', { name: 'Beri tahu di perangkat ini Belum dikonfigurasi' })
	).toBeDisabled();
	await expect(page.getByRole('switch', { name: /^Pengingat tutup hari/ })).toBeChecked();
	const hour = page.getByLabel(/Jam pengingat tutup hari/);
	await expect(hour).toHaveValue('20');
	expect((await hour.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await hour.selectOption('21');
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await page.reload();
	await expect(page.getByLabel(/Jam pengingat tutup hari/)).toHaveValue('21');
	await expectNoHorizontalScroll(page);
	await page.goto('/beruntun');
	await expect(
		page.locator('main').getByRole('link', { name: /Pengingat tutup hari/ })
	).toContainText('Aktif · 21.00 WIB');
	await context.close();
});

test('without JavaScript the hour still saves, and a forged hour is refused unchanged', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, false);
	await page.goto('/pengaturan/notifikasi');
	const form = page.locator('form[action="?/setReminderHour"]');
	await form.getByLabel(/Jam pengingat tutup hari/).selectOption('7');
	await form.getByRole('button', { name: 'Simpan' }).click();
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await page.goto('/pengaturan/notifikasi');
	await expect(page.getByLabel(/Jam pengingat tutup hari/)).toHaveValue('7');
	// A value no option offers (edited in the page): refused, the stored hour stays.
	await form.locator('select').evaluate((el) => {
		if (el instanceof HTMLSelectElement) el.add(new Option('03.00 WIB', '3', true, true));
	});
	await form.getByRole('button', { name: 'Simpan' }).click();
	await expect(page.getByText('Pilih jam antara 06.00 dan 23.00 WIB.')).toBeVisible();
	await page.goto('/pengaturan/notifikasi');
	await expect(page.getByLabel(/Jam pengingat tutup hari/)).toHaveValue('7');
	await context.close();
});
