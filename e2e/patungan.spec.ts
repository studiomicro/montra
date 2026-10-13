import { expect, test, type Page } from '@playwright/test';
import { collectCspViolations, expectNoHorizontalScroll, waitForHydration } from './helpers';
import { addWallet, BASE, freshUser, ids, postExpense, rp } from './ledger';

/**
 * FN-49 Patungan pass 1 journeys (every rule is also covered by Vitest against local D1,
 * test/integration/patungan*.test.ts): split an existing bill from Riwayat, mark someone paid, and see Riwayat
 * show the full amount with "bagianmu" under it while its header counts only the share; at 360 px, in both
 * themes, and without JavaScript.
 */
const main = (page: Page) => page.locator('main');

async function expectTargets(page: Page, targets: ReturnType<Page['locator']>[]) {
	const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
	if (!coarse) return;
	for (const target of targets) {
		const box = await target.boundingBox();
		expect(
			box?.height,
			await target.evaluate((e) => e.outerHTML.slice(0, 80))
		).toBeGreaterThanOrEqual(44);
	}
}

for (const colorScheme of ['light', 'dark'] as const) {
	test(`split a bill from Riwayat: only my share counts, the bill keeps its amount (${colorScheme})`, async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn49');
		await page.emulateMedia({ colorScheme });
		const csp = collectCspViolations(page);
		await addWallet(page, 'BCA');
		const { wallet, category } = await ids(page);
		await postExpense(page, {
			walletId: await wallet('BCA'),
			categoryId: await category('Makan & Minum'),
			amount: '400.000',
			title: 'Makan bareng'
		});

		await page.goto('/riwayat');
		await waitForHydration(page);
		await main(page)
			.getByRole('link', { name: /Makan bareng/ })
			.click();
		await waitForHydration(page);
		await main(page).getByRole('link', { name: 'Buat patungan' }).click();
		await page.waitForURL(/\/patungan\/baru\?dariTransaksi=/);
		await waitForHydration(page);
		await expect(main(page).getByText(rp('400.000')).first()).toBeVisible();
		for (const [i, name] of ['Rina', 'Dodi', 'Eko'].entries())
			await page.getByLabel(`Teman ${i + 1}`, { exact: true }).fill(name);
		// The equal preview: Rp 100.000 for each of the four.
		await expect(main(page).locator('.share', { hasText: rp('100.000') })).toHaveCount(4);
		await expectNoHorizontalScroll(page);
		const save = page.getByRole('button', { name: 'Simpan patungan' });
		await expectTargets(page, [save, page.getByRole('button', { name: 'Tambah teman' })]);
		await save.click();

		await page.waitForURL(/\/patungan\/[^/?]+\?saved=created/);
		await expect(page.getByText('Patungan disimpan.')).toBeVisible();
		await expect(main(page)).toContainText('Semua total hanya menghitung bagianmu');
		await expectNoHorizontalScroll(page);
		const settle = main(page).getByRole('button', { name: 'Tandai lunas' }).first();
		await expectTargets(page, [settle]);
		await settle.click();
		await page.waitForURL(/saved=settled/);
		await expect(page.getByText('Ditandai lunas.')).toBeVisible();

		await page.goto('/patungan');
		await waitForHydration(page);
		await expect(main(page)).toContainText('Belum dilunasi');
		await expect(main(page)).toContainText(rp('200.000'));
		await expectNoHorizontalScroll(page);

		await page.goto('/riwayat');
		await waitForHydration(page);
		const row = main(page).getByRole('link', { name: /Makan bareng/ });
		await expect(row).toContainText(`−${rp('400.000')}`);
		await expect(row).toContainText(`patungan: bagianmu ${rp('100.000')}`);
		await expect(main(page)).toContainText(`${rp('100.000')} keluar`);
		await expectNoHorizontalScroll(page);
		expect(csp).toEqual([]);
		await context.close();
	});
}

test('without JavaScript: a refused split shows why; a valid one is saved and settled', async ({
	browser
}, testInfo) => {
	const { context: signedIn, page: setup } = await freshUser(browser, testInfo, 'fn49nojs');
	await addWallet(setup, 'BCA');
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: await signedIn.storageState()
	});
	const page = await context.newPage();
	await page.goto('/patungan/baru');
	await page.getByLabel('Total tagihan').fill('100.000');
	await page.getByLabel('Teman 1', { exact: true }).fill('Rina');
	await page.getByLabel('Kategori bagianmu').selectOption({ label: 'Makan & Minum' });
	await page.getByRole('button', { name: 'Simpan patungan' }).click();
	await expect(page.getByText('Isi nama patungan.')).toBeVisible();

	await page.getByLabel('Nama patungan').fill('Kopi sore');
	await page.getByLabel('Total tagihan').fill('100.000');
	await page.getByLabel('Teman 1', { exact: true }).fill('Rina');
	await page.getByLabel('Kategori bagianmu').selectOption({ label: 'Makan & Minum' });
	await page.getByRole('button', { name: 'Simpan patungan' }).click();
	await expect(page).toHaveURL(/\/patungan\/[^/?]+\?saved=created/);
	await expect(page.getByText('Patungan disimpan.')).toBeVisible();
	await page.getByRole('button', { name: 'Tandai lunas' }).click();
	await expect(page).toHaveURL(/saved=settled/);
	await expect(page.getByText('Ditandai lunas.')).toBeVisible();

	// The payer's own share (Rp 50.000) is the only new expense.
	await page.goto(`${BASE}/riwayat`);
	await expect(page.locator('main')).toContainText(`${rp('50.000')} keluar`);
	await context.close();
	await signedIn.close();
});
