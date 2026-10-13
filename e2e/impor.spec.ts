import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	tickSignUpBoxes,
	APP_ORIGIN,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration
} from './helpers';
import { addWallet } from './ledger';
import { buildPdf, textContent } from '../test/helpers/pdf';
import { BCA_SEPTEMBER, bcaPdf } from '../test/fixtures/statements/bca';
import { BCA_CSV_SEPTEMBER, bcaCsv } from '../test/fixtures/statements/bca-csv';
import { BNI_JUNE, bniPdf } from '../test/fixtures/statements/bni';
import { MANDIRI_AUGUST, mandiriPdf } from '../test/fixtures/statements/mandiri';
import { OCBC_JULY, ocbcPdf } from '../test/fixtures/statements/ocbc';

/**
 * FN-18 journeys. Every test signs up its own fictional user in its own context, so its personal space starts
 * empty. Files are built in memory and handed to the file input (setInputFiles); nothing is written to D1 by
 * the test itself.
 */
const BASE = APP_ORIGIN;
const PASSWORD = 'terang-benderang-8';
const HEADER =
	'date,type,merchant,amount,currency,category,payment_method,recurrence,tag,notes,wallet_source,reference';

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
		acceptDownloads: true,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) },
		...opts
	});
	const page = await context.newPage();
	await page.goto(`${BASE}/daftar`);
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pengimpor');
	await page
		.getByLabel('E-mail')
		.fill(`fn18-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	return { context, page };
}

const csv = (name: string, lines: string[]) => ({
	name,
	mimeType: 'text/csv',
	buffer: Buffer.from([HEADER, ...lines].join('\r\n') + '\r\n', 'utf8')
});

const FILE_A = csv('mutasi-a.csv', [
	'2026-10-02,expense,Kopi Pagi,28.000,IDR,Kopi,QRIS,,,,Tunai,',
	'2026-10-03,expense,=SUM(1+1),15000,IDR,Belanja,,,,,Tunai,',
	'2026-10-04,transfer,Pindah,5000,IDR,,,,,,Tunai,'
]);
// Same Kopi Pagi row as file A (another export of the same days) plus one new row.
const FILE_B = csv('mutasi-b.csv', [
	'02/10/2026;expense;Kopi Pagi;"28000";IDR;Kopi;;;;;Tunai;'.replaceAll(';', ','),
	'2026-10-05,income,Honor,"Rp 500.000,00",IDR,Freelance,,,,,BCA,'
]);

/** One "Impor berkas" card shows one source at a time; the choice is a radio group that works without JavaScript. */
async function chooseSource(page: Page, name: 'CSV' | 'Spreadsheet' | 'Mutasi bank' | 'Foto') {
	await page.getByRole('radiogroup', { name: 'Jenis berkas' }).getByRole('radio', { name }).check();
}

async function chooseFile(page: Page, file: ReturnType<typeof csv>) {
	await page.getByLabel('Pilih berkas CSV').setInputFiles(file);
}

test('import with preview, duplicate flag, re-import, undo and a formula-safe export', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Impor' })).toBeVisible();
	await expect(page.getByText('Belum ada impor.')).toBeVisible();

	// Device summary at once, then the server preview (no write yet).
	await chooseFile(page, FILE_A);
	await expect(page.getByText(/3 baris · format Template/)).toBeVisible();
	await expect(
		page.getByText('Siap diimpor 2 · Dilewati 1 · Sudah pernah diimpor 0')
	).toBeVisible();
	await expect(page.getByText('Belum ada impor.')).toBeVisible();

	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 2 · Dilewati 1 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText('mutasi-a.csv')).toBeVisible();

	// The same file again: every row already imported, nothing new.
	await chooseFile(page, FILE_A);
	await expect(
		page.getByText('Siap diimpor 0 · Dilewati 1 · Sudah pernah diimpor 2')
	).toBeVisible();

	// Another file overlapping the first: the overlapping row is flagged and left out.
	await chooseFile(page, FILE_B);
	await expect(page.getByText('Mungkin duplikat: 1')).toBeVisible();
	await expect(page.getByText('Mungkin duplikat', { exact: true })).toBeVisible();
	await expect(page.getByText('Baris 1 ·')).toBeVisible();
	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 1 · Dilewati 1 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();

	// Riwayat lists the imported rows.
	await page.goto(`${BASE}/riwayat?from=2026-10-01&to=2026-10-31`);
	await expect(page.getByText('Kopi Pagi')).toHaveCount(1);
	await expect(page.getByText('Honor')).toBeVisible();

	// Export: a download whose formula cell is neutralised.
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await page.getByLabel('Dari tanggal').fill('2026-10-01');
	await page.getByLabel('Sampai tanggal').fill('2026-10-31');
	const downloading = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Ekspor CSV' }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe('montra-2026-10-01-2026-10-31.csv');
	const text = await readFile((await download.path())!, 'utf8');
	expect(text).toContain("'=SUM(1+1)");
	expect(text).not.toMatch(/(^|,)=SUM/m);
	expect(text).not.toContain('Pindah');
	expect(text).toContain('Honor');

	// Undo the first import: its rows leave Riwayat once the server confirms.
	const first = page.getByRole('listitem').filter({ hasText: 'mutasi-a.csv' });
	await first.getByText('Urungkan', { exact: true }).click();
	await first.getByRole('button', { name: 'Ya, urungkan' }).click();
	await expect(page.getByText('Impor diurungkan.')).toBeVisible();
	await expect(first.getByText('Diurungkan')).toBeVisible();
	await page.goto(`${BASE}/riwayat?from=2026-10-01&to=2026-10-31`);
	await expect(page.getByText('Kopi Pagi')).toHaveCount(0);
	await expect(page.getByText('Honor')).toBeVisible();
	await context.close();
});

test('FN-16j at 360 px on a touch screen: "Pindahkan ke dompet lain" moves a whole import and survives a reload', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, {
		viewport: { width: 360, height: 780 },
		hasTouch: true,
		isMobile: true
	});
	await addWallet(page, 'Rekening Tujuan');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await chooseFile(page, FILE_A);
	await expect(
		page.getByText('Siap diimpor 2 · Dilewati 1 · Sudah pernah diimpor 0')
	).toBeVisible();
	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 2 · Dilewati 1 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();

	const item = page.getByRole('listitem').filter({ hasText: 'mutasi-a.csv' });
	const summary = item.getByText('Pindahkan ke dompet lain', { exact: true });
	await summary.click();
	const select = item.getByLabel('Dompet tujuan');
	const confirm = item.getByRole('button', { name: 'Ya, pindahkan' });
	// The rows sit in Tunai (their wallet_source): it is not offered as a target.
	await expect(select.locator('option')).toHaveText(['Rekening Tujuan']);
	await expect(item.getByText(/pindah dari Tunai ke dompet tujuan/)).toBeVisible();
	for (const target of [summary, select, confirm])
		expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expectNoHorizontalScroll(page);
	await testInfo.attach('impor-pindah-360', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});

	await confirm.click();
	await expect(page.getByText('2 transaksi dipindahkan ke Rekening Tujuan.')).toBeVisible();
	// Persisted: after a reload the batch moves from Rekening Tujuan, so Tunai is the target offered now.
	await page.reload();
	await waitForHydration(page);
	await item.getByText('Pindahkan ke dompet lain', { exact: true }).click();
	await expect(item.getByLabel('Dompet tujuan').locator('option')).toHaveText(['Tunai']);
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('without JavaScript: "Pindahkan ke dompet lain" moves as a plain form post', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await addWallet(page, 'Rekening Tujuan');
	await page.goto(`${BASE}/impor`);
	await chooseFile(page, FILE_A);
	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 2 · Dilewati 1 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();
	await page.goto(`${BASE}/impor`);
	const item = page.getByRole('listitem').filter({ hasText: 'mutasi-a.csv' });
	await item.getByText('Pindahkan ke dompet lain', { exact: true }).click();
	await item.getByLabel('Dompet tujuan').selectOption({ label: 'Rekening Tujuan' });
	await item.getByRole('button', { name: 'Ya, pindahkan' }).click();
	await expect(page.getByText('2 transaksi dipindahkan ke Rekening Tujuan.')).toBeVisible();
	// The rows now sit in Rekening Tujuan: the next page offers Tunai.
	await page.goto(`${BASE}/impor`);
	await item.getByText('Pindahkan ke dompet lain', { exact: true }).click();
	await expect(item.getByLabel('Dompet tujuan').locator('option')).toHaveText(['Tunai']);
	await context.close();
});

test('FN-16j AC-21: with no other same-currency wallet, the move control shows the reason instead of a select', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	// A fresh space has no wallet yet: the import auto-creates "Tunai" from wallet_source, leaving no other
	// same-currency wallet to move to.
	await chooseFile(page, FILE_A);
	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 2 · Dilewati 1 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();
	const item = page.getByRole('listitem').filter({ hasText: 'mutasi-a.csv' });
	await expect(
		item.getByText(
			'Belum ada dompet lain dengan mata uang yang sama. Tambahkan dompet dulu untuk memindahkan impor ini.'
		)
	).toBeVisible();
	await expect(item.getByText('Pindahkan ke dompet lain', { exact: true })).toHaveCount(0);
	await expect(item.getByLabel('Dompet tujuan')).toHaveCount(0);
	await context.close();
});

test('FN-16j AC-5: a batch whose rows sit in more than one wallet shows the move control disabled with its reason', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'Rekening Tujuan');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	const mixed = csv('mutasi-mix.csv', [
		'2026-10-02,expense,Kopi Pagi,28.000,IDR,Kopi,QRIS,,,,Tunai,',
		'2026-10-03,expense,Belanja Mix,15.000,IDR,Belanja,,,,,BCA,'
	]);
	await chooseFile(page, mixed);
	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();
	const item = page.getByRole('listitem').filter({ hasText: 'mutasi-mix.csv' });
	await expect(
		item.getByText(
			'Transaksi di impor ini ada di lebih dari satu dompet — tidak bisa dipindahkan sekaligus.'
		)
	).toBeVisible();
	await expect(item.getByText('Pindahkan ke dompet lain', { exact: true })).toHaveCount(0);
	await expect(item.getByLabel('Dompet tujuan')).toHaveCount(0);
	// Urungkan still works for a mixed-wallet batch: only the move control is blocked.
	await expect(item.getByText('Urungkan', { exact: true })).toBeVisible();
	await context.close();
});

test('an unknown header asks for the format; a broken file is refused inline', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await page.getByLabel('Pilih berkas CSV').setInputFiles({
		name: 'lain.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('Tanggal,Jumlah\n2026-10-01,5000\n')
	});
	await expect(page.getByText('Format tidak terdeteksi, pilih manual')).toBeVisible();
	// The template is chosen in a picker sheet (APP_PARITY § 3); choosing one reads the file again at once.
	await page.getByRole('button', { name: 'Deteksi otomatis' }).click();
	const templates = page.getByRole('dialog', { name: 'Template berkas' });
	await expect(templates.getByRole('radio', { name: /Deteksi otomatis/ })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await templates.getByRole('radio', { name: /Template Montra/ }).click();
	await expect(templates).toBeHidden();
	await expect(page.getByRole('button', { name: 'Template Montra' })).toBeFocused();
	await expect(
		page.getByText('Kolom berkas tidak cocok dengan format yang dipilih.')
	).toBeVisible();
	await page.getByLabel('Pilih berkas CSV').setInputFiles({
		name: 'rusak.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,type,merchant,amount\n"2026-10-01,expense,x,1\n')
	});
	await expect(
		page.getByText('Berkas CSV rusak: ada tanda kutip yang tidak ditutup.')
	).toBeVisible();
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('without JavaScript: import and export work as plain form posts', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto(`${BASE}/impor`);
	await chooseFile(page, FILE_A);
	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 2 · Dilewati 1 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();
	await page.getByLabel('Dari tanggal').fill('2026-10-01');
	await page.getByLabel('Sampai tanggal').fill('2026-10-31');
	const downloading = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Ekspor CSV' }).click();
	const download = await downloading;
	const text = await readFile((await download.path())!, 'utf8');
	expect(text).toContain('Kopi Pagi');
	await context.close();
});

test('the Dompet picker sheet chooses the wallet for rows without one; AI reading says why it is off', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	await addWallet(page, 'Jago');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await expect(page.getByRole('button', { name: 'Baca dengan AI' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Baca dengan AI' })).toHaveAccessibleDescription(
		'Pembacaan mutasi dengan AI belum dikonfigurasi. Untuk sekarang gunakan CSV.'
	);
	// The first wallet is the favourite: preselected.
	await page.getByRole('button', { name: 'BCA' }).click();
	const wallets = page.getByRole('dialog', { name: 'Dompet untuk baris tanpa dompet' });
	await expect(wallets.getByRole('radio')).toHaveCount(2);
	await expect(wallets.getByRole('radio', { name: /BCA/ })).toHaveAttribute('aria-checked', 'true');
	await wallets.getByRole('radio', { name: /Jago/ }).click();
	await expect(wallets).toBeHidden();
	await expect(page.getByRole('button', { name: 'Jago' })).toBeVisible();
	// The choice posts with the import: rows without a wallet land in Jago.
	await chooseFile(page, csv('tanpa-dompet.csv', ['2026-10-02,expense,Roti,12.000,IDR,,,,,,,']));
	await page.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(
		page.getByText('Diimpor 1 · Dilewati 0 · Sudah pernah diimpor 0', { exact: true }).first()
	).toBeVisible();
	await page.goto(`${BASE}/riwayat?period=range&from=2026-10-01&to=2026-10-31`);
	await expect(page.locator('main').getByText(/Roti/).first()).toBeVisible();
	await expect(page.locator('main').getByText(/Jago/).first()).toBeVisible();
	await expectNoHorizontalScroll(page);
	await context.close();
});

// FN-16a/16b/16c/16d: statement upload. BCA (PDF, CSV) and BNI (PDF) are read so far; a scan or an unknown bank ends in
// an honest refusal. PDFs are built in memory from invented text (test/helpers/pdf.ts, test/fixtures/statements).
const pdfFile = (name: string, bytes: Uint8Array) => ({
	name,
	mimeType: 'application/pdf',
	buffer: Buffer.from(bytes)
});
const SCANNED = pdfFile('pindai.pdf', buildPdf([{ content: '', image: true }]));
const TEXT_PDF = pdfFile(
	'mutasi-fiktif.pdf',
	buildPdf([{ content: textContent(['Bank Contoh Fiktif', 'Saldo awal 1.000.000,00']) }])
);

for (const colorScheme of ['light', 'dark'] as const) {
	test(`statement upload: a scan needs AI, an unknown bank is refused with what was read (${colorScheme})`, async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo);
		await page.emulateMedia({ colorScheme });
		await addWallet(page, 'BCA');
		await page.goto(`${BASE}/impor`);
		await waitForHydration(page);
		await chooseSource(page, 'Mutasi bank');
		const section = page.locator('#mutasi');
		await expect(
			section.getByRole('heading', { level: 3, name: 'Impor mutasi (PDF/CSV)' })
		).toBeVisible();
		await expect(section.getByText('Didukung: BCA, BNI, Mandiri, OCBC')).toBeVisible();
		await expect(section.getByLabel('Sandi PDF (jika ada)')).toHaveAttribute('type', 'password');

		await page.getByLabel('Pilih berkas mutasi').setInputFiles(SCANNED);
		await section.getByRole('button', { name: 'Pratinjau' }).click();
		await expect(section.getByRole('alert')).toContainText(
			'PDF ini berupa gambar (hasil pindai). Baca di perangkat lewat bagian "Baca dari foto atau tangkapan layar".'
		);
		// The sidebar card shows the same honest state.
		await expect(
			page.getByRole('status').filter({ hasText: 'PDF ini berupa gambar (hasil pindai).' })
		).toBeVisible();

		await page.getByLabel('Pilih berkas mutasi').setInputFiles(TEXT_PDF);
		await section.getByRole('button', { name: 'Impor', exact: true }).click();
		await expect(section.getByRole('alert')).toContainText('Format mutasi ini belum didukung.');
		await expect(section.getByRole('alert')).toContainText('Terbaca sebagai PDF teks, 1 halaman.');
		await expect(page.getByText('Belum ada impor.')).toBeVisible();
		await expectNoHorizontalScroll(page);
		await page.screenshot({
			path: testInfo.outputPath(`impor-mutasi-${colorScheme}.png`),
			fullPage: true
		});
		await context.close();
	});
}

test('statement upload: a BCA e-statement is detected, reconciles and imports once', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await chooseSource(page, 'Mutasi bank');
	const section = page.locator('#mutasi');
	const bca = pdfFile('mutasi-bca-fiktif.pdf', bcaPdf(BCA_SEPTEMBER));
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bca);
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	const result = section.getByRole('status').filter({ hasText: 'BCA ·' });
	await expect(result).toContainText('BCA ·');
	await expect(result).toContainText('Siap diimpor 7 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(result).toContainText('Saldo cocok');

	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bca);
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 7 · Dilewati 0 · Sudah pernah diimpor 0');
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bca);
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 0 · Dilewati 0 · Sudah pernah diimpor 7');
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('statement upload: a BCA mutation CSV (KlikBCA/myBCA) is detected, reconciles and imports', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await chooseSource(page, 'Mutasi bank');
	const section = page.locator('#mutasi');
	const csv = {
		name: 'mutasi-bca-fiktif.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(bcaCsv(BCA_CSV_SEPTEMBER))
	};
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(csv);
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	const result = section.getByRole('status').filter({ hasText: 'BCA ·' });
	await expect(result).toContainText('Siap diimpor 7 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(result).toContainText('Saldo cocok');
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(csv);
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 7 · Dilewati 0 · Sudah pernah diimpor 0');
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('statement upload: a password-protected BNI mutasi asks for the password, then reconciles and imports', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BNI');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await chooseSource(page, 'Mutasi bank');
	const section = page.locator('#mutasi');
	await expect(section.getByText('Didukung: BCA, BNI, Mandiri, OCBC')).toBeVisible();
	const bni = pdfFile('mutasi-bni-fiktif.pdf', bniPdf(BNI_JUNE, 'sandi-bni-fiktif'));
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bni);
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	await expect(section.getByRole('alert')).toContainText('PDF ini dikunci sandi.');

	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bni);
	await section.getByLabel('Sandi PDF (jika ada)').fill('bukan-sandinya');
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	await expect(section.getByRole('alert')).toContainText('Sandi PDF salah.');

	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bni);
	await section.getByLabel('Sandi PDF (jika ada)').fill('sandi-bni-fiktif');
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	const result = section.getByRole('status').filter({ hasText: 'BNI ·' });
	await expect(result).toContainText('Siap diimpor 7 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(result).toContainText('Saldo cocok');

	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bni);
	await section.getByLabel('Sandi PDF (jika ada)').fill('sandi-bni-fiktif');
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 7 · Dilewati 0 · Sudah pernah diimpor 0');
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('statement upload: a Mandiri consolidated statement asks which account, then imports that one', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'Mandiri');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await chooseSource(page, 'Mutasi bank');
	const section = page.locator('#mutasi');
	await page
		.getByLabel('Pilih berkas mutasi')
		.setInputFiles(pdfFile('mutasi-mandiri-fiktif.pdf', mandiriPdf(MANDIRI_AUGUST)));
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	await expect(section.getByRole('alert')).toContainText('Berkas ini berisi beberapa rekening.');
	const accounts = section.getByRole('group', { name: 'Rekening dalam berkas ini' });
	await expect(accounts.getByRole('radio')).toHaveCount(2);
	await accounts.getByLabel(/Giro Fiktif ••6667/).check();
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	const result = section.getByRole('status').filter({ hasText: 'Mandiri ·' });
	await expect(result).toContainText('Rekening: Giro Fiktif ••6667');
	await expect(result).toContainText('Siap diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(result).toContainText('Saldo cocok');
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(accounts.getByLabel(/Giro Fiktif ••6667/)).toBeChecked();
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('without JavaScript: the Mandiri account picker works as plain form posts (FN-16e)', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await addWallet(page, 'Mandiri');
	await page.goto(`${BASE}/impor`);
	await chooseSource(page, 'Mutasi bank');
	const section = page.locator('#mutasi');
	const mandiri = pdfFile('mutasi-mandiri-fiktif.pdf', mandiriPdf(MANDIRI_AUGUST));
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(mandiri);
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	await expect(section.getByRole('alert')).toContainText('Berkas ini berisi beberapa rekening.');
	const accounts = section.getByRole('group', { name: 'Rekening dalam berkas ini' });
	await expect(accounts.getByRole('radio')).toHaveCount(2);
	// A plain post clears the file input: the file is chosen again with the account.
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(mandiri);
	await accounts.getByLabel(/Giro Fiktif ••6667/).check();
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	const result = section.getByRole('status').filter({ hasText: 'Mandiri ·' });
	await expect(result).toContainText('Rekening: Giro Fiktif ••6667');
	await expect(result).toContainText('Siap diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(accounts.getByLabel(/Giro Fiktif ••6667/)).toBeChecked();
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(mandiri);
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(result).toContainText('Rekening: Giro Fiktif ••6667');
	await context.close();
});

test('statement upload: an OCBC consolidated statement is detected, reconciled and imported once', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'OCBC');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await chooseSource(page, 'Mutasi bank');
	const section = page.locator('#mutasi');
	await expect(section.getByText('Didukung: BCA, BNI, Mandiri, OCBC')).toBeVisible();
	const ocbc = pdfFile('mutasi-ocbc-fiktif.pdf', ocbcPdf(OCBC_JULY));
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(ocbc);
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	await expect(section.getByRole('alert')).toContainText('Berkas ini berisi beberapa rekening.');
	const accounts = section.getByRole('group', { name: 'Rekening dalam berkas ini' });
	await expect(accounts.getByRole('radio')).toHaveCount(3);
	// The USD sub-account is listed but cannot be picked.
	await expect(accounts.getByRole('radio', { disabled: true })).toHaveCount(1);
	await accounts.getByLabel(/Giro Fiktif ••0999/).check();
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	const result = section.getByRole('status').filter({ hasText: 'OCBC ·' });
	await expect(result).toContainText('Rekening: Giro Fiktif ••0999');
	await expect(result).toContainText('Siap diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(result).toContainText('Saldo cocok');
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 2 · Dilewati 0 · Sudah pernah diimpor 0');
	// The same file and account again: every row is recognised as already imported.
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(ocbc);
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	await accounts.getByLabel(/Giro Fiktif ••0999/).check();
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 0 · Dilewati 0 · Sudah pernah diimpor 2');
	await expectNoHorizontalScroll(page);
	await context.close();
});

// FN-48 Part B: a statement's printed Saldo Awal (Rp 1.000.000,00) does not connect with a brand-new BCA
// wallet's own balance (Rp 0): the preview names the gap, the rows still import, and "Catat selisihnya" on
// /impor's "Kesinambungan saldo" card closes it with one balance adjustment the wallet then matches.
test('statement upload: a continuity gap is named, rows still import, and "Catat selisihnya" closes it', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA', '0');
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	await chooseSource(page, 'Mutasi bank');
	const section = page.locator('#mutasi');
	const bca = pdfFile('mutasi-bca-fiktif.pdf', bcaPdf(BCA_SEPTEMBER));
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bca);
	await section.getByRole('button', { name: 'Pratinjau' }).click();
	const result = section.getByRole('status').filter({ hasText: 'BCA ·' });
	await expect(result).toContainText('Rp 1.000.000');
	await expect(result).toContainText('Rp 0');
	await expect(result).toContainText('Impor tetap bisa dilanjutkan.');

	await page.getByLabel('Pilih berkas mutasi').setInputFiles(bca);
	await section.getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(result).toContainText('Diimpor 7 · Dilewati 0 · Sudah pernah diimpor 0');
	await expect(result).toContainText('Baris mutasi tetap diimpor.');

	await page.goto(`${BASE}/impor`);
	const continuity = page.locator('#kesinambungan');
	await expect(continuity.getByText('Ada selisih')).toBeVisible();
	await continuity.getByText('Catat selisihnya').click();
	await continuity.getByRole('button', { name: 'Ya, catat penyesuaian' }).click();
	await expect(page.getByText('Penyesuaian saldo dicatat.')).toBeVisible();
	await expect(continuity).toHaveCount(0);

	// The wallet now shows the statement's own printed Saldo Akhir (1,000,000 + 2,501,234.56 − 285,747.41).
	await page.goto(`${BASE}/dompet`);
	await expect(page.getByText(/Rp\s?3\.215\.487/).first()).toBeVisible();
	await expectNoHorizontalScroll(page);
	await context.close();
});

// Same journey without JavaScript: the "Kesinambungan saldo" card's confirm <details>/<form> is a plain POST.
test('without JavaScript: "Catat selisihnya" closes a continuity gap as a plain form post', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await addWallet(page, 'BCA', '0');
	await page.goto(`${BASE}/impor`);
	await chooseSource(page, 'Mutasi bank');
	await page
		.getByLabel('Pilih berkas mutasi')
		.setInputFiles(pdfFile('mutasi-bca-fiktif.pdf', bcaPdf(BCA_SEPTEMBER)));
	await page.locator('#mutasi').getByRole('button', { name: 'Impor', exact: true }).click();
	await page.goto(`${BASE}/impor`);
	const continuity = page.locator('#kesinambungan');
	await expect(continuity.getByText('Ada selisih')).toBeVisible();
	// <details>/<summary> opens without JavaScript; the confirm form inside posts as a plain form.
	await continuity.getByText('Catat selisihnya').click();
	await continuity.getByRole('button', { name: 'Ya, catat penyesuaian' }).click();
	await expect(page.getByText('Penyesuaian saldo dicatat.')).toBeVisible();
	await context.close();
});

test('without JavaScript: a statement refusal shows from the plain form post', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto(`${BASE}/impor`);
	await chooseSource(page, 'Mutasi bank');
	// FN-16i: the plain select offers only what can be read; an unsupported bank can never be posted.
	await expect(page.locator('#mutasi select[name="institution"] option')).toHaveText([
		'Deteksi otomatis',
		'BCA',
		'Mandiri',
		'BNI',
		'OCBC'
	]);
	await page.getByLabel('Pilih berkas mutasi').setInputFiles(SCANNED);
	await page.locator('#mutasi').getByRole('button', { name: 'Impor', exact: true }).click();
	await expect(page.locator('#mutasi').getByRole('alert')).toContainText(
		'PDF ini berupa gambar (hasil pindai).'
	);
	await context.close();
});

// FN-16i: the Impor layout. One wallet picker above the format switch, the honest institution list, the card order.
const ORDER_PHONE = [
	'Impor berkas',
	'Riwayat impor',
	'Cara lain memasukkan data',
	'Pekerjaan membaca terbaru',
	'Ekspor CSV'
];

/** The page's card headings, top to bottom as drawn. */
async function headingsByPosition(page: Page) {
	const cards = page.locator('main h2').filter({ visible: true });
	const list: { text: string; y: number; x: number }[] = [];
	for (const heading of await cards.all()) {
		const box = (await heading.boundingBox())!;
		list.push({ text: (await heading.innerText()).trim(), y: box.y, x: box.x });
	}
	return list;
}

for (const colorScheme of ['light', 'dark'] as const) {
	test(`Impor layout at 360 px: card order, one shared wallet picker with brand badges, honest institutions (${colorScheme})`, async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, {
			viewport: { width: 360, height: 780 }
		});
		await page.emulateMedia({ colorScheme });
		await addWallet(page, 'BCA');
		await addWallet(page, 'Tunai');
		await page.goto(`${BASE}/impor`);
		await waitForHydration(page);
		await expect(
			page.getByText('Berkas dibaca dulu, lalu hasilnya kamu periksa sebelum disimpan.')
		).toBeVisible();
		await expect(page.getByText('Pilih dompet tujuan dulu, lalu berkasnya.')).toBeVisible();
		const order = (await headingsByPosition(page)).sort((a, b) => a.y - b.y).map((h) => h.text);
		expect(order).toEqual(ORDER_PHONE);

		// One wallet picker for every format, with the FN-43 badge on a brand-named wallet only.
		const walletButton = page.getByRole('button', { name: 'BCA', exact: true });
		await expect(walletButton).toHaveCount(1);
		expect((await walletButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		await walletButton.click();
		const wallets = page.getByRole('dialog', { name: 'Dompet untuk baris tanpa dompet' });
		await expect(wallets.getByRole('radio', { name: /BCA/ }).locator('.b-bca')).toHaveCount(1);
		await expect(wallets.getByRole('radio', { name: /Tunai/ }).locator('.tile')).toHaveCount(0);
		await wallets.getByRole('radio', { name: /Tunai/ }).click();
		await expect(wallets).toBeHidden();
		const csvWallet = await page.locator('#csv input[name="defaultWalletId"]').inputValue();

		// Switching format keeps the choice: the statement form posts the same wallet.
		await chooseSource(page, 'Mutasi bank');
		const importCard = page.locator('section').filter({
			has: page.getByRole('heading', { level: 2, name: 'Impor berkas' })
		});
		await expect(importCard.getByText('Dompet tujuan', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Tunai', exact: true })).toHaveCount(1);
		await expect(page.locator('#mutasi input[name="defaultWalletId"]')).toHaveValue(csvWallet);

		// Every FN-04 institution is listed; only the readable ones can be chosen.
		await page.getByRole('button', { name: 'Pilih institusi' }).click();
		const institutions = page.getByRole('dialog', { name: 'Pilih institusi' });
		const enabled = institutions.locator('[role="radio"]:not([aria-disabled="true"])');
		await expect(enabled).toHaveText([/Deteksi otomatis/, /BCA/, /Mandiri/, /BNI/, /OCBC/]);
		const disabled = institutions.locator('[role="radio"][aria-disabled="true"]');
		await expect(disabled).toHaveCount(12);
		await expect(institutions.getByRole('radio', { disabled: true })).toHaveCount(12);
		const bri = disabled.filter({ hasText: 'BRI' });
		await expect(bri).toContainText('pakai Foto (tangkapan layar BRImo) atau CSV/Spreadsheet');
		await expect(bri.locator('.b-bri')).toHaveCount(1);
		await expect(disabled.filter({ hasText: 'GoPay' })).toContainText(
			'pakai Foto (tangkapan layar aplikasi)'
		);
		await expect(disabled.filter({ hasText: 'Lainnya' })).toContainText(
			'belum didukung — pakai CSV atau Spreadsheet, atau nanti AI dengan kuncimu sendiri'
		);
		// A tap on a disabled row does nothing: the sheet stays, nothing is chosen.
		await bri.click({ force: true });
		await expect(institutions).toBeVisible();
		await expect(bri).toHaveAttribute('aria-checked', 'false');
		// The keyboard never lands on a disabled row.
		await institutions.getByRole('radio', { name: /OCBC/ }).focus();
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('Tab');
			expect(
				await page.evaluate(() => document.activeElement?.getAttribute('aria-disabled'))
			).toBeNull();
		}
		await institutions.getByRole('radio', { name: /Mandiri/ }).click();
		await expect(institutions).toBeHidden();
		await expect(page.locator('#mutasi input[name="institution"]')).toHaveValue('mandiri');
		// FN-16h: the OCBC password hint is unchanged.
		await expect(page.locator('#mutasi').getByLabel('Sandi PDF (jika ada)')).toBeVisible();

		// Other ways in: scanning a receipt is a real link, the phone shortcut says it is not here yet.
		const other = page.locator('section').filter({
			has: page.getByRole('heading', { name: 'Cara lain memasukkan data' })
		});
		await expect(other.getByRole('listitem')).toHaveCount(4);
		await expect(other.getByRole('link')).toHaveCount(3);
		const struk = other.getByRole('link', { name: /Pindai struk/ });
		await expect(struk).toHaveAttribute('href', '/riwayat/struk');
		expect((await struk.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		const shortcut = other.getByRole('listitem').filter({ hasText: 'Pintasan' });
		await expect(shortcut).toContainText('Segera hadir');
		await expect(shortcut.getByRole('link')).toHaveCount(0);
		await expectNoHorizontalScroll(page);
		await page.screenshot({
			path: testInfo.outputPath(`impor-layout-360-${colorScheme}.png`),
			fullPage: true
		});
		await context.close();
	});
}

test('Impor layout at 1280 px: two columns, import then history then export, other ways then reading jobs', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, {
		viewport: { width: 1280, height: 900 }
	});
	await page.goto(`${BASE}/impor`);
	await waitForHydration(page);
	const headings = await headingsByPosition(page);
	// The right column starts well right of every left card's heading.
	const splitX = headings.find((h) => h.text === 'Cara lain memasukkan data')!.x - 40;
	expect(headings.find((h) => h.text === 'Impor berkas')!.x).toBeLessThan(splitX);
	const column = (side: 'left' | 'right') =>
		headings
			.filter((h) => (side === 'left' ? h.x < splitX : h.x >= splitX))
			.sort((a, b) => a.y - b.y)
			.map((h) => h.text);
	expect(column('left')).toEqual(['Impor berkas', 'Riwayat impor', 'Ekspor CSV']);
	expect(column('right')).toEqual(['Cara lain memasukkan data', 'Pekerjaan membaca terbaru']);
	// No wallet yet: the shared picker says why instead of a dead button.
	await expect(
		page.getByText('Belum ada dompet IDR. Baris tanpa dompet akan dilewati.')
	).toBeVisible();
	await context.close();
});
