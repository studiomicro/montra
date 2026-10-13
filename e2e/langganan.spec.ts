import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	tickSignUpBoxes,
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration
} from './helpers';

/**
 * FN-26 journeys. Every test signs up its own fictional user in its own context (own simulated client address),
 * so its personal space starts without subscriptions or wallets and parallel tests never see each other's rows.
 */
const BASE = APP_ORIGIN;
const PASSWORD = 'terang-benderang-8';

async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: { javaScriptEnabled?: boolean } = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) },
		...opts
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pelanggan');
	await page
		.getByLabel('E-mail')
		.fill(`fn26-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	return { context, page };
}

async function open(page: Page, path = '/langganan') {
	await page.goto(path);
	await waitForHydration(page);
}

const row = (page: Page, name: string) =>
	page.locator('main').getByRole('listitem').filter({ hasText: name });

async function addWallet(page: Page, name = 'BCA') {
	await open(page, '/dompet');
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah dompet' });
	await sheet.getByLabel('Nama dompet').fill(name);
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();
}

/** Adds a catalogue subscription through the sheets; resolves once the server-confirmed row is listed. */
async function addFromCatalogue(page: Page, service: string, amount: string) {
	await page.getByRole('link', { name: 'Tambah langganan' }).first().click();
	const picker = page.getByRole('dialog', { name: 'Pilih layanan' });
	await expect(picker).toBeVisible();
	await picker.getByRole('link', { name: service, exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Tambah langganan' });
	await expect(sheet.getByLabel('Nama langganan')).toHaveValue(service);
	await sheet.getByLabel('Biaya per tagihan').fill(amount);
	await sheet.getByRole('button', { name: 'Tambah langganan' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Langganan ditambahkan.')).toBeVisible();
}

test('catalogue add → initials tile, ≈ monthly total, kept on reload → mark paid records one expense', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	await addWallet(page);
	await open(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Langganan' })).toBeVisible();
	await expect(
		page.getByText('Belum ada langganan. Catat tagihan rutin supaya tidak kelewatan.')
	).toBeVisible();

	await addFromCatalogue(page, 'Netflix', '186000');
	const netflix = row(page, 'Netflix');
	await expect(netflix).toContainText('Rp 186.000');
	await expect(netflix).toContainText('Bulanan');
	// Generated initials, never an image.
	await expect(netflix.locator('.tile')).toHaveText('NE');
	await expect(netflix.locator('img')).toHaveCount(0);
	await expect(page.getByText('≈ Rp 186.000')).toBeVisible();

	await page.reload();
	await expect(row(page, 'Netflix')).toContainText('Rp 186.000');
	await expectNoHorizontalScroll(page);
	// A row is at most two lines (name and amount, schedule and due date), also at 360 px.
	const body = row(page, 'Netflix').locator('.body');
	expect((await body.boundingBox())!.height).toBeLessThanOrEqual(50);
	await expect(body.locator('.meta')).toHaveText(/Bulanan · tgl \d+/);

	await row(page, 'Netflix').getByRole('link', { name: 'Tandai Netflix sudah dibayar' }).click();
	const pay = page.getByRole('dialog', { name: 'Tandai sudah dibayar' });
	await expect(pay.getByLabel('Dompet')).toHaveValue(/.+/);
	await pay.getByRole('button', { name: 'Tandai sudah dibayar' }).click();
	await expect(pay).toBeHidden();
	await expect(
		page.getByText('Dicatat sudah dibayar. Tagihan berikutnya sudah diperbarui.')
	).toBeVisible();
	// The row stays two lines; the last payment is shown in the subscription's edit sheet.
	await row(page, 'Netflix').getByRole('link', { name: /Ubah/ }).click();
	const edit = page.getByRole('dialog', { name: 'Ubah langganan' });
	await expect(edit.getByText(/^Terakhir dibayar /)).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(edit).toBeHidden();

	await page.goto('/riwayat');
	await expect(page.locator('main').getByText('Netflix')).toHaveCount(1);
	await expectNoHorizontalScroll(page);
	expect(csp).toEqual([]);
	await context.close();
});

test('a typed weekly bill; a second tab’s stale edit is refused with "changed meanwhile"', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await open(page);
	await page.getByRole('link', { name: 'Tambah langganan' }).first().click();
	await page
		.getByRole('dialog', { name: 'Pilih layanan' })
		.getByRole('link', { name: 'Lainnya: ketik nama sendiri' })
		.click();
	const sheet = page.getByRole('dialog', { name: 'Tambah langganan' });
	await sheet.getByLabel('Nama langganan').fill('Laundry Kiloan');
	await sheet.getByLabel('Biaya per tagihan').fill('50000');
	await sheet.getByRole('radio', { name: 'Mingguan' }).check({ force: true });
	await sheet.getByLabel('Hari tagihan').selectOption({ label: 'Jumat' });
	await expect(sheet.getByLabel('Tanggal tagihan')).toHaveCount(0);
	await sheet.getByRole('button', { name: 'Tambah langganan' }).click();
	await expect(sheet).toBeHidden();
	await expect(row(page, 'Laundry Kiloan')).toContainText('Mingguan · Jumat');
	await expect(row(page, 'Laundry Kiloan').locator('.tile')).toHaveText('LK');
	// 50.000 × 52 ÷ 12 = 216.666,66… → floored.
	await expect(page.getByText('≈ Rp 216.666,66')).toBeVisible();

	const second = await context.newPage();
	await open(second);
	await row(page, 'Laundry Kiloan').getByRole('link', { name: /Ubah/ }).click();
	const edit = page.getByRole('dialog', { name: 'Ubah langganan' });
	await edit.getByLabel('Biaya per tagihan').fill('60000');
	await edit.getByRole('button', { name: 'Simpan perubahan' }).click();
	await expect(edit).toBeHidden();
	await expect(row(page, 'Laundry Kiloan')).toContainText('Rp 60.000');

	await row(second, 'Laundry Kiloan').getByRole('link', { name: /Ubah/ }).click();
	const stale = second.getByRole('dialog', { name: 'Ubah langganan' });
	await stale.getByLabel('Biaya per tagihan').fill('1000');
	await stale.getByRole('button', { name: 'Simpan perubahan' }).click();
	await expect(
		stale.getByText('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.')
	).toBeVisible();
	await second.reload();
	await expect(row(second, 'Laundry Kiloan')).toContainText('Rp 60.000');
	await context.close();
});

test('works without JavaScript: picker, refusal and save are plain form posts', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/langganan');
	await page.getByRole('link', { name: 'Tambah langganan' }).first().click();
	await expect(page).toHaveURL(`${BASE}/langganan?tambah=1`);
	await page.getByRole('link', { name: 'Spotify', exact: true }).click();
	await expect(page).toHaveURL(`${BASE}/langganan?tambah=spotify`);
	await expect(page.getByLabel('Nama langganan')).toHaveValue('Spotify');
	await page.getByRole('button', { name: 'Tambah langganan' }).click();
	await expect(
		page.getByText('Isi biaya lebih dari 0 dengan angka bulat, tanpa sen.')
	).toBeVisible();
	await page.getByLabel('Biaya per tagihan').fill('54990');
	await page.getByLabel('Tanggal tagihan (Bulanan dan Tahunan)').selectOption('31');
	await page.getByRole('button', { name: 'Tambah langganan' }).click();
	await expect(page.getByRole('status')).toHaveText('Langganan ditambahkan.');
	await expect(row(page, 'Spotify')).toContainText('Rp 54.990');
	await expect(row(page, 'Spotify')).toContainText('Bulanan · tgl 31');
	await context.close();
});

test('FN-39: a direct no-JavaScript link to a new catalogue entry prefills the inline form', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/langganan?tambah=gopay-plus');
	await expect(page.getByLabel('Nama langganan')).toHaveValue('GoPay Plus');
	await page.getByLabel('Biaya per tagihan').fill('19000');
	await page.getByLabel('Tanggal tagihan (Bulanan dan Tahunan)').selectOption('1');
	await page.getByRole('button', { name: 'Tambah langganan' }).click();
	await expect(page.getByText('Langganan ditambahkan.')).toBeVisible();
	await expect(row(page, 'GoPay Plus')).toContainText('Rp 19.000');
	await context.close();
});

test('hiding Langganan (FN-12) removes its entries; the page still loads with a way back', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const nav = page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });
	if (!isPhone(page)) await expect(nav.getByRole('link', { name: 'Langganan' })).toHaveCount(1);

	await open(page, '/pengaturan/fitur');
	await page.getByRole('switch', { name: 'Langganan' }).click();
	await expect(page.getByRole('status')).toHaveText('Perubahan disimpan.');
	await expect(nav.getByRole('link', { name: 'Langganan' })).toHaveCount(0);

	await open(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Langganan' })).toBeVisible();
	await expect(
		page.getByText('Langganan disembunyikan dari menu. Angkanya tetap dihitung.')
	).toBeVisible();
	await page.getByRole('link', { name: 'Tampilkan lagi di menu' }).click();
	await expect(page).toHaveURL(`${BASE}/pengaturan/fitur`);
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('the "Tagihan langganan" reminder switch (FN-24) is on by default and stays off once turned off', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await open(page, '/pengaturan/notifikasi');
	const bills = page.getByRole('switch', { name: 'Tagihan langganan' });
	await expect(bills).toBeChecked();
	await bills.click();
	await expect(page.getByRole('switch', { name: 'Tagihan langganan' })).not.toBeChecked();
	await expect(page.getByRole('switch', { name: 'Tagihan langganan' })).toBeEnabled();
	await page.reload();
	await expect(page.getByRole('switch', { name: 'Tagihan langganan' })).not.toBeChecked();
	await context.close();
});

test('360 px: a long name wraps to a second line instead of being cut (UI polish)', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.setViewportSize({ width: 360, height: 780 });
	await open(page);
	await page.getByRole('link', { name: 'Tambah langganan' }).first().click();
	await page
		.getByRole('dialog', { name: 'Pilih layanan' })
		.getByRole('link', { name: 'Lainnya: ketik nama sendiri' })
		.click();
	const sheet = page.getByRole('dialog', { name: 'Tambah langganan' });
	const long = 'Asuransi Kesehatan Keluarga Premium';
	await sheet.getByLabel('Nama langganan').fill(long);
	await sheet.getByLabel('Biaya per tagihan').fill('1250000');
	await sheet.getByRole('button', { name: 'Tambah langganan' }).click();
	await expect(sheet).toBeHidden();
	const name = row(page, long).locator('.name');
	await expect(name).toHaveText(long);
	// Nothing is hidden: the whole name fits its box (two lines at most), no ellipsis.
	const fit = await name.evaluate((e) => ({
		cut: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1,
		lines: Math.round(
			e.clientHeight /
				(parseFloat(getComputedStyle(e).lineHeight) ||
					parseFloat(getComputedStyle(e).fontSize) * 1.2)
		)
	}));
	expect(fit.cut).toBe(false);
	expect(fit.lines).toBeLessThanOrEqual(2);
	await expectNoHorizontalScroll(page);
	await context.close();
});

/** FN-26b: one expense recorded through /riwayat/baru (the user's own stored row; never seeded). */
async function recordExpense(page: Page, amount: string, title: string) {
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await page.getByLabel('Jumlah').fill(amount);
	await page.getByRole('radio', { name: /Kopi/ }).check();
	await page.getByLabel('Judul (opsional)').fill(title);
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();
	await page.waitForURL(/\/riwayat\?saved=created/);
}

test('FN-26b subscription check at 360 px: candidates from recorded expenses → add prefilled → dismiss', async ({
	browser
}, testInfo) => {
	// Sign-up, a wallet and two recorded expenses before the check itself.
	test.setTimeout(120_000);
	const { context, page } = await freshUser(browser, testInfo);
	await page.setViewportSize({ width: 360, height: 780 });
	const csp = collectCspViolations(page);
	await open(page);
	const card = page.locator('main section.check');
	await expect(card).toContainText('Pemeriksaan langganan');
	await expect(card).toContainText('Belum ditemukan langganan baru');
	await expect(card.getByRole('link', { name: 'Jalankan pemeriksaan' })).toHaveCount(0);
	await expect(
		page.getByText('Streaming, musik, paket data, internet, listrik', { exact: false })
	).toBeVisible();

	await addWallet(page);
	await recordExpense(page, '186000', 'NETFLIX.COM');
	await recordExpense(page, '54990', 'Spotify');
	await open(page);
	await expect(card).toContainText('Ditemukan 2 kemungkinan langganan yang belum ada di daftar');
	await expect(card.locator('.badges li')).toHaveCount(2);
	await expect(card.locator('img')).toHaveCount(0);
	await expectNoHorizontalScroll(page);

	await card.getByRole('link', { name: 'Jalankan pemeriksaan' }).click();
	const check = page.getByRole('dialog', { name: 'Kemungkinan langganan' });
	const netflix = check.getByRole('listitem').filter({ hasText: 'Netflix' }).first();
	await expect(netflix).toContainText('Rp 186.000');
	await expect(netflix).toContainText('Bulanan (perkiraan)');
	await netflix.getByText('1 transaksi terkait').click();
	await expect(netflix).toContainText('NETFLIX.COM');
	await expectNoHorizontalScroll(page);

	// Tambah: the existing add form, filled from the candidate; nothing is saved before submitting.
	await netflix.getByRole('link', { name: 'Tambah' }).click();
	const add = page.getByRole('dialog', { name: 'Tambah langganan' });
	await expect(add.getByLabel('Nama langganan')).toHaveValue('Netflix');
	await expect(add.getByLabel('Biaya per tagihan')).toHaveValue('186.000');
	await add.getByRole('button', { name: 'Tambah langganan' }).click();
	await expect(add).toBeHidden();
	await expect(page.getByText('Langganan ditambahkan.')).toBeVisible();
	await expect(card).toContainText('Ditemukan 1 kemungkinan langganan yang belum ada di daftar');

	// Bukan langganan: asked once, shown only after the server confirmed, never offered again.
	await card.getByRole('link', { name: 'Jalankan pemeriksaan' }).click();
	const spotify = check.getByRole('listitem').filter({ hasText: 'Spotify' }).first();
	await spotify.getByText('Bukan langganan', { exact: true }).click();
	await spotify.getByRole('button', { name: 'Ya, bukan langganan' }).click();
	await expect(
		check.getByText('Ditandai bukan langganan. Tidak akan ditawarkan lagi.')
	).toBeVisible();
	await expect(check.getByText('Belum ditemukan langganan baru')).toBeVisible();
	await page.keyboard.press('Escape');
	await page.reload();
	await expect(card).toContainText('Belum ditemukan langganan baru');

	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(card).toBeVisible();
	await expectNoHorizontalScroll(page);
	expect(csp).toEqual([]);
	await context.close();
});

test('FN-26b without JavaScript: the check list and "Bukan langganan" are plain links and form posts', async ({
	browser
}, testInfo) => {
	test.setTimeout(120_000);
	const js = await freshUser(browser, testInfo);
	await addWallet(js.page);
	await recordExpense(js.page, '54990', 'Spotify');
	const state = await js.context.storageState();
	await js.context.close();
	const context = await browser.newContext({
		storageState: state,
		javaScriptEnabled: false,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
	});
	const page = await context.newPage();
	await page.goto('/langganan');
	await page.getByRole('link', { name: 'Jalankan pemeriksaan' }).click();
	await expect(page).toHaveURL(`${BASE}/langganan?periksa=1`);
	const spotify = page.getByRole('listitem').filter({ hasText: 'Rp 54.990' }).first();
	await spotify.getByRole('link', { name: 'Tambah' }).click();
	await expect(page).toHaveURL(`${BASE}/langganan?kandidat=cat%3Aspotify`);
	await expect(page.getByLabel('Nama langganan')).toHaveValue('Spotify');
	await page.goto('/langganan?periksa=1');
	await spotify.getByText('Bukan langganan', { exact: true }).click();
	await spotify.getByRole('button', { name: 'Ya, bukan langganan' }).click();
	await expect(page.getByRole('status')).toHaveText(
		'Ditandai bukan langganan. Tidak akan ditawarkan lagi.'
	);
	await expect(page.locator('main section.check')).toContainText('Belum ditemukan langganan baru');
	await context.close();
});
