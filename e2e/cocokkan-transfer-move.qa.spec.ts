import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	SIGNED_OUT,
	simulatedClientIp,
	tickSignUpBoxes,
	waitForHydration
} from './helpers';

/**
 * FN-48 Part C "Cocokkan transfer" in a real browser: the /impor card, the review at 360 px on a touch screen
 * (confirm, skip and undo controls ≥ 44 px, no horizontal scroll), a merge shown as saved only after the server
 * answered and persisted across a reload, the undo, and the whole flow as plain form posts without JavaScript.
 * Every test signs up its own fictional user; the two rows come from a CSV import through the app's own form.
 */
const BASE = APP_ORIGIN;
const PASSWORD = 'terang-benderang-8';
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

async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: {
		javaScriptEnabled?: boolean;
		viewport?: { width: number; height: number };
		hasTouch?: boolean;
		isMobile?: boolean;
	} = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) },
		...opts
	});
	const page = await context.newPage();
	await page.goto(`${BASE}/daftar`);
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pencocok');
	await page
		.getByLabel('E-mail')
		.fill(`fn48c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	return { context, page };
}

/** Imports the pair through /impor's own form (works with and without JavaScript). */
async function importPair(page: Page, js: boolean) {
	await page.goto(`${BASE}/impor`);
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

const LINKED =
	'Ada transfer dari impor ini yang sudah dicocokkan. Urungkan pencocokan transfer itu dulu untuk memindahkan impor ini.';
const MIXED =
	'Transaksi di impor ini ada di lebih dari satu dompet — tidak bisa dipindahkan sekaligus.';

test('QA cycle 2: /impor shows the transfer_linked note while the match is live, and not after undo', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await importPair(page, true);
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await expect(page.getByText(MIXED)).toBeVisible();
	await expect(page.getByText(LINKED)).toHaveCount(0);

	await page.goto(`${BASE}/impor/cocokkan-transfer`);
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Cocokkan', exact: true }).click();
	await expect(page.getByText('Pasangan dicocokkan menjadi satu transfer.')).toBeVisible();

	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await expect(page.getByText(LINKED)).toBeVisible();
	await expect(page.getByText(MIXED)).toHaveCount(0);
	await expect(page.getByText('Pindahkan ke dompet lain')).toHaveCount(0);

	await page.goto(`${BASE}/impor/cocokkan-transfer`);
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Urungkan' }).click();
	await expect(
		page.getByText('Pencocokan diurungkan; kedua transaksi dikembalikan.')
	).toBeVisible();
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await expect(page.getByText(LINKED)).toHaveCount(0);
	await expect(page.getByText(MIXED)).toBeVisible();
	await context.close();
});

const csvOf = (name: string, line: string) => ({
	name,
	mimeType: 'text/csv',
	buffer: Buffer.from([HEADER, line].join('\r\n') + '\r\n', 'utf8')
});

test('QA cycle 3 (L2): undoing the credit import after the merged transfer was edited says the transfer stays', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	for (const [file, rows] of [
		[
			'debit.csv',
			'2026-07-10,expense,SWITCHING DB TRF UJI 009 BANK CENTRA,5.000.000,IDR,Transfer keluar,,,,,BCA,'
		],
		['credit.csv', '2026-07-11,income,SWITCHING CR TRF UJI,5.000.000,IDR,Transfer masuk,,,,,OCBC,']
	] as const) {
		await page.goto(`${BASE}/impor`);
		await waitForHydration(page);
		await page.getByLabel('Pilih berkas CSV').setInputFiles(csvOf(file, rows));
		await expect(
			page.getByText('Siap diimpor 1 · Dilewati 0 · Sudah pernah diimpor 0')
		).toBeVisible();
		await page.getByRole('button', { name: 'Impor', exact: true }).click();
		await expect(
			page.getByText('Diimpor 1 · Dilewati 0 · Sudah pernah diimpor 0', { exact: true }).first()
		).toBeVisible();
	}
	await page.goto(`${BASE}/impor/cocokkan-transfer`);
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Cocokkan', exact: true }).click();
	await expect(page.getByText('Pasangan dicocokkan menjadi satu transfer.')).toBeVisible();

	// the user edits the merged transfer's note
	await page.goto(`${BASE}/riwayat?month=2026-07`);
	await page.locator('main a[href$="/edit"]').first().click();
	await page.waitForURL(/\/riwayat\/.+\/edit$/);
	await waitForHydration(page);
	await page.getByLabel('Catatan (opsional)').fill('Saya ubah');
	await page.getByRole('button', { name: 'Simpan perubahan' }).click();
	await page.waitForURL(/\/riwayat\?/);

	// undo the credit's import (the second batch: newest first)
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	const batches = page.locator('#riwayat-impor, main').locator('details.confirm');
	await batches.first().locator('summary').click();
	await batches.first().getByRole('button', { name: 'Ya, urungkan' }).click();
	await expect(
		page.getByText(
			'Impor diurungkan. Transfer hasil Cocokkan transfer yang kamu ubah tetap seperti yang kamu simpan; periksa di Riwayat.'
		)
	).toBeVisible();
	await context.close();
});
