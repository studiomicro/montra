import { expect, test } from '@playwright/test';
import { SIGNED_OUT, simulatedClientIp, tickSignUpBoxes } from './helpers';
import { addWallet, BASE, ids, PASSWORD } from './ledger';

/**
 * Anggaran (APP_PARITY § 3) without JavaScript: the total and a category budget are set through the inline forms
 * that `?ubah=bulanan` and `?kategori=<id>` open, a refusal shows its message, success only after the server.
 */
test('without JavaScript: the total and a category budget are set with plain form posts', async ({
	browser
}, testInfo) => {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		javaScriptEnabled: false,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) }
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	await page.getByLabel('Nama').fill('Tanpa JS');
	await page
		.getByLabel('E-mail')
		.fill(`anggaran-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	await addWallet(page, 'BCA');

	await page.goto('/anggaran');
	await expect(
		page.getByRole('heading', { level: 2, name: 'Belum ada anggaran bulanan' })
	).toBeVisible();
	await page.getByRole('link', { name: 'Ubah anggaran' }).click();
	await expect(page).toHaveURL(`${BASE}/anggaran?ubah=bulanan`);
	// Submit buttons are pressed with Enter: the phone's floating tab bar may cover them.
	const total = page.locator('section.inline-form');
	await total.getByLabel('Anggaran per bulan').fill('0');
	await total.getByRole('button', { name: 'Simpan' }).press('Enter');
	await expect(
		page.getByText('Isi anggaran lebih dari 0 dengan angka bulat, tanpa sen.')
	).toBeVisible();
	await page.locator('section.inline-form').getByLabel('Anggaran per bulan').fill('2.000.000');
	await page.locator('section.inline-form').getByRole('button', { name: 'Simpan' }).press('Enter');
	await expect(page.getByText('Anggaran disimpan.')).toBeVisible();
	await expect(page.getByText('Sisa untuk dibelanjakan')).toBeVisible();

	const kopi = await (await ids(page)).category('Kopi');
	await page.goto(`/anggaran?kategori=${kopi}`);
	const category = page.locator('section.inline-form');
	await category.getByLabel('Anggaran Kopi per bulan').fill('150.000');
	await category.getByRole('button', { name: 'Simpan' }).press('Enter');
	await expect(page.getByText('Anggaran kategori disimpan.')).toBeVisible();
	await expect(page.getByText('Rp150 rb tersisa')).toBeVisible();
	await page.reload();
	await expect(page.getByText('Rp150 rb tersisa')).toBeVisible();
	await context.close();
});

test('Beranda links to Anggaran (the phone path; the sidebar links it on desktop)', async ({
	page
}) => {
	await page.goto('/');
	await page.locator('main').getByRole('link', { name: 'Lihat anggaran' }).click();
	await expect(page).toHaveURL(`${BASE}/anggaran`);
	await expect(page.getByRole('heading', { level: 1, name: 'Anggaran' })).toBeVisible();
});
