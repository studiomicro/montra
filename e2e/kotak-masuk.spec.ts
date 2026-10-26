import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	expectNoHorizontalScroll,
	newUser,
	type UserOptions,
	waitForHydration
} from './helpers';
import { addWallet } from './ledger';

/**
 * FN-11 journeys. Every test signs up its own fictional user in its own context (own simulated client address),
 * so its personal space starts empty. Drafts come from the dev-only seed action (the e2e server runs with
 * DEV_ROUTES=1); a wallet is added through the app's own form action, never straight into D1.
 */

const freshUser = (browser: Browser, testInfo: TestInfo, opts: UserOptions = {}) =>
	newUser(browser, testInfo, { prefix: 'fn11', name: 'Peninjau', ...opts });

async function openInboxWithDemo(page: Page) {
	await page.goto(`${APP_ORIGIN}/kotak-masuk`);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Kotak masuk' })).toBeVisible();
	await expect(page.getByText('Tidak ada draf yang menunggu.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Periksa draf' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Tambah draf contoh' }).click();
	await expect(page.getByText('4 draf contoh ditambahkan.')).toBeVisible();
	await expect(page.getByText('4 draf menunggu')).toBeVisible();
}

test('seeded drafts: badges, mixed-kind refusal, bulk category and wallet, then Simpan', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	await openInboxWithDemo(page);
	await expect(page.getByText('Data demo')).toHaveCount(4);
	await expect(page.getByText('Mungkin duplikat')).toHaveCount(1);
	await expect(page.getByText('Perlu dilengkapi')).toHaveCount(3);
	await expect(page.getByText('Hari ini')).toBeVisible();
	await expect(page.getByText('Kemarin')).toBeVisible();
	await expectNoHorizontalScroll(page);

	await page.getByRole('link', { name: 'Periksa draf' }).click();
	await page.waitForURL(`${APP_ORIGIN}/kotak-masuk/periksa`);
	await waitForHydration(page);
	await expect(page.getByText('4 dipilih')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Simpan 4 transaksi' })).toBeEnabled();
	await expectNoHorizontalScroll(page);

	// Mixed expense + income: refused, no sheet (owner decision A).
	await page.getByRole('button', { name: 'Atur kategori' }).click();
	await expect(
		page.getByText('Pilih draf dengan jenis yang sama untuk mengatur kategori sekaligus')
	).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// Only the expenses: one category for all of them.
	await page.getByRole('checkbox', { name: /Honor proyek desain/ }).uncheck();
	await expect(page.getByText('3 dipilih')).toBeVisible();
	const opener = page.getByRole('button', { name: 'Atur kategori' });
	await opener.click();
	const sheet = page.getByRole('dialog', { name: 'Atur kategori' });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByText('Gaji')).toHaveCount(0); // income categories are not offered
	await sheet.getByText('Belanja Harian').click();
	await sheet.getByRole('button', { name: 'Terapkan ke 3 draf' }).click();
	await expect(page.getByText('3 draf diperbarui.')).toBeVisible();
	await expect(sheet).toBeHidden();
	await expect(opener).toBeFocused();

	// Every draft gets the wallet, whatever its type.
	await page.getByRole('button', { name: 'Pilih semua' }).click();
	await expect(page.getByText('4 dipilih')).toBeVisible();
	await page.getByRole('button', { name: 'Atur dompet' }).click();
	const wallets = page.getByRole('dialog', { name: 'Atur dompet' });
	await wallets.getByText('BCA').click();
	await wallets.getByRole('button', { name: 'Terapkan ke 4 draf' }).click();
	await expect(page.getByText('4 draf diperbarui.')).toBeVisible();

	// The income draft still has no category: it stays, the three others save (owner decision B).
	await page.getByRole('button', { name: 'Simpan 4 transaksi' }).click();
	await page.waitForURL(`${APP_ORIGIN}/kotak-masuk`);
	await expect(page.getByText('Disimpan 3 dari 4 transaksi · 1 belum lengkap')).toBeVisible();
	await expect(page.getByText('1 draf menunggu')).toBeVisible();

	await page.goto(`${APP_ORIGIN}/riwayat`);
	await expect(page.getByText('Kedai Kopi Senja').first()).toBeVisible();
	await expect(page.getByText('Toko Serba Ada')).toBeVisible();
	await context.close();
});

test('Abaikan asks to confirm, then the draft is gone after the server confirms', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openInboxWithDemo(page);
	const row = page.getByRole('listitem').filter({ hasText: 'Toko Serba Ada' });
	await row.getByText('Abaikan', { exact: true }).click();
	await expect(row.getByText('Draf yang diabaikan tidak bisa dikembalikan.')).toBeVisible();
	await row.getByRole('button', { name: 'Ya, abaikan' }).click();
	await expect(page.getByText('Draf diabaikan.')).toBeVisible();
	await expect(page.getByText('3 draf menunggu')).toBeVisible();
	await expect(page.getByText('Toko Serba Ada')).toHaveCount(0);
	await page.getByRole('button', { name: 'Kosongkan draf contoh' }).click();
	await expect(page.getByText('3 draf contoh dikosongkan.')).toBeVisible();
	await expect(page.getByText('Tidak ada draf yang menunggu.')).toBeVisible();
	await context.close();
});

test('without JavaScript: refusals and the save summary show after plain form posts', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await addWallet(page, 'BCA');
	await page.goto(`${APP_ORIGIN}/kotak-masuk`);
	await page.getByRole('button', { name: 'Tambah draf contoh' }).click();
	await expect(page.getByText('4 draf menunggu')).toBeVisible();
	await page.getByRole('link', { name: 'Periksa draf' }).click();
	await expect(page.getByText('4 dipilih')).toBeVisible();

	// The inline category picker with every draft checked: refused as a mixed selection.
	await page.locator('summary', { hasText: 'Atur kategori' }).click();
	await page.getByRole('radio', { name: /^Kopi/ }).check();
	await page.getByRole('button', { name: 'Terapkan kategori' }).click();
	await expect(
		page.getByText('Pilih draf dengan jenis yang sama untuk mengatur kategori sekaligus')
	).toBeVisible();

	await page.getByRole('button', { name: 'Simpan 4 transaksi' }).click();
	await expect(page).toHaveURL(`${APP_ORIGIN}/kotak-masuk`);
	await expect(page.getByText('Disimpan 1 dari 4 transaksi · 3 belum lengkap')).toBeVisible();
	await expect(page.getByText('3 draf menunggu')).toBeVisible();
	await context.close();
});
