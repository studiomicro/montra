import { expect, test } from '@playwright/test';
import { APP_ORIGIN, expectNoHorizontalScroll, waitForHydration } from './helpers';
import { addWallet, freshUser, postForm, rp } from './ledger';

/**
 * FN-55a credit card wallet in a real browser: the card form (card wording, the bill with its sen, limit and days),
 * the Dompet row (owed, available credit, due chip), the card page at 360 px with hidden amounts, "Bayar tagihan" as
 * a transfer saved only after the server answered and persisted across a reload, Kekayaan's card, and the same
 * forms as plain posts without JavaScript. Every test signs up its own fictional user.
 */

test('add a card, open its page, pay the bill as a transfer; the debt drops after the server saved it', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn55');
	await addWallet(page, 'Bank Fiktif', '5.000.000');
	await page.goto('/dompet');
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	const sheet = page.getByRole('dialog');
	await sheet.getByRole('link', { name: 'Kartu kredit' }).click();
	await sheet.getByLabel('Nama dompet').fill('Kartu Fiktif');
	await sheet.getByLabel('Tagihan berjalan sekarang (utang)').fill('1.250.000,50');
	await sheet.getByLabel('Limit kredit (opsional)').fill('15.000.000');
	await sheet.getByLabel('Tanggal tagihan (opsional)').fill('25');
	await sheet.getByLabel('Tanggal jatuh tempo (opsional)').fill('12');
	await sheet.getByLabel('4 angka terakhir (opsional)').fill('0001');
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();

	const row = page.getByRole('link', { name: /Kartu Fiktif/ });
	await expect(row).toContainText(`−${rp('1.250.000,50')}`);
	await expect(row).toContainText(`Kredit tersedia ${rp('13.749.999,50')}`);
	await expect(row).toContainText('Jatuh tempo');
	await page.screenshot({ path: testInfo.outputPath('dompet-card-row.png'), fullPage: true });

	await row.click();
	await page.waitForURL(/\/dompet\/kartu\//);
	await expect(page.getByText('Utang sekarang')).toBeVisible();
	await expect(page.getByText(`Kredit tersedia ${rp('13.749.999,50')}`)).toBeVisible();
	await expect(page.getByText('Belum ada tagihan yang diimpor untuk kartu ini.')).toBeVisible();
	await expectNoHorizontalScroll(page);
	await page.screenshot({ path: testInfo.outputPath('card-page.png'), fullPage: true });

	// Hidden amounts: the card's figures are masked on its page (AC 13).
	const { origin } = new URL(page.url());
	await context.addCookies([{ name: 'montra-amounts-hidden', value: '1', url: origin }]);
	const masked = await (await page.request.get(page.url())).text();
	expect(masked).not.toContain('13.749.999');
	expect(masked).not.toContain('1.250.000');
	expect(await (await page.request.get('/dompet')).text()).not.toContain('13.749.999');
	expect(await (await page.request.get('/kekayaan')).text()).not.toContain('13.749.999');
	await context.clearCookies({ name: 'montra-amounts-hidden' });

	// "Bayar tagihan": FN-05's transfer form, to this card, from the bank wallet.
	await page.reload();
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Bayar tagihan' }).click();
	await page.waitForURL(/\/riwayat\/baru\?type=transfer&ke=/);
	await expect(page.locator('select[name="walletId"]')).toHaveValue(/.+/);
	await expect(page.locator('select[name="walletId"] option:checked')).toHaveText(/^Bank Fiktif/);
	await page.getByLabel('Jumlah').fill('1.000.000');
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();
	await page.waitForURL(`${APP_ORIGIN}/riwayat?saved=created`);

	await page.goto('/dompet');
	await expect(page.getByRole('link', { name: /Kartu Fiktif/ })).toContainText(
		`−${rp('250.000,50')}`
	);
	await page.goto('/kekayaan');
	await expect(page.getByText(`Kredit tersedia ${rp('14.749.999,50')}`)).toBeVisible();
	await context.close();
});

test('without JavaScript: the card form posts, card fields on a bank are refused, the card page reads', async ({
	browser
}, testInfo) => {
	const { context: signedIn } = await freshUser(browser, testInfo, 'fn55nojs');
	const state = await signedIn.storageState();
	await signedIn.close();
	const context = await browser.newContext({
		storageState: state,
		javaScriptEnabled: false,
		viewport: { width: 360, height: 780 }
	});
	const page = await context.newPage();
	await page.goto('/dompet?tambah=1&jenis=kartu_kredit');
	await page.getByLabel('Nama dompet').fill('Kartu Tanpa JS');
	await page.getByLabel('Tagihan berjalan sekarang (utang)').fill('75.000,25');
	await page.getByLabel('Tanggal jatuh tempo (opsional)').fill('31');
	await expectNoHorizontalScroll(page);
	await page.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();
	await expect(page.getByRole('link', { name: /Kartu Tanpa JS/ })).toContainText(
		`−${rp('75.000,25')}`
	);

	// A bank with a due day: refused with the field's message, nothing saved.
	await page.goto('/dompet?tambah=1');
	await page.getByLabel('Nama dompet').fill('Bank Salah');
	await page.locator('input[name="type"][value="bank"]').check();
	await page.getByLabel('Tanggal jatuh tempo (opsional)').fill('12');
	await page.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(
		page.getByText('Hanya untuk kartu kredit. Kosongkan kolom ini atau pilih jenis Kartu kredit.')
	).toBeVisible();
	await page.goto('/dompet');
	await expect(page.getByText('Bank Salah')).toHaveCount(0);

	await page.getByRole('link', { name: /Kartu Tanpa JS/ }).click();
	await expect(page.getByText('Utang sekarang')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Bayar tagihan' })).toBeVisible();
	await expectNoHorizontalScroll(page);
	// Another id is the same 404.
	const res = await page.request.get('/dompet/kartu/tidak-ada');
	expect(res.status()).toBe(404);
	await context.close();
});

test('a plain form post of a card keeps its sen exactly (AC 1)', async ({ browser }, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn55post');
	await postForm(page, '/dompet?/createWallet', {
		name: 'Kartu Pos',
		type: 'kartu_kredit',
		currency: 'IDR',
		balanceMode: 'card',
		openingBalance: '1.250.000,50',
		creditLimit: '15.000.000',
		statementDay: '25',
		dueDay: '12',
		lastFour: '0001'
	});
	await page.goto('/dompet');
	await expect(page.getByRole('link', { name: /Kartu Pos/ })).toContainText(
		`−${rp('1.250.000,50')}`
	);
	await context.close();
});
