import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	newUser,
	SIGNED_OUT,
	type UserOptions,
	waitForHydration
} from './helpers';
import { GPS_MARK, realJpegWithGps, realPng } from './photos';

/**
 * FN-27 journeys. Every test signs up its own fictional user (own simulated client address), so its personal
 * space starts with no belongings. Photos are made in the test: a real PNG built here, a real JPEG drawn by
 * the browser's canvas with an EXIF block (GPS included) spliced in, and files that only pretend to be images.
 */

const freshUser = (browser: Browser, testInfo: TestInfo, opts: UserOptions = {}) =>
	newUser(browser, testInfo, { prefix: 'fn27', name: 'Pemilik barang', ...opts });

async function openBarang(page: Page) {
	await page.goto('/barang');
	await waitForHydration(page);
}

const itemRow = (page: Page, name: string) => page.getByRole('listitem').filter({ hasText: name });

async function addItem(
	page: Page,
	name: string,
	file?: { name: string; mimeType: string; buffer: Buffer }
) {
	await page.getByRole('link', { name: 'Tambah barang' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah barang' });
	await expect(sheet).toBeVisible();
	await sheet.getByLabel('Nama barang').fill(name);
	await sheet.getByLabel('Harga beli').fill('12.000.000');
	await sheet.getByLabel('Tanggal beli').fill('2024-01-15');
	if (file) await sheet.getByLabel('Foto (opsional)').setInputFiles(file);
	await sheet.getByRole('button', { name: 'Tambah barang' }).click();
	return sheet;
}

test('add an item with a photo: estimate labelled, thumbnail via our route, GPS stripped, deleted with the item', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	const r2 = new Set<string>();
	page.on('request', (r) => {
		if (!r.url().startsWith(APP_ORIGIN) && !r.url().startsWith('data:')) r2.add(r.url());
	});
	await openBarang(page);
	await expect(page.getByText('Belum ada barang.', { exact: false })).toBeVisible();

	const jpeg = await realJpegWithGps(page);
	expect(jpeg.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(true);
	const sheet = await addItem(page, 'Laptop kerja', {
		name: 'IMG_0001.jpg',
		mimeType: 'image/jpeg',
		buffer: jpeg
	});
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const row = itemRow(page, 'Laptop kerja');
	await expect(row).toContainText('Estimasi');
	await expect(page.getByText('Estimasi, bukan nilai pasar sebenarnya.')).toBeVisible();

	const img = row.locator('img');
	const src = await img.getAttribute('src');
	expect(src).toMatch(/^\/barang\/[0-9a-f-]{36}\/foto\?v=\d+$/);
	await expect
		.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
		.toBe(32);

	const served = await context.request.get(src!);
	expect(served.status()).toBe(200);
	const headers = served.headers();
	expect(headers['content-type']).toBe('image/jpeg');
	expect(headers['x-content-type-options']).toBe('nosniff');
	expect(headers['content-disposition']).toBe('inline');
	expect(headers['cache-control']).toBe('private, no-cache');
	expect(headers['content-security-policy']).toContain("default-src 'none'");
	const body = await served.body();
	expect(body.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false);
	expect(body.includes(Buffer.from([0x88, 0x25]))).toBe(false);

	// No public R2 URL anywhere: every request stayed on our origin.
	expect([...r2]).toEqual([]);
	expect(await page.content()).not.toMatch(/r2\.(dev|cloudflarestorage)/);

	// Delete: the row goes and the photo URL answers like an unknown id.
	const unknown = await context.request.get('/barang/00000000-0000-4000-8000-000000000000/foto');
	await row.getByRole('link').click();
	const edit = page.getByRole('dialog', { name: 'Ubah barang' });
	await edit.getByText('Hapus barang').click();
	await edit.getByRole('button', { name: 'Ya, hapus' }).click();
	await expect(page.getByText('Barang dihapus.')).toBeVisible();
	await expect(itemRow(page, 'Laptop kerja')).toHaveCount(0);
	const gone = await context.request.get(src!);
	expect(gone.status()).toBe(404);
	expect(await gone.text()).toBe(await unknown.text());
	expect(csp).toEqual([]);
	await context.close();
});

test('spoofed, SVG and polyglot files are refused by their bytes; nothing is saved', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await openBarang(page);
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
				name: 'gambar.svg',
				mimeType: 'image/svg+xml',
				buffer: Buffer.from(
					'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
				)
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
		const sheet = await addItem(page, 'Palsu', file);
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
	await openBarang(owner.page);
	await addItem(owner.page, 'Sepeda', { name: 'a.png', mimeType: 'image/png', buffer: realPng() });
	await expect(owner.page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const src = (await itemRow(owner.page, 'Sepeda').locator('img').getAttribute('src'))!;

	const stranger = await freshUser(browser, testInfo, { n: 2 });
	const theirs = await stranger.context.request.get(src);
	const unknown = await stranger.context.request.get(
		'/barang/00000000-0000-4000-8000-000000000000/foto'
	);
	expect(theirs.status()).toBe(404);
	expect(unknown.status()).toBe(404);
	expect(await theirs.text()).toBe(await unknown.text());
	// Signed out: no photo either.
	const anon = await browser.newContext({ storageState: SIGNED_OUT });
	const signedOut = await anon.request.get(src, { maxRedirects: 0 });
	expect(signedOut.status()).not.toBe(200);
	await Promise.all([owner.context.close(), stranger.context.close(), anon.close()]);
});

test('the AI control is visible, disabled and sends nothing; 360 px has no horizontal scroll', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.setViewportSize({ width: 360, height: 780 });
	await openBarang(page);
	await page.getByRole('link', { name: 'Tambah barang' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah barang' });
	const ai = sheet.getByRole('button', { name: 'Kenali dari foto (AI)' });
	await expect(ai).toBeVisible();
	await expect(ai).toBeDisabled();
	await expect(sheet.getByText('Belum dikonfigurasi.', { exact: false })).toBeVisible();
	let requests = 0;
	page.on('request', () => requests++);
	await ai.click({ force: true });
	// Proves a negative: the disabled AI button sends nothing, so there is no event to await; a short grace is all there is.
	await page.waitForTimeout(300);
	expect(requests).toBe(0);
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('without JavaScript: an upload is refused with its reason, then saved and shown', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/barang?tambah=1');
	const form = page.locator('section.inline-form');
	await form.getByLabel('Nama barang').fill('Kulkas');
	await form.getByLabel('Harga beli').fill('4.500.000');
	await form.getByLabel('Tanggal beli').fill('2023-06-01');
	await form
		.getByLabel('Foto (opsional)')
		.setInputFiles({ name: 'x.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('<html>') });
	await form.getByRole('button', { name: 'Tambah barang' }).press('Enter');
	await expect(page.getByText('Foto harus berupa JPEG, PNG atau WebP.')).toBeVisible();
	await expect(page.locator('section.inline-form').getByLabel('Nama barang')).toHaveValue('Kulkas');

	const again = page.locator('section.inline-form');
	await again
		.getByLabel('Foto (opsional)')
		.setInputFiles({ name: 'k.png', mimeType: 'image/png', buffer: realPng() });
	await again.getByRole('button', { name: 'Tambah barang' }).press('Enter');
	await expect(page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const row = itemRow(page, 'Kulkas');
	await expect(row).toContainText('Estimasi');
	const src = (await row.locator('img').getAttribute('src'))!;
	const served = await context.request.get(src);
	expect(served.headers()['content-type']).toBe('image/png');
	expect((await served.body()).includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false);
	await context.close();
});
