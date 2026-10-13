import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, isPhone, waitForHydration } from './helpers';
import { addWallet, BASE, freshUser, ids, postExpense } from './ledger';

/**
 * QA for FN-20 (merchant recognition): browser-only criteria AC-15 (suggestion chip, never overwrites a picked
 * category), AC-17 (rules page: persists, delete, no JavaScript), AC-23 (360 px, 44 px targets). Every test
 * signs up its own fictional user; setup data goes through the app's own form posts.
 */
const main = (page: Page) => page.locator('main');

test('AC-15: chip appears with its reason, applies merchant + category, never overwrites a picked category', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn20a');
	await addWallet(page, 'Dompet QA');
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	const title = page.getByLabel('Judul (opsional)');
	const requests: string[] = [];
	page.on('request', (r) => {
		if (r.url().includes('/riwayat/saran')) requests.push(r.url());
	});

	// two characters: no request, no chip
	await title.fill('ko');
	await page.waitForTimeout(700);
	expect(requests.length).toBe(0);
	await expect(page.locator('button.suggestion')).toHaveCount(0);

	await title.fill('QRIS*KOPI KENANGAN JKT 0812 3456 7890');
	const chip = page.locator('button.suggestion');
	await expect(chip).toBeVisible();
	await expect(chip).toContainText('Kopi Kenangan');
	await expect(chip).toContainText('Kopi');
	expect(requests.length).toBe(1);
	if (isPhone(page)) {
		const box = (await chip.boundingBox())!;
		expect(box.height).toBeGreaterThanOrEqual(44);
		await expectNoHorizontalScroll(page);
	}
	await chip.click();
	await expect(title).toHaveValue('Kopi Kenangan');
	await expect(
		page.locator('label', { hasText: 'Kopi' }).first().locator('input[name="categoryId"]')
	).toBeChecked();

	// a category the user picked first is never overwritten
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await page.locator('label', { hasText: 'Hiburan' }).first().click();
	await page.getByLabel('Judul (opsional)').fill('Kopi Kenangan');
	await expect(page.locator('button.suggestion')).toBeVisible();
	await page.locator('button.suggestion').click();
	await expect(
		page.locator('label', { hasText: 'Hiburan' }).first().locator('input[name="categoryId"]')
	).toBeChecked();
	await context.close();
});

test('AC-5/17/23: a category correction teaches the space; rules page lists, persists, deletes; no JavaScript', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn20b');
	await addWallet(page, 'Dompet QA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('Dompet QA'),
		categoryId: await category('Makan'),
		amount: '15.000',
		title: 'Warung Bu Sari'
	});
	await page.goto('/pengaturan/pedagang');
	await expect(main(page)).toContainText('Belum ada aturan');

	// change the category of the saved transaction
	await page.goto('/riwayat');
	await main(page).locator('a[href$="/edit"]').filter({ hasText: 'Warung Bu Sari' }).click();
	await page.waitForURL(/\/riwayat\/.+\/edit$/);
	await waitForHydration(page);
	await page.locator('label', { hasText: 'Hiburan' }).first().click();
	await page.getByRole('button', { name: 'Simpan perubahan' }).click();
	await page.waitForURL(/\/riwayat\?saved=updated/);

	await page.goto('/pengaturan/pedagang');
	await waitForHydration(page);
	const row = page.locator('li.rule').filter({ hasText: 'Warung Bu Sari' });
	await expect(row).toContainText('Hiburan');
	await expect(row).toContainText('1 koreksi');
	if (isPhone(page)) {
		await expectNoHorizontalScroll(page);
		const del = row.getByRole('button', { name: 'Hapus' });
		const box = (await del.boundingBox())!;
		expect(box.height, 'delete button height').toBeGreaterThanOrEqual(44);
		expect(box.width, 'delete button width').toBeGreaterThanOrEqual(44);
	}
	await page.reload();
	await expect(page.locator('li.rule').filter({ hasText: 'Warung Bu Sari' })).toHaveCount(1);

	// the next typed entry shows "Dari aturanmu"
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await page.getByLabel('Judul (opsional)').fill('warung bu sari');
	await expect(page.locator('button.suggestion')).toContainText('Dari aturanmu');
	await expect(page.locator('button.suggestion')).toContainText('Hiburan');

	// delete without JavaScript
	const plain = await browser.newContext({
		javaScriptEnabled: false,
		storageState: await context.storageState(),
		viewport: page.viewportSize() ?? undefined
	});
	const p2 = await plain.newPage();
	await p2.goto(`${BASE}/pengaturan/pedagang`);
	await p2
		.locator('li.rule')
		.filter({ hasText: 'Warung Bu Sari' })
		.getByRole('button', { name: 'Hapus' })
		.click();
	await expect(p2.locator('main')).toContainText('Belum ada aturan');
	await plain.close();

	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await page.getByLabel('Judul (opsional)').fill('warung bu sari');
	await page.waitForTimeout(800);
	// history now names the saved Hiburan row, but never as a rule
	const chip = page.locator('button.suggestion');
	if (await chip.count()) await expect(chip).not.toContainText('Dari aturanmu');
	await context.close();
});

test('AC-6: a second user does not see the first user rules', async ({ browser }, testInfo) => {
	const a = await freshUser(browser, testInfo, 'fn20c');
	await addWallet(a.page, 'Dompet A');
	const ia = await ids(a.page);
	await postExpense(a.page, {
		walletId: await ia.wallet('Dompet A'),
		categoryId: await ia.category('Makan'),
		amount: '9.000',
		title: 'Toko Rahasia A'
	});
	await a.page.goto('/riwayat');
	await a.page.locator('main a[href$="/edit"]').filter({ hasText: 'Toko Rahasia A' }).click();
	await a.page.waitForURL(/\/riwayat\/.+\/edit$/);
	await waitForHydration(a.page);
	await a.page.locator('label', { hasText: 'Hiburan' }).first().click();
	await a.page.getByRole('button', { name: 'Simpan perubahan' }).click();
	await a.page.waitForURL(/\/riwayat\?saved=updated/);
	await a.page.goto('/pengaturan/pedagang');
	await expect(a.page.locator('li.rule')).toHaveCount(1);

	const b = await freshUser(browser, testInfo, 'fn20d');
	await b.page.goto('/pengaturan/pedagang');
	await expect(b.page.locator('li.rule')).toHaveCount(0);
	await expect(b.page.locator('main')).not.toContainText('Toko Rahasia A');
	await a.context.close();
	await b.context.close();
});

test('AC-16: one tap on a draft row category changes only that draft and teaches the space', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn20e');
	await addWallet(page, 'Dompet QA');
	await page.goto('/kotak-masuk');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Tambah draf contoh' }).click();
	await expect(page.getByText('4 draf contoh ditambahkan.')).toBeVisible();
	await page.goto('/kotak-masuk/periksa');
	await waitForHydration(page);

	const rows = page.locator('main ul > li');
	await expect(rows).toHaveCount(4);
	const row = rows.filter({ hasText: 'Toko Serba Ada' });
	const others = await rows.filter({ hasNotText: 'Toko Serba Ada' }).allInnerTexts();
	await row.locator('summary', { hasText: 'Ubah kategori' }).click();
	const pick = row.getByRole('button', { name: 'Hiburan' });
	if (isPhone(page)) {
		const box = (await pick.boundingBox())!;
		expect(box.height, 'category button height').toBeGreaterThanOrEqual(44);
		await expectNoHorizontalScroll(page);
	}
	await pick.click();
	await expect(page.getByText('1 draf diperbarui.')).toBeVisible();
	await expect(rows.filter({ hasText: 'Toko Serba Ada' })).toContainText('Hiburan');
	// the other drafts are untouched
	expect(await rows.filter({ hasNotText: 'Toko Serba Ada' }).allInnerTexts()).toEqual(others);

	await page.goto('/pengaturan/pedagang');
	const rule = page.locator('li.rule').filter({ hasText: 'Toko Serba Ada' });
	await expect(rule).toContainText('Hiburan');
	await expect(rule).toContainText('1 koreksi');
	await context.close();
});
