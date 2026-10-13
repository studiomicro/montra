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
 * FN-10 journeys. Every test signs up its own fictional user in its own context (own simulated client address),
 * so its personal space starts with no goals and parallel tests never see each other's goals.
 */
const BASE = APP_ORIGIN;
const PASSWORD = 'terang-benderang-8';

async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: {
		javaScriptEnabled?: boolean;
		colorScheme?: 'light' | 'dark';
		viewport?: { width: number; height: number };
	} = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) },
		...opts
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Penabung');
	await page
		.getByLabel('E-mail')
		.fill(`fn10-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	return { context, page };
}

async function open(page: Page, path = '/dompet') {
	await page.goto(path);
	await waitForHydration(page);
}

const goalRow = (page: Page, name: string) =>
	page.locator('section.goals').getByRole('listitem').filter({ hasText: name });

/** Adds a goal through the sheet; resolves once the server-confirmed row is listed. */
async function addGoal(page: Page, name: string, target: string) {
	await page.getByRole('link', { name: 'Tambah target' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah target' });
	await expect(sheet).toBeVisible();
	await sheet.getByLabel('Nama target').fill(name);
	await sheet.getByLabel('Jumlah target').fill(target);
	await sheet.getByRole('button', { name: 'Tambah target' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Target ditambahkan.')).toBeVisible();
}

/** Logs a contribution on the goal page through the sheet. */
async function contribute(page: Page, amount: string, note?: string) {
	await page.getByRole('link', { name: 'Tambah tabungan' }).click();
	const sheet = page.getByRole('dialog', { name: 'Tambah tabungan' });
	await expect(sheet).toBeVisible();
	await sheet.getByLabel('Jumlah').fill(amount);
	if (note) await sheet.getByLabel('Catatan (opsional)').fill(note);
	await sheet.getByRole('button', { name: 'Tambah tabungan' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Tabungan dicatat.')).toBeVisible();
}

test('first goal: empty state → add in the sheet → 0 % of the target, kept on reload; focus returns', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	await open(page);
	const section = page.locator('section.goals');
	await expect(section.getByText('Belum ada target tabungan.')).toBeVisible();
	// The wallet section's own empty state is unaffected.
	await expect(page.getByText('Belum ada dompet. Tambah satu untuk mulai mencatat.')).toBeVisible();

	const opener = section.getByRole('link', { name: 'Tambah target' });
	await opener.click();
	const sheet = page.getByRole('dialog', { name: 'Tambah target' });
	await sheet.getByLabel('Nama target').fill('Liburan Bali');
	await sheet.getByLabel('Jumlah target').fill('0');
	await sheet.getByRole('button', { name: 'Tambah target' }).click();
	await expect(
		sheet.getByText('Isi jumlah target dengan angka bulat lebih dari nol, tanpa sen.')
	).toBeVisible();
	await sheet.getByLabel('Jumlah target').fill('1250000');
	await expect(sheet.getByLabel('Jumlah target')).toHaveValue('1.250.000');
	await sheet.getByRole('button', { name: 'Tambah target' }).click();
	await expect(sheet).toBeHidden();

	const row = goalRow(page, 'Liburan Bali');
	await expect(row).toContainText('Rp0 dari Rp1,25 jt');
	await expect(row).toContainText('0%');
	await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

	await page.reload();
	await expect(goalRow(page, 'Liburan Bali')).toContainText('Rp0 dari Rp1,25 jt');

	const add = section.getByRole('link', { name: 'Tambah target' });
	await add.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Tambah target' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(add).toBeFocused();
	expect(csp).toEqual([]);
	await context.close();
});

test('contributions raise the progress after the server confirms; deleting one lowers it; over 100 % is reached', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await open(page);
	await addGoal(page, 'Laptop', '1000000');
	await goalRow(page, 'Laptop').getByRole('link').click();
	await page.waitForURL(/\/kekayaan\/tabungan\//);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Laptop' })).toBeVisible();
	await expect(page.getByText('Belum ada tabungan untuk target ini.')).toBeVisible();

	await contribute(page, '250000', 'gaji Oktober');
	const hero = page.locator('section.hero');
	await expect(hero).toContainText('Rp 250.000');
	await expect(hero).toContainText('Rp250 rb / Rp1 jt');
	await expect(hero).toContainText('25%');
	await expect(page.getByRole('listitem').filter({ hasText: 'gaji Oktober' })).toContainText(
		'+Rp 250.000'
	);

	await contribute(page, '900000', 'salah ketik');
	await expect(hero).toContainText('115%');
	await expect(hero.getByText('Tercapai')).toBeVisible();
	await expect(hero.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

	const mistake = page.getByRole('listitem').filter({ hasText: 'salah ketik' });
	await mistake.locator('summary', { hasText: 'Hapus' }).click();
	await mistake.getByRole('button', { name: 'Ya, hapus' }).click();
	await expect(page.getByText('Catatan tabungan dihapus.')).toBeVisible();
	await expect(page.getByText('salah ketik')).toHaveCount(0);
	await expect(hero).toContainText('25%');
	await expect(hero.getByText('Tercapai')).toHaveCount(0);

	await page.reload();
	await expect(page.locator('section.hero')).toContainText('Rp250 rb / Rp1 jt');
	await page.getByRole('link', { name: 'Dompet', exact: true }).first().click();
	await expect(goalRow(page, 'Laptop')).toContainText('25%');
	await context.close();
});

test('edit the target; a second tab’s stale save is refused', async ({ browser }, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await open(page);
	await addGoal(page, 'Motor', '10000000');
	await goalRow(page, 'Motor').getByRole('link').click();
	await page.waitForURL(/\/kekayaan\/tabungan\//);
	const url = page.url();
	await waitForHydration(page);

	const tab2 = await context.newPage();
	await open(tab2, url);
	await tab2.getByRole('link', { name: 'Ubah target' }).click();
	const sheet2 = tab2.getByRole('dialog', { name: 'Ubah target' });
	await expect(sheet2).toBeVisible();

	await page.getByRole('link', { name: 'Ubah target' }).click();
	const sheet = page.getByRole('dialog', { name: 'Ubah target' });
	await sheet.getByLabel('Jumlah target').fill('20000000');
	await sheet.getByRole('button', { name: 'Simpan perubahan' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await expect(page.locator('section.hero')).toContainText('Rp0 / Rp20 jt');

	await sheet2.getByLabel('Nama target').fill('Ditimpa tab dua');
	await sheet2.getByRole('button', { name: 'Simpan perubahan' }).click();
	await expect(
		sheet2.getByText('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.')
	).toBeVisible();
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Motor' })).toBeVisible();
	await expect(page.getByText('Ditimpa tab dua')).toHaveCount(0);
	await context.close();
});

test('archive hides the goal and keeps its history; restore brings back the same progress', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await open(page);
	await addGoal(page, 'Umrah', '50000000');
	await goalRow(page, 'Umrah').getByRole('link').click();
	await page.waitForURL(/\/kekayaan\/tabungan\//);
	await waitForHydration(page);
	await contribute(page, '5000000');

	await page.getByRole('link', { name: 'Ubah target' }).click();
	const sheet = page.getByRole('dialog', { name: 'Ubah target' });
	await sheet.locator('summary', { hasText: 'Arsipkan target' }).click();
	await sheet.getByRole('button', { name: 'Ya, arsipkan' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Target diarsipkan.')).toBeVisible();
	await expect(
		page.getByText('Target ini diarsipkan. Pulihkan untuk menambah tabungan lagi.')
	).toBeVisible();
	await expect(page.getByRole('link', { name: 'Tambah tabungan' })).toHaveCount(0);
	await expect(page.locator('section.hero')).toContainText('10%');

	await open(page);
	await expect(goalRow(page, 'Umrah')).toHaveCount(0);
	await page.getByRole('link', { name: 'Lihat yang diarsipkan' }).click();
	const archived = goalRow(page, 'Umrah');
	await expect(archived).toContainText('Diarsipkan');
	await archived.getByRole('link').click();
	await page.waitForURL(/\/kekayaan\/tabungan\//);
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Pulihkan' }).click();
	await expect(page.getByText('Target dipulihkan.')).toBeVisible();
	await expect(page.locator('section.hero')).toContainText('Rp5 jt / Rp50 jt');
	await open(page);
	await expect(goalRow(page, 'Umrah')).toContainText('10%');
	await context.close();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`goals fit 360 px in ${colorScheme} with 44 px targets`, async ({ browser }, testInfo) => {
		test.skip(testInfo.project.name !== 'phone', '360 px layout is a phone check');
		const { context, page } = await freshUser(browser, testInfo, {
			colorScheme,
			viewport: { width: 360, height: 780 }
		});
		await open(page);
		await addGoal(
			page,
			'Nama target yang panjang sekali untuk diuji di layar kecil',
			'9999999999999'
		);
		await expectNoHorizontalScroll(page);
		for (const target of [
			page.locator('section.goals').getByRole('link', { name: 'Tambah target' }),
			goalRow(page, 'Nama target').getByRole('link')
		]) {
			const box = await target.boundingBox();
			expect(box?.height).toBeGreaterThanOrEqual(44);
		}
		await goalRow(page, 'Nama target').getByRole('link').click();
		await page.waitForURL(/\/kekayaan\/tabungan\//);
		await waitForHydration(page);
		await contribute(page, '1234567890123', 'catatan');
		await expectNoHorizontalScroll(page);
		for (const target of [
			page.getByRole('link', { name: 'Tambah tabungan' }),
			page.getByRole('link', { name: 'Ubah target' }),
			page.getByRole('listitem').locator('summary', { hasText: 'Hapus' }),
			page.getByTestId('screen-back')
		]) {
			const box = await target.boundingBox();
			expect(box?.height).toBeGreaterThanOrEqual(44);
		}
		await context.close();
	});
}

test('without JavaScript: refused and valid goal, a contribution and a stale-free delete', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	// Submit buttons are pressed with Enter: on the phone the floating tab bar can cover a button that
	// Playwright only scrolls to the viewport edge (a person scrolls it clear; the page has bottom padding).
	await page.goto('/dompet');
	await page.locator('section.goals').getByRole('link', { name: 'Tambah target' }).click();
	await expect(page).toHaveURL(`${BASE}/dompet?target=baru`);
	const form = page.locator('section.goal-inline');
	await form.getByLabel('Nama target').fill('Tanpa JS');
	await form.getByLabel('Jumlah target').fill('12,50');
	await form.getByRole('button', { name: 'Tambah target' }).press('Enter');
	await expect(
		page.getByText('Isi jumlah target dengan angka bulat lebih dari nol, tanpa sen.')
	).toBeVisible();
	await expect(page.locator('section.goal-inline').getByLabel('Nama target')).toHaveValue(
		'Tanpa JS'
	);
	await page.locator('section.goal-inline').getByLabel('Jumlah target').fill('100.000');
	await page
		.locator('section.goal-inline')
		.getByRole('button', { name: 'Tambah target' })
		.press('Enter');
	await expect(page.getByText('Target ditambahkan.')).toBeVisible();
	await expect(goalRow(page, 'Tanpa JS')).toContainText('Rp0 dari Rp100 rb');

	await goalRow(page, 'Tanpa JS').getByRole('link').click();
	await page.getByRole('link', { name: 'Tambah tabungan' }).click();
	const inline = page.locator('section.inline-goal-form');
	await inline.getByLabel('Jumlah').fill('-5.000');
	await inline.getByRole('button', { name: 'Tambah tabungan' }).press('Enter');
	await expect(
		page.getByText('Isi jumlah dengan angka bulat lebih dari nol, tanpa sen.')
	).toBeVisible();
	await page.locator('section.inline-goal-form').getByLabel('Jumlah').fill('40.000');
	await page
		.locator('section.inline-goal-form')
		.getByRole('button', { name: 'Tambah tabungan' })
		.press('Enter');
	await expect(page.getByText('Tabungan dicatat.')).toBeVisible();
	await expect(page.locator('section.hero')).toContainText('40%');

	const entry = page.getByRole('listitem').filter({ hasText: '+Rp 40.000' });
	await entry.locator('summary', { hasText: 'Hapus' }).click();
	await entry.getByRole('button', { name: 'Ya, hapus' }).press('Enter');
	await expect(page.getByText('Catatan tabungan dihapus.')).toBeVisible();
	await expect(page.locator('section.hero')).toContainText('0%');
	await context.close();
});

test('an unknown goal id answers 404 without detail', async ({ browser }, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const response = await page.goto('/kekayaan/tabungan/00000000-0000-4000-8000-000000000000');
	expect(response?.status()).toBe(404);
	await expect(page.locator('body')).not.toContainText('00000000-0000');
	await context.close();
});
