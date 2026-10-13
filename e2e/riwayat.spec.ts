import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, TX_PAGE, waitForHydration } from './helpers';
import { addWallet, BASE, freshUser, ids, postExpense, rp, today } from './ledger';

/**
 * FN-05/06 journeys. Every test signs up its own fictional user in its own context (own simulated client
 * address), so its personal space starts empty and parallel tests never share rows. Setup data goes through
 * the app's own form actions (plain form posts), never straight into D1.
 */
const main = (page: Page) => page.locator('main');
/** A transaction row (its link opens the edit page), never a filter chip with the same word. */
const txRow = (page: Page, title: string) =>
	main(page).locator('a[href$="/edit"]').filter({ hasText: title });

async function walletBalance(page: Page, name: string) {
	await page.goto('/dompet');
	return main(page).getByRole('listitem').filter({ hasText: name });
}

test('Ketik manual from the Tambah sheet → expense saved → in Riwayat and in the wallet balance', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	await page.goto('/riwayat');
	await waitForHydration(page);
	await expect(page.getByText('Transaksi yang kamu catat muncul di sini.')).toBeVisible();

	await page.getByRole('button', { name: 'Tambah' }).filter({ visible: true }).click();
	await page
		.getByRole('dialog', { name: 'Tambah transaksi' })
		.getByRole('link', { name: /Ketik manual/ })
		.click();
	await page.waitForURL(`${BASE}/riwayat/baru`);
	await waitForHydration(page);
	await expect(page.getByRole('radio', { name: 'Pengeluaran', exact: true })).toBeChecked();
	await expect(page.getByLabel('Tanggal')).toHaveValue(today());
	await page.getByLabel('Jumlah').fill('25000');
	await page.getByRole('radio', { name: /Kopi/ }).check();
	await page.getByLabel('Judul (opsional)').fill('Kopi susu');
	await expectNoHorizontalScroll(page);
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();

	await page.waitForURL(/\/riwayat\?saved=created/);
	await expect(page.getByText('Transaksi disimpan.')).toBeVisible();
	await expect(main(page).getByText(`1 transaksi · ${rp('25.000')} keluar`)).toBeVisible();
	await expect(txRow(page, 'Kopi susu')).toContainText(`−${rp('25.000')}`);
	await expect(txRow(page, 'Kopi susu')).toContainText('Kopi · BCA');
	await page.reload();
	await expect(txRow(page, 'Kopi susu')).toBeVisible();
	await expectNoHorizontalScroll(page);
	await expect(await walletBalance(page, 'BCA')).toContainText(rp('75.000'));
	await context.close();
});

test('transfer between two wallets: listed, never in the totals, moves both balances', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	await addWallet(page, 'GoPay', '0');
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await page.getByRole('radio', { name: 'Transfer', exact: true }).check();
	await expect(page.getByLabel('Ke dompet')).toBeVisible();
	await expect(page.getByRole('radio', { name: /Kopi/ })).toBeHidden();
	await page.getByLabel('Jumlah').fill('40000');
	await page.getByLabel('Dari dompet').selectOption({ label: 'BCA · IDR' });
	await page.getByLabel('Ke dompet').selectOption({ label: 'GoPay · IDR' });
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();
	await page.waitForURL(/\/riwayat\?saved=created/);
	const row = txRow(page, 'Transfer');
	await expect(row).toContainText('BCA → GoPay');
	await expect(row).toContainText(rp('40.000'));
	await expect(row).not.toContainText('−');
	await expect(main(page).getByText(`1 transaksi · ${rp('0')} keluar`)).toBeVisible();
	await expect(await walletBalance(page, 'BCA')).toContainText(rp('60.000'));
	await expect(await walletBalance(page, 'GoPay')).toContainText(rp('40.000'));
	await context.close();
});

test('edit saves; a second tab with the stale form is refused with "Berubah sejak terakhir dimuat"', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi susu'
	});
	await page.goto('/riwayat');
	await txRow(page, 'Kopi susu').click();
	await page.waitForURL(/\/riwayat\/.+\/edit$/);
	const editUrl = page.url();
	const second = await context.newPage();
	await second.goto(editUrl);
	await waitForHydration(second);
	await waitForHydration(page);

	await page.getByLabel('Jumlah').fill('30000');
	await page.getByRole('button', { name: 'Simpan perubahan' }).click();
	await page.waitForURL(/\/riwayat\?saved=updated/);
	await expect(txRow(page, 'Kopi susu')).toContainText(`−${rp('30.000')}`);

	await second.getByLabel('Jumlah').fill('99000');
	await second.getByRole('button', { name: 'Simpan perubahan' }).click();
	await expect(
		second.getByText('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.')
	).toBeVisible();
	await page.reload();
	await expect(txRow(page, 'Kopi susu')).toContainText(`−${rp('30.000')}`);
	await context.close();
});

test('delete with confirm: gone from the list and the balance', async ({ browser }, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi susu'
	});
	await page.goto('/riwayat');
	await txRow(page, 'Kopi susu').click();
	await page.waitForURL(TX_PAGE);
	await waitForHydration(page);
	await page.getByText('Hapus transaksi').click();
	await page.getByRole('button', { name: 'Ya, hapus' }).click();
	await page.waitForURL(/\/riwayat\?saved=deleted/);
	await expect(page.getByText('Transaksi dihapus.')).toBeVisible();
	await expect(page.getByText('Transaksi yang kamu catat muncul di sini.')).toBeVisible();
	await expect(await walletBalance(page, 'BCA')).toContainText(rp('100.000'));
	await context.close();
});

test('chips, search and the filter sheet narrow the list; totals follow the filter', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA', '1.000.000');
	await addWallet(page, 'GoPay', '0');
	const { wallet, category } = await ids(page);
	const bca = await wallet('BCA');
	const gopay = await wallet('GoPay');
	await postExpense(page, {
		walletId: bca,
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi susu'
	});
	await postExpense(page, {
		walletId: gopay,
		categoryId: await category('Transportasi'),
		amount: '5.000',
		title: 'Parkir mall'
	});
	await postExpense(page, {
		walletId: bca,
		categoryId: await category('Gaji'),
		amount: '500.000',
		title: 'Gaji',
		type: 'income'
	});

	await page.goto('/riwayat');
	await waitForHydration(page);
	await expect(main(page).getByText(`3 transaksi · ${rp('30.000')} keluar`)).toBeVisible();
	await main(page)
		.getByRole('link', { name: /Pemasukan/ })
		.click();
	await expect(main(page).getByText(`1 transaksi · ${rp('500.000')} masuk`)).toBeVisible();
	await expect(txRow(page, 'Kopi susu')).toHaveCount(0);
	await main(page).getByRole('link', { name: /Semua/ }).first().click();
	await page.waitForURL((url) => !url.search.includes('type='));
	await expect(main(page).getByText(`3 transaksi · ${rp('30.000')} keluar`)).toBeVisible();

	// Search runs as you type (APP_PARITY § 3); Enter submits the same GET form.
	await page.getByLabel('Cari judul atau catatan').fill('PARKIR');
	await expect(main(page).getByText(`1 transaksi · ${rp('5.000')} keluar`)).toBeVisible();
	await expect(page).toHaveURL(/q=PARKIR/);
	await expect(page.getByLabel('Cari judul atau catatan')).toBeFocused();
	await expect(txRow(page, 'Parkir mall')).toBeVisible();

	await page.goto('/riwayat');
	await waitForHydration(page);
	// The Dompet chip opens a picker sheet; picking a wallet narrows the list and marks the chip.
	await main(page).getByRole('link', { name: 'Dompet' }).click();
	const sheet = page.getByRole('dialog', { name: 'Dompet' });
	await sheet.getByRole('link', { name: /GoPay/ }).click();
	await expect(main(page).getByText(`1 transaksi · ${rp('5.000')} keluar`)).toBeVisible();
	await expect(main(page).getByRole('link', { name: 'GoPay', exact: true })).toHaveAttribute(
		'aria-current',
		'true'
	);

	// The Transfer type chip lists transfers only (none here).
	await main(page)
		.getByRole('navigation', { name: 'Jenis transaksi' })
		.getByRole('link', { name: /^Transfer/ })
		.click();
	await expect(page).toHaveURL(/type=transfer/);
	await expect(main(page).getByText('0 transaksi', { exact: true })).toBeVisible();

	await page.goto('/riwayat?q=tidak-ada-sama-sekali');
	await expect(page.getByText('Tidak ada transaksi yang cocok dengan filter ini.')).toBeVisible();
	await context.close();
});

test('"Muat lebih banyak" appends the 51st row without repeating any', async ({
	browser
}, testInfo) => {
	test.setTimeout(120_000);
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA', '10.000.000');
	const { wallet, category } = await ids(page);
	const walletId = await wallet('BCA');
	const categoryId = await category('Kopi');
	for (let i = 1; i <= 51; i++)
		await postExpense(page, { walletId, categoryId, amount: '1.000', title: `Baris ${i}` });

	await page.goto('/riwayat');
	await waitForHydration(page);
	await expect(main(page).getByText(`51 transaksi · ${rp('51.000')} keluar`)).toBeVisible();
	const rows = main(page).locator('a[href$="/edit"]');
	await expect(rows).toHaveCount(50);
	await page.getByRole('link', { name: 'Muat lebih banyak' }).click();
	await expect(rows).toHaveCount(51);
	const titles = await rows.allInnerTexts();
	expect(new Set(titles).size).toBe(51);
	await expect(page.getByRole('link', { name: 'Muat lebih banyak' })).toHaveCount(0);
	await context.close();
});

test('manage categories: a hidden category leaves the picker but old rows still show it', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Ngopi'
	});

	await page.goto('/riwayat/baru');
	await page.getByRole('link', { name: 'Kelola kategori' }).click();
	await page.waitForURL(`${BASE}/pengaturan/kategori`);
	await waitForHydration(page);
	const kopi = main(page)
		.getByRole('listitem')
		.filter({ hasText: /^\s*☕?\s*Kopi/ });
	await kopi.getByRole('button', { name: 'Sembunyikan' }).click();
	await expect(page.getByText('Kategori disembunyikan.')).toBeVisible();

	await page.getByRole('link', { name: 'Tambah kategori' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah kategori' });
	await sheet.getByLabel('Nama kategori').fill('Kucing');
	await sheet.getByRole('button', { name: 'Tambah kategori' }).click();
	await expect(page.getByText('Kategori ditambahkan.')).toBeVisible();

	await page.goto('/riwayat/baru');
	await expect(page.getByRole('radio', { name: /Kopi/ })).toHaveCount(0);
	await expect(page.getByRole('radio', { name: /Kucing/ })).toHaveCount(1);
	await page.goto('/riwayat');
	await expect(txRow(page, 'Ngopi')).toContainText('Kopi · BCA');
	await context.close();
});

test('balance adjustment (FN-37) at 360 px: from Dompet, listed under its chip, never in the totals', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.setViewportSize({ width: 360, height: 780 });
	// Touch targets are 44 px on a coarse pointer (the phone project); a mouse keeps the compact sizes.
	const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
	const minTarget = coarse ? 44 : 0;
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi susu'
	});

	// Dompet's wallet edit offers "set the balance to …", which opens the adjustment form on that wallet.
	await page.goto('/dompet');
	await waitForHydration(page);
	await main(page)
		.getByRole('listitem')
		.filter({ hasText: 'BCA' })
		.getByRole('link')
		.first()
		.click();
	await page.getByRole('link', { name: 'Sesuaikan saldo ke angka sebenarnya' }).click();
	await page.waitForURL(/\/riwayat\/baru\?type=adjustment&wallet=/);
	await waitForHydration(page);
	await expect(main(page).getByText(`Saldo BCA sekarang: ${rp('75.000')}`)).toBeVisible();
	await expectNoHorizontalScroll(page);
	for (const target of [
		main(page).getByLabel('Dompet'),
		page.getByText('Saldo minus (utang, misalnya tagihan kartu kredit)'),
		page.getByRole('button', { name: 'Simpan penyesuaian' })
	])
		expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(minTarget);

	// The same balance is refused and writes nothing.
	await page.getByLabel('Saldo baru').fill('75000');
	await page.getByRole('button', { name: 'Simpan penyesuaian' }).click();
	await expect(page.getByText('Saldo sudah sama, tidak ada perubahan.')).toBeVisible();

	await page.getByLabel('Saldo baru').fill('125000');
	await page.getByRole('button', { name: 'Simpan penyesuaian' }).click();
	await page.waitForURL(/\/riwayat\?saved=adjusted/);
	await expect(page.getByText('Saldo disesuaikan.')).toBeVisible();
	// Listed, signed, uncategorised; the month's spending stays Rp 25.000.
	const row = txRow(page, 'Penyesuaian saldo');
	await expect(row).toContainText(`+${rp('50.000')}`);
	await expect(row).toContainText('Saldo disesuaikan · BCA');
	await expect(main(page).getByText(`2 transaksi · ${rp('25.000')} keluar`)).toBeVisible();
	await expectNoHorizontalScroll(page);

	const chip = main(page)
		.getByRole('link', { name: /Penyesuaian saldo/ })
		.first();
	expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(minTarget);
	await chip.click();
	await page.waitForURL(/type=adjustment/);
	await expect(main(page).getByText('1 transaksi', { exact: true })).toBeVisible();
	await expect(txRow(page, 'Kopi susu')).toHaveCount(0);
	await expect(txRow(page, 'Penyesuaian saldo')).toBeVisible();
	await expectNoHorizontalScroll(page);

	// Its edit offers date, title and note only.
	await txRow(page, 'Penyesuaian saldo').click();
	await page.waitForURL(/\/riwayat\/.+\/edit$/);
	await expect(page.getByLabel('Jumlah')).toHaveCount(0);
	await expect(page.getByLabel('Saldo baru')).toHaveCount(0);
	await expect(
		page.getByText('Jumlah, arah dan dompet penyesuaian tidak bisa diubah.', { exact: false })
	).toBeVisible();

	await expect(await walletBalance(page, 'BCA')).toContainText(rp('125.000'));
	await context.close();
});
