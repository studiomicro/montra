import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	expectNoHorizontalScroll,
	newUser,
	type UserOptions,
	waitForHydration
} from './helpers';

/**
 * FN-48 Part C "Cocokkan transfer" in a real browser: the /impor card, the review at 360 px on a touch screen
 * (confirm, skip and undo controls ≥ 44 px, no horizontal scroll), a merge shown as saved only after the server
 * answered and persisted across a reload, the undo, and the whole flow as plain form posts without JavaScript.
 * Every test signs up its own fictional user; the two rows come from a CSV import through the app's own form.
 */
const HEADER =
	'date,type,merchant,amount,currency,category,payment_method,recurrence,tag,notes,wallet_source,reference';
// The owner's shape: a BCA debit on 10 July and the OCBC credit the next day, Rp 5.000.000 each, both already in
// the "Transfer" categories (the import keeps the named category).
const PAIR_FILE = {
	name: 'mutasi-juli.csv',
	mimeType: 'text/csv',
	buffer: Buffer.from(
		[
			HEADER,
			'2026-07-10,expense,SWITCHING DB TRF UJI 009 BANK CENTRA,5.000.000,IDR,Transfer keluar,,,,,BCA,',
			'2026-07-11,income,SWITCHING CR TRF UJI,5.000.000,IDR,Transfer masuk,,,,,OCBC,'
		].join('\r\n') + '\r\n',
		'utf8'
	)
};

const freshUser = (browser: Browser, testInfo: TestInfo, opts: UserOptions = {}) =>
	newUser(browser, testInfo, { prefix: 'fn48c', name: 'Pencocok', ...opts });

/** Imports the pair through /impor's own form (works with and without JavaScript). */
async function importPair(page: Page, js: boolean) {
	await page.goto(`${APP_ORIGIN}/impor`);
	if (js) await waitForHydration(page);
	await page.getByLabel('Pilih berkas CSV').setInputFiles(PAIR_FILE);
	if (js)
		await expect(
			page.getByText('Siap diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0')
		).toBeVisible();
	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();
}

test('at 360 px on a touch screen: card, review, confirm, undo and skip; saved only after the server answered', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, {
		viewport: { width: 360, height: 780 },
		hasTouch: true,
		isMobile: true
	});
	await importPair(page, true);

	// The card appears only now that the space has a pair (a true empty state before).
	await page.goto(`${APP_ORIGIN}/impor`);
	await waitForHydration(page);
	const card = page.getByRole('region', { name: 'Cocokkan transfer' });
	await expect(
		card.getByText('1 pasangan transfer antar dompetmu sendiri mungkin terbaca dua kali.')
	).toBeVisible();
	await card.getByRole('link', { name: 'Tinjau dan cocokkan' }).click();
	await page.waitForURL(`${APP_ORIGIN}/impor/cocokkan-transfer`);

	await expect(page.getByRole('heading', { level: 1, name: 'Cocokkan transfer' })).toBeVisible();
	await expect(page.getByText('SWITCHING DB TRF UJI 009 BANK CENTRA')).toBeVisible();
	await expect(page.getByText('SWITCHING CR TRF UJI')).toBeVisible();
	await expect(page.getByText(/BCA · /)).toBeVisible();
	await expect(page.getByText(/OCBC · /)).toBeVisible();
	await expect(page.getByText('Beberapa kandidat')).toHaveCount(0);
	const confirm = page.getByRole('button', { name: 'Cocokkan', exact: true });
	const skip = page.getByRole('button', { name: 'Lewati' });
	for (const target of [confirm, skip])
		expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expectNoHorizontalScroll(page);
	// The viewport only: a full-page capture of a page taller than the screen resizes the page for the shot, and
	// Chromium then drops the touch emulation (pointer: coarse), so a later measurement would read the fine-pointer
	// 40 px size (FN-55 QA).
	await testInfo.attach('cocokkan-transfer-360', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

	await confirm.click();
	await expect(page.getByText('Pasangan dicocokkan menjadi satu transfer.')).toBeVisible();
	await expect(
		page.getByText('Tidak ada pasangan transfer yang perlu dicocokkan sekarang.')
	).toBeVisible();
	const undo = page.getByRole('button', { name: 'Urungkan' });
	await expect(undo).toBeVisible();
	expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expectNoHorizontalScroll(page);

	// Persisted: after a reload the merge is still there and Riwayat shows one transfer, not two rows.
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByRole('region', { name: 'Sudah dicocokkan' })).toBeVisible();
	await page.goto(`${APP_ORIGIN}/riwayat?month=2026-07`);
	await expect(page.getByText('SWITCHING DB TRF UJI 009 BANK CENTRA')).toHaveCount(1);
	await expect(page.getByText('SWITCHING CR TRF UJI')).toHaveCount(0);
	await page.goto(`${APP_ORIGIN}/impor`);
	await waitForHydration(page);
	await expect(page.getByRole('region', { name: 'Cocokkan transfer' })).toHaveCount(0);

	// Undo restores both rows; the pair is offered again.
	await page.goto(`${APP_ORIGIN}/impor/cocokkan-transfer`);
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Urungkan' }).click();
	await expect(
		page.getByText('Pencocokan diurungkan; kedua transaksi dikembalikan.')
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Cocokkan', exact: true })).toBeVisible();
	await page.goto(`${APP_ORIGIN}/riwayat?month=2026-07`);
	await expect(page.getByText('SWITCHING CR TRF UJI')).toHaveCount(1);

	// Skip hides the group for this visit only (nothing written): it is back after a reload.
	await page.goto(`${APP_ORIGIN}/impor/cocokkan-transfer`);
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Lewati' }).click();
	await expect(
		page.getByText('Tidak ada pasangan transfer yang perlu dicocokkan sekarang.')
	).toBeVisible();
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByRole('button', { name: 'Cocokkan', exact: true })).toBeVisible();
	await context.close();
});

test('without JavaScript: confirm and undo work as plain form posts', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await importPair(page, false);
	await page.goto(`${APP_ORIGIN}/impor/cocokkan-transfer`);
	await page.getByRole('button', { name: 'Cocokkan', exact: true }).click();
	await expect(page.getByText('Pasangan dicocokkan menjadi satu transfer.')).toBeVisible();
	await page.goto(`${APP_ORIGIN}/impor/cocokkan-transfer`);
	await page.getByRole('button', { name: 'Urungkan' }).click();
	await expect(
		page.getByText('Pencocokan diurungkan; kedua transaksi dikembalikan.')
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Cocokkan', exact: true })).toBeVisible();
	await context.close();
});
