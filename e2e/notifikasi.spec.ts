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
 * FN-24 journeys: a goal milestone becomes an in-app notification (Kotak masuk › Notifikasi), opening it marks it
 * read and goes to the goal, dismissing removes it; per-kind preferences persist. Each test signs up its own
 * fictional user, so its list starts empty.
 */
const BASE = APP_ORIGIN;
const PASSWORD = 'terang-benderang-8';

async function freshUser(browser: Browser, testInfo: TestInfo) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) },
		viewport: { width: 360, height: 780 }
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pengingat');
	await page
		.getByLabel('E-mail')
		.fill(`fn24-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	return { context, page };
}

async function open(page: Page, path: string) {
	await page.goto(path);
	await waitForHydration(page);
}

test('goal milestone → notification: empty state, listed unread, open goes to the goal, dismiss removes it', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);

	await open(page, '/kotak-masuk');
	await page.locator('main').getByRole('link', { name: 'Notifikasi' }).click();
	await page.waitForURL(`${BASE}/kotak-masuk/notifikasi`);
	await waitForHydration(page);
	await expect(page.getByText('Belum ada notifikasi.')).toBeVisible();

	// A goal reaching 50 % is the one trigger a user can cause directly.
	await open(page, '/dompet');
	await page.getByRole('link', { name: 'Tambah target' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah target' });
	await sheet.getByLabel('Nama target').fill('Sepeda');
	await sheet.getByLabel('Jumlah target').fill('1000000');
	await sheet.getByRole('button', { name: 'Tambah target' }).click();
	await expect(page.getByText('Target ditambahkan.')).toBeVisible();
	await page
		.locator('section.goals')
		.getByRole('listitem')
		.filter({ hasText: 'Sepeda' })
		.getByRole('link')
		.click();
	await page.waitForURL(/\/kekayaan\/tabungan\//);
	await waitForHydration(page);
	const goalUrl = page.url();
	await page.getByRole('link', { name: 'Tambah tabungan' }).click();
	const add = page.getByRole('dialog', { name: 'Tambah tabungan' });
	await add.getByLabel('Jumlah').fill('600000');
	await add.getByRole('button', { name: 'Tambah tabungan' }).click();
	await expect(page.getByText('Tabungan dicatat.')).toBeVisible();

	await open(page, '/kotak-masuk');
	await expect(page.locator('main').getByRole('link', { name: /Notifikasi/ })).toContainText(
		'1 belum dibaca'
	);
	await open(page, '/kotak-masuk/notifikasi');
	const item = page.getByRole('button', { name: /Sepeda: setengah jalan/ });
	await expect(item).toBeVisible();
	await expect(item).toContainText('Belum dibaca');
	await expect(item).toContainText('Rp 600.000 dari Rp 1.000.000 terkumpul');
	await expectNoHorizontalScroll(page);

	await item.click();
	await page.waitForURL(goalUrl);
	await open(page, '/kotak-masuk/notifikasi');
	await expect(page.getByRole('button', { name: /Sepeda: setengah jalan/ })).not.toContainText(
		'Belum dibaca'
	);

	await page.getByRole('button', { name: 'Hapus notifikasi' }).click();
	await expect(page.getByText('Notifikasi dihapus.')).toBeVisible();
	await expect(page.getByText('Belum ada notifikasi.')).toBeVisible();
	await page.reload();
	await expect(page.getByText('Belum ada notifikasi.')).toBeVisible();
	expect(csp).toEqual([]);
	await context.close();
});

test('per-kind preferences save and survive a reload, even without push keys', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await open(page, '/pengaturan/notifikasi');
	const nudge = page.getByRole('switch', { name: 'Pengingat harian' });
	await expect(nudge).toBeChecked();
	await nudge.click({ force: true });
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await expect(nudge).not.toBeChecked();
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByRole('switch', { name: 'Pengingat harian' })).not.toBeChecked();
	await expect(page.getByRole('switch', { name: 'Ringkasan mingguan' })).toBeChecked();
	await expectNoHorizontalScroll(page);
	await context.close();
});
