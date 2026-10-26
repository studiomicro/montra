import { expect, test } from '@playwright/test';
import {
	APP_ORIGIN,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	tickSignUpBoxes,
	waitForHydration
} from './helpers';
import { addWallet } from './ledger';
import { buildXlsx } from '../test/helpers/xlsx';

/**
 * FN-17 journey: a fictional user uploads a small generated .xlsx (built in memory, never committed), confirms
 * the column mapping, sees the review counts, imports, finds the rows in Riwayat, then undoes the import.
 */

const WORKBOOK = buildXlsx([
	{
		name: 'Pengeluaran Okt 2026',
		rows: [
			['Catatan belanja keluarga fiktif'],
			['Tanggal', 'Keterangan', 'Kategori', 'Jumlah'],
			['2026-10-02', 'Kopi sheet fiktif', 'Makan & Minum', 28000],
			['2026-10-03', 'Parkir sheet fiktif', 'Transportasi', 5000],
			['2026-10-04', 'Jajan sheet fiktif', 'Jajan', 12500],
			[null, 'Total', null, 45500]
		]
	}
]);

test('spreadsheet: upload, confirm mapping, review, import, see in Riwayat, undo', async ({
	browser
}, testInfo) => {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 3) }
	});
	const page = await context.newPage();
	await page.goto(`${APP_ORIGIN}/daftar`);
	await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pengimpor Sheet');
	await page
		.getByLabel('E-mail')
		.fill(`fn17-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill('terang-benderang-8');
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${APP_ORIGIN}/`);
	await addWallet(page, 'Kas Sheet');

	await page.goto(`${APP_ORIGIN}/impor`);
	await waitForHydration(page);
	await page
		.getByRole('radiogroup', { name: 'Jenis berkas' })
		.getByRole('radio', { name: 'Spreadsheet' })
		.check();
	const section = page.locator('#spreadsheet');
	await expect(
		section.getByRole('heading', { level: 3, name: 'Impor spreadsheet (.xlsx)' })
	).toBeVisible();
	await expect(
		section.getByText('Dari Google Sheets: Berkas > Unduh > Microsoft Excel (.xlsx) atau CSV.')
	).toBeVisible();

	// Picking the file reads it on the server at once: the proposed mapping, no write yet.
	await section.getByLabel('Pilih berkas .xlsx').setInputFiles({
		name: 'keuangan-fiktif.xlsx',
		mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		buffer: Buffer.from(WORKBOOK)
	});
	await expect(section.getByText('Pengeluaran Okt 2026')).toBeVisible();
	await expect(section.getByText('Siap', { exact: true })).toBeVisible();
	await expect(section.getByLabel(/Kolom D · Jumlah/)).toHaveValue('amount');
	await expectNoHorizontalScroll(page);

	// Confirm the mapping: the review counts (the total row is skipped, never added).
	await section.getByRole('button', { name: 'Pakai pemetaan ini' }).click();
	await expect(
		section.getByText('Siap diimpor 3 · Dilewati 1 · Sudah pernah diimpor 0')
	).toBeVisible();
	await expect(section.getByText('Baris total atau saldo: 1')).toBeVisible();
	await expect(section.getByText(/Jajan → Tanpa kategori/)).toBeVisible();
	await expectNoHorizontalScroll(page);

	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(section.getByText('Diimpor 3 · Dilewati 1 · Sudah pernah diimpor 0')).toBeVisible();
	const batch = page.getByRole('listitem').filter({ hasText: 'keuangan-fiktif.xlsx' });
	await expect(batch.getByText(/Spreadsheet/)).toBeVisible();

	// The rows are in Riwayat once the server confirmed the write.
	await section.getByRole('link', { name: 'Lihat di Riwayat' }).click();
	await page.goto(`${APP_ORIGIN}/riwayat?from=2026-10-01&to=2026-10-31`);
	await expect(page.getByText('Kopi sheet fiktif')).toBeVisible();
	await expect(page.getByText('Jajan sheet fiktif')).toBeVisible();

	// Undo: every row of the batch leaves Riwayat.
	await page.goto(`${APP_ORIGIN}/impor`);
	await waitForHydration(page);
	const row = page.getByRole('listitem').filter({ hasText: 'keuangan-fiktif.xlsx' });
	await row.getByText('Urungkan', { exact: true }).click();
	await row.getByRole('button', { name: 'Ya, urungkan' }).click();
	await expect(page.getByText('Impor diurungkan.')).toBeVisible();
	await page.goto(`${APP_ORIGIN}/riwayat?from=2026-10-01&to=2026-10-31`);
	await expect(page.getByText('Kopi sheet fiktif')).toHaveCount(0);
	await context.close();
});
