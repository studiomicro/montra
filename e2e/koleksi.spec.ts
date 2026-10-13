import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	tickSignUpBoxes,
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration
} from './helpers';
import { GPS_MARK, realJpegWithGps, realPng } from './photos';

/**
 * FN-28 journeys. Every test signs up its own fictional user (own simulated client address), so its personal
 * space starts with no collectibles. Photos are made in the test (e2e/photos.ts), like FN-27's.
 */
const BASE = APP_ORIGIN;
const PASSWORD = 'terang-benderang-8';
const MINUS = '−';

async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: { javaScriptEnabled?: boolean; n?: number } = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, opts.n ?? 1) },
		javaScriptEnabled: opts.javaScriptEnabled
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Kolektor');
	await page
		.getByLabel('E-mail')
		.fill(`fn28-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	return { context, page };
}

async function openKoleksi(page: Page) {
	await page.goto('/koleksi');
	await waitForHydration(page);
}

const itemRow = (page: Page, name: string) => page.getByRole('listitem').filter({ hasText: name });

async function addItem(
	page: Page,
	item: { name: string; price: string; value: string },
	file?: { name: string; mimeType: string; buffer: Buffer }
) {
	await page.getByRole('link', { name: 'Tambah koleksi' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah koleksi' });
	await expect(sheet).toBeVisible();
	await sheet.getByLabel('Nama koleksi').fill(item.name);
	await sheet.getByLabel('Harga beli').fill(item.price);
	await sheet.getByLabel('Tanggal beli').fill('2024-01-15');
	await sheet.getByLabel('Nilai sekarang').fill(item.value);
	if (file) await sheet.getByLabel('Foto (opsional)').setInputFiles(file);
	await sheet.getByRole('button', { name: 'Tambah koleksi' }).click();
	return sheet;
}

test('add a collectible with a photo: value and rupiah gain first, thumbnail via our route, GPS stripped, deleted with the item', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	const offOrigin = new Set<string>();
	page.on('request', (r) => {
		if (!r.url().startsWith(BASE) && !r.url().startsWith('data:')) offOrigin.add(r.url());
	});
	await openKoleksi(page);
	await expect(page.getByText('Belum ada koleksi.', { exact: false })).toBeVisible();

	const jpeg = await realJpegWithGps(page);
	const sheet = await addItem(
		page,
		{ name: 'Kartu langka', price: '1.500.000', value: '2.100.000' },
		{ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: jpeg }
	);
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Koleksi dan fotonya ditambahkan.')).toBeVisible();
	const row = itemRow(page, 'Kartu langka');
	await expect(row).toContainText('Rp\u00a02.100.000');
	await expect(row).toContainText('+Rp\u00a0600.000');
	await expect(row).toContainText('+40%');
	await expect(page.getByText('+Rp\u00a0600.000 dari harga beli')).toBeVisible();

	await addItem(page, { name: 'Sepatu', price: '3.200.000', value: '2.800.000' });
	await expect(page.getByText('Koleksi ditambahkan.')).toBeVisible();
	await expect(itemRow(page, 'Sepatu')).toContainText(`${MINUS}Rp\u00a0400.000`);
	await expect(page.getByText('+Rp\u00a0200.000 dari harga beli')).toBeVisible();
	await expect(page.locator('.total .figure')).toHaveText('Rp\u00a04.900.000');
	// Phone project: 360 px wide with two rows (value, gain, percent) and no horizontal scroll.
	await expectNoHorizontalScroll(page);

	// The same figure on /kekayaan's Koleksi row; survives a reload (server-confirmed).
	await page.goto('/kekayaan');
	await expect(page.getByRole('link', { name: /Nilai koleksi/ })).toContainText(
		'Rp\u00a04.900.000'
	);
	await openKoleksi(page);

	const img = itemRow(page, 'Kartu langka').locator('img');
	const src = await img.getAttribute('src');
	expect(src).toMatch(/^\/koleksi\/[0-9a-f-]{36}\/foto\?v=\d+$/);
	await expect
		.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
		.toBe(32);
	const served = await context.request.get(src!);
	expect(served.status()).toBe(200);
	const headers = served.headers();
	expect(headers['content-type']).toBe('image/jpeg');
	expect(headers['x-content-type-options']).toBe('nosniff');
	expect(headers['cache-control']).toBe('private, no-cache');
	expect(headers['content-security-policy']).toContain("default-src 'none'");
	expect((await served.body()).includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false);

	// No public R2 URL and no price API: every request stayed on our origin.
	expect([...offOrigin]).toEqual([]);
	expect(await page.content()).not.toMatch(/r2\.(dev|cloudflarestorage)|pokemontcg/);

	const unknown = await context.request.get('/koleksi/00000000-0000-4000-8000-000000000000/foto');
	await itemRow(page, 'Kartu langka').getByRole('link').click();
	const edit = page.getByRole('dialog', { name: 'Ubah koleksi' });
	await edit.getByText('Hapus koleksi').click();
	await edit.getByRole('button', { name: 'Ya, hapus' }).click();
	await expect(page.getByText('Koleksi dihapus.')).toBeVisible();
	await expect(itemRow(page, 'Kartu langka')).toHaveCount(0);
	const gone = await context.request.get(src!);
	expect(gone.status()).toBe(404);
	expect(await gone.text()).toBe(await unknown.text());
	expect(csp).toEqual([]);
	await context.close();
});

test('spoofed and polyglot files are refused by their bytes; nothing is saved', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openKoleksi(page);
	const cases = [
		{
			file: {
				name: 'foto.jpg',
				mimeType: 'image/jpeg',
				buffer: Buffer.from('<html><script>alert(1)</script>')
			},
			message: 'Foto harus berupa JPEG, PNG atau WebP.'
		},
		{
			file: {
				name: 'poly.jpg',
				mimeType: 'image/jpeg',
				buffer: Buffer.concat([
					Buffer.from([0xff, 0xd8, 0xff]),
					Buffer.from('<script>alert(1)</script>')
				])
			},
			message: 'Foto tidak bisa dibaca. Coba foto lain.'
		}
	];
	for (const { file, message } of cases) {
		const sheet = await addItem(page, { name: 'Palsu', price: '100.000', value: '100.000' }, file);
		await expect(sheet.getByText(message)).toBeVisible();
		await sheet.getByRole('button', { name: 'Tutup' }).click();
		await expect(sheet).toBeHidden();
	}
	await page.reload();
	await expect(itemRow(page, 'Palsu')).toHaveCount(0);
	await context.close();
});

test('another account gets the same 404 for my photo as for an unknown id', async ({
	browser
}, testInfo) => {
	const owner = await freshUser(browser, testInfo, { n: 1 });
	await openKoleksi(owner.page);
	await addItem(
		owner.page,
		{ name: 'Figur', price: '750.000', value: '900.000' },
		{ name: 'a.png', mimeType: 'image/png', buffer: realPng() }
	);
	await expect(owner.page.getByText('Koleksi dan fotonya ditambahkan.')).toBeVisible();
	const src = (await itemRow(owner.page, 'Figur').locator('img').getAttribute('src'))!;

	const stranger = await freshUser(browser, testInfo, { n: 2 });
	const theirs = await stranger.context.request.get(src);
	const unknown = await stranger.context.request.get(
		'/koleksi/00000000-0000-4000-8000-000000000000/foto'
	);
	expect(theirs.status()).toBe(404);
	expect(unknown.status()).toBe(404);
	expect(await theirs.text()).toBe(await unknown.text());
	const anon = await browser.newContext({ storageState: SIGNED_OUT });
	const signedOut = await anon.request.get(src, { maxRedirects: 0 });
	expect(signedOut.status()).not.toBe(200);
	await Promise.all([owner.context.close(), stranger.context.close(), anon.close()]);
});

test('AI controls and automatic market price are visible, disabled and send nothing; 360 px has no horizontal scroll', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.setViewportSize({ width: 360, height: 780 });
	await openKoleksi(page);
	await page.getByRole('link', { name: 'Tambah koleksi' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah koleksi' });
	let requests = 0;
	page.on('request', () => requests++);
	for (const name of ['Kenali dari foto (AI)', 'Perkirakan nilai (AI)']) {
		const button = sheet.getByRole('button', { name });
		await expect(button).toBeVisible();
		await expect(button).toBeDisabled();
		await button.click({ force: true });
	}
	const auto = sheet.getByRole('checkbox', { name: 'Harga pasar otomatis' });
	await expect(auto).toBeDisabled();
	await expect(auto).not.toBeChecked();
	await expect(
		sheet.getByText('Belum dikonfigurasi. Untuk sekarang semua koleksi memakai nilai', {
			exact: false
		})
	).toBeVisible();
	await page.waitForTimeout(300);
	expect(requests).toBe(0);
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('without JavaScript: an upload is refused with its reason, then saved and shown', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/koleksi?tambah=1');
	const form = page.locator('section.inline-form');
	await form.getByLabel('Nama koleksi').fill('Komik edisi pertama');
	await form.getByLabel('Harga beli').fill('450.000');
	await form.getByLabel('Tanggal beli').fill('2023-06-01');
	await form.getByLabel('Nilai sekarang').fill('400.000');
	await form
		.getByLabel('Foto (opsional)')
		.setInputFiles({ name: 'x.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('<html>') });
	await form.getByRole('button', { name: 'Tambah koleksi' }).press('Enter');
	await expect(page.getByText('Foto harus berupa JPEG, PNG atau WebP.')).toBeVisible();
	const again = page.locator('section.inline-form');
	await expect(again.getByLabel('Nama koleksi')).toHaveValue('Komik edisi pertama');
	await expect(again.getByLabel('Nilai sekarang')).toHaveValue('400.000');

	await again
		.getByLabel('Foto (opsional)')
		.setInputFiles({ name: 'k.png', mimeType: 'image/png', buffer: realPng() });
	await again.getByRole('button', { name: 'Tambah koleksi' }).press('Enter');
	await expect(page.getByText('Koleksi dan fotonya ditambahkan.')).toBeVisible();
	const row = itemRow(page, 'Komik edisi pertama');
	await expect(row).toContainText(`${MINUS}Rp\u00a050.000`);
	const src = (await row.locator('img').getAttribute('src'))!;
	const served = await context.request.get(src);
	expect(served.headers()['content-type']).toBe('image/png');
	expect((await served.body()).includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false);
	await context.close();
});
