import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	tickSignUpBoxes,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration,
	APP_ORIGIN
} from './helpers';

/**
 * FN-04 journeys. Every test signs up its own fictional user in its own context (own simulated client address),
 * so its personal space starts with no wallets and parallel tests never see each other's wallets.
 */
const BASE = APP_ORIGIN;
const PASSWORD = 'terang-benderang-8';

async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: {
		javaScriptEnabled?: boolean;
		colorScheme?: 'light' | 'dark';
		viewport?: { width: number; height: number };
	} = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) },
		...opts
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pemilik Dompet');
	await page
		.getByLabel('E-mail')
		.fill(`fn04-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	return { context, page };
}

async function openDompet(page: Page) {
	await page.goto('/dompet');
	await waitForHydration(page);
}

/** Adds a wallet through the sheet; resolves once the server-confirmed row is listed. */
async function addWallet(
	page: Page,
	w: { name: string; type?: string; balance?: string; lastFour?: string; favourite?: boolean }
) {
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah dompet' });
	await expect(sheet).toBeVisible();
	await sheet.getByLabel('Nama dompet').fill(w.name);
	await sheet.getByRole('radio', { name: w.type ?? 'Bank' }).check();
	if (w.balance) await sheet.getByLabel('Saldo awal').fill(w.balance);
	if (w.lastFour) await sheet.getByLabel('4 angka terakhir (opsional)').fill(w.lastFour);
	if (w.favourite) await sheet.getByLabel('Jadikan favorit').check();
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();
}

const row = (page: Page, name: string) =>
	page.locator('main').getByRole('listitem').filter({ hasText: name });

test('first wallet: empty state → add in the sheet → listed, focus back on the opener, kept on reload', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openDompet(page);
	await expect(page.getByText('Belum ada dompet. Tambah satu untuk mulai mencatat.')).toBeVisible();
	await expect(page.locator('main')).not.toContainText('Rp');

	const opener = page.getByRole('link', { name: 'Tambah dompet' }).first();
	await opener.click();
	const sheet = page.getByRole('dialog', { name: 'Tambah dompet' });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByText('Dompet pertama otomatis jadi favorit.')).toBeVisible();
	await sheet.getByLabel('Nama dompet').fill('BCA Tabungan');
	await sheet.getByRole('radio', { name: 'Bank' }).check();
	await sheet.getByLabel('Saldo awal').fill('1250000');
	await expect(sheet.getByLabel('Saldo awal')).toHaveValue('1.250.000');
	await sheet.getByLabel('4 angka terakhir (opsional)').fill('4111111111111111');
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	// Refused (never truncated); the sheet stays open with the field error.
	await expect(
		sheet.getByText('Isi tepat 4 angka terakhir saja, bukan nomor lengkap.')
	).toBeVisible();
	await expect(sheet.getByLabel('4 angka terakhir (opsional)')).toHaveValue('');
	await sheet.getByLabel('4 angka terakhir (opsional)').fill('1234');
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(sheet).toBeHidden();

	const wallet = row(page, 'BCA Tabungan');
	await expect(wallet).toContainText('•••• 1234');
	await expect(wallet).toContainText('Rp 1.250.000');
	await expect(wallet.getByText('Favorit')).toBeAttached();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();

	await page.reload();
	await expect(row(page, 'BCA Tabungan')).toContainText('Rp 1.250.000');
	await context.close();
});

test('FN-58 pass 1: add an e-money card (issuer required), see "Kartu e-money · issuer"; a quick pick fills it', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openDompet(page);
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah dompet' });
	await sheet.getByLabel('Nama dompet').fill('Kartu Kereta');
	await sheet.getByRole('radio', { name: 'Kartu e-money' }).check();
	await sheet.getByLabel('Saldo awal').fill('75000');
	await sheet.getByLabel('4 angka terakhir (opsional)').fill('0042');
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	// No issuer: refused by the server, the sheet stays open.
	await expect(sheet.getByText('Pilih penerbit kartu e-money.')).toBeVisible();
	await sheet.getByLabel('Penerbit kartu').selectOption({ label: 'KMT (KAI Commuter)' });
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(sheet).toBeHidden();
	const card = row(page, 'Kartu Kereta');
	await expect(card).toContainText('Kartu e-money · KMT (KAI Commuter)');
	await expect(card).toContainText('•••• 0042');
	await expect(card).toContainText('Rp 75.000');

	// A quick pick fills the name, the choice and the issuer in place.
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	await sheet.getByRole('link', { name: 'BCA Flazz' }).click();
	await expect(sheet.getByLabel('Nama dompet')).toHaveValue('BCA Flazz');
	await expect(sheet.getByRole('radio', { name: 'Kartu e-money' })).toBeChecked();
	await expect(sheet.getByLabel('Penerbit kartu')).toHaveValue('bca_flazz');
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(sheet).toBeHidden();
	await page.reload();
	await expect(row(page, 'Kartu Kereta')).toContainText('Kartu e-money · KMT (KAI Commuter)');
	await expect(row(page, 'BCA Flazz')).toContainText('Kartu e-money · BCA Flazz');
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('focus returns to the opener when the sheet closes', async ({ browser }, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openDompet(page);
	await addWallet(page, { name: 'Dompet harian', type: 'Tunai', balance: '50000' });
	const add = page.getByRole('link', { name: 'Tambah dompet' });
	await add.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Tambah dompet' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(add).toBeFocused();
	await context.close();
});

test('edit a card’s debt (card wording); a second tab’s stale save is refused', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openDompet(page);
	// FN-55a: a card is set up and edited in card wording (the debt typed as owed); its row opens the card page,
	// whose "Ubah kartu" opens the edit form (`/dompet?ubah=<id>`).
	await addWallet(page, { name: 'Kartu Kredit', type: 'Kartu kredit' });
	const href = await row(page, 'Kartu Kredit').getByRole('link').first().getAttribute('href');
	const editUrl = `/dompet?ubah=${href!.split('/').pop()}`;

	// Two tabs open the same edit form.
	const tab2 = await context.newPage();
	await tab2.goto(editUrl);
	await waitForHydration(tab2);
	const sheet2 = tab2.getByRole('dialog', { name: 'Ubah dompet' });
	await expect(sheet2).toBeVisible();

	await page.goto(editUrl);
	await waitForHydration(page);
	const sheet = page.getByRole('dialog', { name: 'Ubah dompet' });
	await sheet.getByLabel('Utang awal (saat kartu ditambahkan)').fill('2.500.000');
	await sheet.getByRole('button', { name: 'Simpan perubahan' }).click();
	await expect(sheet).toBeHidden();
	await expect(row(page, 'Kartu Kredit')).toContainText('−Rp 2.500.000');

	await sheet2.getByLabel('Nama dompet').fill('Ditimpa tab dua');
	await sheet2.getByRole('button', { name: 'Simpan perubahan' }).click();
	await expect(
		sheet2.getByText('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.')
	).toBeVisible();
	await page.reload();
	await expect(row(page, 'Kartu Kredit')).toContainText('−Rp 2.500.000');
	await expect(page.getByText('Ditimpa tab dua')).toHaveCount(0);
	await context.close();
});

test('star moves the favourite; archiving the favourite passes it on; restore from the archive view', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openDompet(page);
	await addWallet(page, { name: 'Satu' });
	await addWallet(page, { name: 'Dua' });
	await addWallet(page, { name: 'Tiga' });
	await expect(row(page, 'Satu').getByText('Favorit')).toBeAttached();

	await row(page, 'Tiga').getByRole('button', { name: 'Jadikan Tiga favorit' }).click();
	await expect(page.getByText('Dompet favorit diganti.')).toBeVisible();
	await expect(row(page, 'Tiga').getByText('Favorit')).toBeAttached();
	await expect(
		row(page, 'Satu').getByRole('button', { name: 'Jadikan Satu favorit' })
	).toBeVisible();
	// Favourite first.
	// The wallet list's first row (the net-worth section, FN-25, sits above it).
	await expect(
		page.locator('section[aria-labelledby="wallets-title"]').getByRole('listitem').first()
	).toContainText('Tiga');

	await row(page, 'Tiga').getByRole('link').first().click();
	const sheet = page.getByRole('dialog', { name: 'Ubah dompet' });
	await sheet.locator('summary', { hasText: 'Arsipkan dompet' }).click();
	await sheet.getByRole('button', { name: 'Ya, arsipkan' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Dompet diarsipkan.')).toBeVisible();
	await expect(row(page, 'Tiga')).toHaveCount(0);
	// The oldest live wallet is the favourite now.
	await expect(row(page, 'Satu').getByText('Favorit')).toBeAttached();

	await page.getByRole('link', { name: 'Lihat yang diarsipkan' }).click();
	const archived = row(page, 'Tiga');
	await expect(archived).toContainText('Diarsipkan');
	await expect(archived.getByRole('button', { name: 'Jadikan Tiga favorit' })).toHaveCount(0);
	await archived.getByRole('button', { name: 'Pulihkan' }).click();
	await expect(page.getByText('Dompet dipulihkan.')).toBeVisible();
	await page.getByRole('link', { name: 'Sembunyikan yang diarsipkan' }).click();
	await expect(
		row(page, 'Tiga').getByRole('button', { name: 'Jadikan Tiga favorit' })
	).toBeVisible();
	await context.close();
});

test('a long form scrolls inside the sheet at 360 × 640; each sheet is labelled by its own heading', async ({
	browser
}, testInfo) => {
	test.skip(testInfo.project.name !== 'phone', 'short phone viewport check');
	const { context, page } = await freshUser(browser, testInfo, {
		viewport: { width: 360, height: 640 }
	});
	await openDompet(page);
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah dompet' });
	await expect(sheet).toBeVisible();
	const box = await sheet.boundingBox();
	expect(box!.height).toBeLessThanOrEqual(640);
	// FN-40 (main a4c1ac4): the title stays put and only the sheet's body scrolls.
	expect(await sheet.locator('.sheet-body').evaluate((d) => d.scrollHeight > d.clientHeight)).toBe(
		true
	);
	const submit = sheet.getByRole('button', { name: 'Tambah dompet' });
	await submit.scrollIntoViewIfNeeded();
	await expect(submit).toBeInViewport();
	// The layout's "Tambah transaksi" sheet and this one never share a title id.
	const ids = await page
		.locator('dialog')
		.evaluateAll((ds) => ds.map((d) => d.getAttribute('aria-labelledby')));
	expect(new Set(ids).size).toBe(ids.length);
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expectNoHorizontalScroll(page);
	await context.close();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`/dompet fits 360 px in ${colorScheme} with 44 px targets`, async ({
		browser
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'phone', '360 px layout is a phone check');
		const { context, page } = await freshUser(browser, testInfo, {
			colorScheme,
			viewport: { width: 360, height: 780 }
		});
		await openDompet(page);
		await addWallet(page, {
			name: 'Nama dompet yang panjang sekali untuk diuji',
			balance: '1234567890123',
			lastFour: '9876'
		});
		await addWallet(page, { name: 'GoPay', type: 'E-wallet' });
		await expectNoHorizontalScroll(page);
		for (const target of [
			page.getByRole('button', { name: /Jadikan .* favorit/ }).first(),
			page.getByRole('link', { name: 'Tambah dompet' }).first(),
			page.getByRole('link', { name: 'Lihat yang diarsipkan' })
		]) {
			const box = await target.boundingBox();
			expect(box?.height).toBeGreaterThanOrEqual(44);
		}
		await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
		const pill = page.getByRole('dialog').locator('label.pill', { hasText: 'Kartu kredit' });
		expect((await pill.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		await context.close();
	});
}

test('without JavaScript: a refused add shows the error, a valid add is listed', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/dompet');
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	await expect(page).toHaveURL(`${BASE}/dompet?tambah=1`);
	const form = page.locator('section.inline-form');
	await form.getByLabel('Nama dompet').fill('Tanpa JS');
	await form.getByRole('radio', { name: 'Tunai' }).check();
	await form.getByLabel('Saldo awal').fill('15.000');
	await form.getByLabel('4 angka terakhir (opsional)').fill('4111111111111111');
	await form.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(
		page.getByText('Isi tepat 4 angka terakhir saja, bukan nomor lengkap.')
	).toBeVisible();
	await expect(page.locator('section.inline-form').getByLabel('Nama dompet')).toHaveValue(
		'Tanpa JS'
	);
	await expect(
		page.locator('section.inline-form').getByLabel('4 angka terakhir (opsional)')
	).toHaveValue('');
	await expect(page.locator('body')).not.toContainText('4111');
	await page.locator('section.inline-form').getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();
	await expect(row(page, 'Tanpa JS')).toContainText('Rp 15.000');
	await context.close();
});

test('FN-39 quick picks fill the name and E-wallet in place; the name stays editable', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openDompet(page);
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah dompet' });
	await expect(sheet).toBeVisible();
	const picks = sheet.getByRole('group', { name: 'Isi cepat e-wallet' });
	// FN-43: each chip leads with its brand badge, which is aria-hidden; the accessible name is the name alone.
	const links = picks.getByRole('link');
	await expect(links).toHaveCount(4);
	for (const [i, name] of ['GoPay', 'OVO', 'ShopeePay', 'DANA'].entries())
		await expect(links.nth(i)).toHaveAccessibleName(name);
	for (const name of ['OVO', 'ShopeePay', 'DANA', 'GoPay']) {
		await sheet.getByRole('radio', { name: 'Bank' }).check();
		await picks.getByRole('link', { name, exact: true }).click();
		await expect(sheet.getByLabel('Nama dompet')).toHaveValue(name);
		await expect(sheet.getByRole('radio', { name: 'E-wallet' })).toBeChecked();
	}
	// No navigation: still the sheet on /dompet.
	await expect(page).toHaveURL(`${BASE}/dompet`);
	await sheet.getByLabel('Nama dompet').fill('GoPay Pribadi');
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(sheet).toBeHidden();
	await expect(row(page, 'GoPay Pribadi')).toContainText('E-wallet');
	await context.close();
});

test('FN-39 quick picks without JavaScript: the link reloads a prefilled form that saves', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/dompet?tambah=1');
	await page.locator('section.inline-form').getByRole('link', { name: 'OVO', exact: true }).click();
	await expect(page).toHaveURL(`${BASE}/dompet?tambah=1&dompet=ovo`);
	const form = page.locator('section.inline-form');
	await expect(form.getByLabel('Nama dompet')).toHaveValue('OVO');
	await expect(form.getByRole('radio', { name: 'E-wallet' })).toBeChecked();
	await form.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();
	await expect(row(page, 'OVO')).toContainText('E-wallet');
	await context.close();
});
