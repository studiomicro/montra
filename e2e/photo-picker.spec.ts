import {
	expect,
	test,
	type Browser,
	type BrowserContextOptions,
	type Page,
	type TestInfo
} from '@playwright/test';
import { APP_ORIGIN, expectNoHorizontalScroll, newUser, waitForHydration } from './helpers';
import { addWallet } from './ledger';
import {
	canvasImage,
	GPS_MARK,
	heifHeader,
	imageSize,
	paddedJpeg,
	realJpegWithGps,
	realPng,
	withExif
} from './photos';

/**
 * FN-45 photo picker. Playwright cannot open a real camera: these tests check what the page offers (the
 * actions, `capture`, labels, sizes), set files on both inputs as the OS chooser would, and follow the photo to
 * the server. Real iPhone/Android camera and gallery behaviour is the owner-run check (AC 20).
 *
 * Every test makes its own context (phone: 360 × 800 with touch; desktop: a fine pointer only; or no
 * JavaScript), so the suite runs once, in the desktop project.
 */
test.skip(({ isMobile }) => isMobile, 'runs once: every test makes its own context');

const PHONE: BrowserContextOptions = {
	viewport: { width: 360, height: 800 },
	hasTouch: true,
	isMobile: true
};
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const HEIF_MESSAGE =
	'Foto HEIC/HEIF belum bisa dipakai. Ambil foto lewat tombol Kamera, atau ubah format kamera ke JPEG';

const signUp = (browser: Browser, testInfo: TestInfo, options: BrowserContextOptions) =>
	newUser(browser, testInfo, { prefix: 'fn45', name: 'Pemotret', ...options });

async function openStruk(page: Page) {
	await addWallet(page, 'Tunai Foto');
	await page.goto('/riwayat/struk');
	await waitForHydration(page);
}

async function openAddItem(page: Page) {
	await page.goto('/barang');
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Tambah barang' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah barang' });
	await expect(sheet).toBeVisible();
	await sheet.getByLabel('Nama barang').fill('Kamera saku');
	await sheet.getByLabel('Harga beli').fill('3.000.000');
	await sheet.getByLabel('Tanggal beli').fill('2024-02-01');
	return sheet;
}

/** The saved item's photo as the server serves it. */
async function savedPhoto(page: Page, name: string): Promise<{ type: string; body: Buffer }> {
	const row = page.getByRole('listitem').filter({ hasText: name });
	const src = (await row.locator('img').getAttribute('src'))!;
	const served = await page.request.get(`${APP_ORIGIN}${src}`);
	expect(served.status()).toBe(200);
	return { type: served.headers()['content-type']!, body: await served.body() };
}

const cameraInput = (page: Page) => page.locator('input[type="file"][capture="environment"]');

test('phone: Kamera and Galeri side by side, 44 px, capture only on the camera input; both inputs feed Struk', async ({
	browser
}, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, PHONE);
	await openStruk(page);

	const group = page.getByRole('group', { name: 'Pilih atau ambil foto struk' });
	const kamera = group.getByRole('button', { name: 'Ambil foto dengan kamera' });
	const galeri = group.getByRole('button', { name: 'Pilih foto dari galeri' });
	await expect(kamera).toBeVisible();
	await expect(kamera).toHaveText('Kamera');
	await expect(galeri).toHaveText('Galeri');
	for (const action of [kamera, galeri]) {
		const box = (await action.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
	}
	const kameraBox = (await kamera.boundingBox())!;
	const galeriBox = (await galeri.boundingBox())!;
	expect(Math.abs(kameraBox.y - galeriBox.y)).toBeLessThan(1);
	expect(Math.abs(kameraBox.width - galeriBox.width)).toBeLessThan(1);
	await expectNoHorizontalScroll(page);

	const gallery = page.getByLabel('Pilih atau ambil foto struk');
	await expect(gallery).toHaveCount(1);
	await expect(cameraInput(page)).toHaveCount(1);
	await expect(gallery).not.toHaveAttribute('capture');
	await expect(gallery).not.toHaveAttribute('multiple');
	await expect(cameraInput(page)).not.toHaveAttribute('multiple');
	const accept = 'image/jpeg,image/png,image/webp';
	await expect(gallery).toHaveAttribute('accept', accept);
	await expect(cameraInput(page)).toHaveAttribute('accept', accept);

	// Each action opens its own chooser from the keyboard; the camera's carries capture="environment".
	await kamera.focus();
	let chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Enter');
	expect(await (await chooser).element().getAttribute('capture')).toBe('environment');
	await galeri.focus();
	chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Space');
	expect(await (await chooser).element().getAttribute('capture')).toBeNull();

	// A camera photo: preview and status; the camera input now holds the field name.
	await cameraInput(page).setInputFiles({
		name: 'kamera.jpg',
		mimeType: 'image/jpeg',
		buffer: await realJpegWithGps(page)
	});
	const preview = page.getByRole('img', { name: 'Pratinjau foto struk' });
	await expect(preview).toBeVisible();
	await expect(
		page.getByRole('status').filter({ hasText: 'Foto dipilih: kamera.jpg' })
	).toBeVisible();
	await expect(cameraInput(page)).toHaveAttribute('name', 'photo');
	await expect(gallery).not.toHaveAttribute('name');
	const first = await preview.getAttribute('src');

	// Then a gallery photo replaces it, and the gallery input holds the name again.
	await gallery.setInputFiles({
		name: 'galeri.png',
		mimeType: 'image/png',
		buffer: await canvasImage(page, { width: 40, height: 30, type: 'image/png' })
	});
	await expect(
		page.getByRole('status').filter({ hasText: 'Foto dipilih: galeri.png' })
	).toBeVisible();
	await expect.poll(() => preview.getAttribute('src')).not.toBe(first);
	await expect(gallery).toHaveAttribute('name', 'photo');
	await expect(cameraInput(page)).not.toHaveAttribute('name');
	await expect(cameraInput(page)).toHaveValue('');

	// English labels for an English-speaking user.
	await context.addCookies([{ name: 'lang', value: 'en', url: APP_ORIGIN }]);
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByRole('button', { name: 'Take a photo with the camera' })).toHaveText(
		'Camera'
	);
	await expect(page.getByRole('button', { name: 'Choose a photo from the gallery' })).toHaveText(
		'Gallery'
	);
	await context.close();
});

test('phone: Barang and Koleksi offer both actions at 360 px; the latest pick (camera, then gallery) is saved', async ({
	browser
}, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, PHONE);
	await page.goto('/koleksi?tambah=1');
	await waitForHydration(page);
	await expect(page.getByRole('button', { name: 'Ambil foto dengan kamera' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Pilih foto dari galeri' })).toBeVisible();
	await expectNoHorizontalScroll(page);

	const sheet = await openAddItem(page);
	await expect(sheet.getByRole('group', { name: 'Foto (opsional)' })).toBeVisible();
	await expectNoHorizontalScroll(page);
	await sheet.locator('input[capture="environment"]').setInputFiles({
		name: 'kamera.jpg',
		mimeType: 'image/jpeg',
		buffer: await realJpegWithGps(page)
	});
	await sheet.getByLabel('Foto (opsional)').setInputFiles({
		name: 'galeri.png',
		mimeType: 'image/png',
		buffer: await canvasImage(page, { width: 40, height: 30, type: 'image/png' })
	});
	await expect(sheet.getByText('Foto dipilih: galeri.png')).toBeVisible();
	// The form sends exactly one non-empty `photo`: the gallery PNG.
	const sent = await sheet
		.locator('form')
		.evaluate((form: HTMLFormElement) =>
			new FormData(form).getAll('photo').map((f) => (f instanceof File ? [f.name, f.size > 0] : f))
		);
	expect(sent).toEqual([['galeri.png', true]]);
	await sheet.getByRole('button', { name: 'Tambah barang' }).click();
	await expect(page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const photo = await savedPhoto(page, 'Kamera saku');
	expect(photo.type).toBe('image/png');
	expect(imageSize(photo.body)).toEqual({ width: 40, height: 30 });
	await context.close();
});

test('phone: a camera photo alone is saved with the item', async ({ browser }, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, PHONE);
	const sheet = await openAddItem(page);
	await sheet.locator('input[capture="environment"]').setInputFiles({
		name: 'kamera.jpg',
		mimeType: 'image/jpeg',
		buffer: await realJpegWithGps(page)
	});
	await expect(sheet.getByText('Foto dipilih: kamera.jpg')).toBeVisible();
	await sheet.getByRole('button', { name: 'Tambah barang' }).click();
	await expect(page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const photo = await savedPhoto(page, 'Kamera saku');
	expect(photo.type).toBe('image/jpeg');
	expect(photo.body.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false);
	await context.close();
});

test('desktop: "Pilih foto" and a drop zone, no camera input; a drop of two photos uses the first', async ({
	browser
}, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, DESKTOP);
	await openStruk(page);
	const group = page.getByRole('group', { name: 'Pilih atau ambil foto struk' });
	await expect(group.getByRole('button', { name: 'Pilih foto', exact: true })).toBeVisible();
	await expect(group.getByText('atau tarik foto ke sini')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Ambil foto dengan kamera' })).toHaveCount(0);
	await expect(cameraInput(page)).toHaveCount(0);

	// Keyboard: Tab reaches "Pilih foto"; Enter and Space open the chooser.
	const choose = group.getByRole('button', { name: 'Pilih foto', exact: true });
	await choose.focus();
	await expect(choose).toBeFocused();
	let chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Enter');
	await chooser;
	chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Space');
	await chooser;

	const jpeg = (await realJpegWithGps(page)).toString('base64');
	const png = (await canvasImage(page, { width: 20, height: 20, type: 'image/png' })).toString(
		'base64'
	);
	const transfer = await page.evaluateHandle(
		([a, b]) => {
			const data = new DataTransfer();
			const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
			data.items.add(new File([bytes(a!)], 'pertama.jpg', { type: 'image/jpeg' }));
			data.items.add(new File([bytes(b!)], 'kedua.png', { type: 'image/png' }));
			return data;
		},
		[jpeg, png]
	);
	const zone = group;
	await zone.dispatchEvent('dragover', { dataTransfer: transfer });
	await zone.dispatchEvent('drop', { dataTransfer: transfer });
	await expect(
		page.getByRole('status').filter({ hasText: 'Foto dipilih: pertama.jpg' })
	).toContainText('2 foto dipilih — hanya foto pertama yang dipakai.');
	await expect(page.getByRole('img', { name: 'Pratinjau foto struk' })).toBeVisible();
	const held = await page
		.getByLabel('Pilih atau ambil foto struk')
		.evaluate((input: HTMLInputElement) => [...(input.files ?? [])].map((f) => f.name));
	expect(held).toEqual(['pertama.jpg']);
	await context.close();
});

test('desktop: a dropped PDF is refused at once by its bytes; nothing is put in the input (red team 1)', async ({
	browser
}, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, DESKTOP);
	await openStruk(page);
	const group = page.getByRole('group', { name: 'Pilih atau ambil foto struk' });
	const transfer = await page.evaluateHandle(() => {
		const data = new DataTransfer();
		data.items.add(new File(['%PDF-1.7 bukan foto'], 'struk.jpg', { type: 'image/jpeg' }));
		return data;
	});
	await group.dispatchEvent('dragover', { dataTransfer: transfer });
	await group.dispatchEvent('drop', { dataTransfer: transfer });
	await expect(page.getByText('Foto harus berupa JPEG, PNG atau WebP.')).toBeVisible();
	const held = await page
		.getByLabel('Pilih atau ambil foto struk')
		.evaluate((input: HTMLInputElement) => input.files?.length ?? 0);
	expect(held).toBe(0);
	await context.close();
});

test('HEIC this browser cannot decode: the fix message, the input cleared, nothing sent', async ({
	browser
}, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, PHONE);
	const posts: string[] = [];
	page.on('request', (r) => {
		if (r.method() === 'POST') posts.push(r.url());
	});
	await openStruk(page);
	posts.length = 0;
	const heic = { name: 'IMG_0420.HEIC', mimeType: 'image/heic', buffer: heifHeader() };
	const struk = page.getByLabel('Pilih atau ambil foto struk');
	await struk.setInputFiles(heic);
	await expect(page.getByRole('alert').filter({ hasText: HEIF_MESSAGE })).toBeVisible();
	await expect(struk).toHaveValue('');
	await expect(struk).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByRole('img', { name: 'Pratinjau foto struk' })).toHaveCount(0);

	const sheet = await openAddItem(page);
	posts.length = 0;
	const item = sheet.getByLabel('Foto (opsional)');
	await item.setInputFiles(heic);
	await expect(sheet.getByRole('alert').filter({ hasText: HEIF_MESSAGE })).toBeVisible();
	await expect(item).toHaveValue('');
	expect(posts).toEqual([]);
	await context.close();
});

test('item photos: a large rotated JPEG is downscaled upright without EXIF; a small PNG is sent as picked', async ({
	browser
}, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, DESKTOP);
	// Slow the decode a little so the preparing state can be seen.
	await page.addInitScript(() => {
		const decode = window.createImageBitmap.bind(window) as (
			...args: unknown[]
		) => Promise<ImageBitmap>;
		(window as unknown as { createImageBitmap: unknown }).createImageBitmap = (
			...args: unknown[]
		) => new Promise((resolve) => setTimeout(resolve, 700)).then(() => decode(...args));
	});
	let sheet = await openAddItem(page);
	const big = withExif(
		await canvasImage(page, { width: 4000, height: 3000, type: 'image/jpeg' }),
		6
	);
	await sheet.getByLabel('Foto (opsional)').setInputFiles({
		name: 'besar.jpg',
		mimeType: 'image/jpeg',
		buffer: big
	});
	const submit = sheet.getByRole('button', { name: 'Tambah barang' });
	await expect(sheet.getByRole('status').filter({ hasText: 'Menyiapkan foto…' })).toBeVisible();
	await expect(submit).toBeDisabled();
	await expect(sheet.getByText('Foto dipilih: besar.jpg')).toBeVisible();
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const stored = await savedPhoto(page, 'Kamera saku');
	expect(stored.type).toBe('image/jpeg');
	const size = imageSize(stored.body);
	expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2560);
	expect(size.width).toBeLessThan(size.height);
	expect(stored.body.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
	expect(stored.body.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false);

	await page.goto('/barang');
	sheet = await openAddItem(page);
	await sheet.getByLabel('Nama barang').fill('Lukisan kecil');
	const png = await canvasImage(page, { width: 1200, height: 900, type: 'image/png' });
	await sheet.getByLabel('Foto (opsional)').setInputFiles({
		name: 'kecil.png',
		mimeType: 'image/png',
		buffer: png
	});
	await expect(sheet.getByText('Foto dipilih: kecil.png')).toBeVisible();
	await expect(submit).toBeEnabled();
	await sheet.getByRole('button', { name: 'Tambah barang' }).click();
	await expect(page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const kept = await savedPhoto(page, 'Lukisan kecil');
	expect(kept.type).toBe('image/png');
	expect(imageSize(kept.body)).toEqual({ width: 1200, height: 900 });
	await context.close();
});

test('item photos: a decodable JPEG over 8 MB is re-encoded and saved; a non-image over 8 MB is refused on the device', async ({
	browser
}, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, DESKTOP);
	let sheet = await openAddItem(page);
	const posts: string[] = [];
	page.on('request', (r) => {
		if (r.method() === 'POST') posts.push(r.url());
	});
	await sheet.getByLabel('Foto (opsional)').setInputFiles({
		name: 'bukan-foto.jpg',
		mimeType: 'image/jpeg',
		buffer: Buffer.alloc(8 * 1024 * 1024 + 10, 0x41)
	});
	await expect(sheet.getByText('Foto terlalu besar. Paling besar 8 MB.')).toBeVisible();
	await expect(sheet.getByLabel('Foto (opsional)')).toHaveValue('');
	expect(posts).toEqual([]);

	await page.goto('/barang');
	sheet = await openAddItem(page);
	const heavy = paddedJpeg(
		await canvasImage(page, { width: 1600, height: 1200, type: 'image/jpeg' }),
		8 * 1024 * 1024 + 1024
	);
	await sheet.getByLabel('Foto (opsional)').setInputFiles({
		name: 'berat.jpg',
		mimeType: 'image/jpeg',
		buffer: heavy
	});
	await expect(sheet.getByText('Foto dipilih: berat.jpg')).toBeVisible();
	await expect(sheet.getByRole('button', { name: 'Tambah barang' })).toBeEnabled();
	await sheet.getByRole('button', { name: 'Tambah barang' }).click();
	await expect(page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const stored = await savedPhoto(page, 'Kamera saku');
	expect(stored.body.length).toBeLessThan(8 * 1024 * 1024);
	expect(imageSize(stored.body)).toEqual({ width: 1600, height: 1200 });
	await context.close();
});

test('no JavaScript: one plain file input named photo on Struk and Barang; a JPEG saves, HEIC gets the fix', async ({
	browser
}, testInfo) => {
	const { context, page } = await signUp(browser, testInfo, { javaScriptEnabled: false });
	await addWallet(page, 'Tunai Tanpa JS');
	await page.goto('/riwayat/struk');
	const strukInputs = page.locator('input[type="file"]');
	await expect(strukInputs).toHaveCount(1);
	const struk = page.getByLabel('Pilih atau ambil foto struk');
	await expect(struk).toBeVisible();
	await expect(struk).toHaveAttribute('name', 'photo');
	await expect(struk).not.toHaveAttribute('capture');
	await expect(page.locator('form:has(input[type="file"])')).toHaveAttribute('action', '?/read');
	await expect(page.getByRole('button', { name: 'Pilih foto' })).toHaveCount(0);

	await page.goto('/barang?tambah=1');
	const form = page.locator('section.inline-form');
	await expect(form.locator('input[type="file"]')).toHaveCount(1);
	await expect(form.getByLabel('Foto (opsional)')).toBeVisible();
	await expect(form.getByLabel('Foto (opsional)')).toHaveAttribute('name', 'photo');
	await form.getByLabel('Nama barang').fill('Rice cooker');
	await form.getByLabel('Harga beli').fill('600.000');
	await form.getByLabel('Tanggal beli').fill('2023-06-01');
	await form
		.getByLabel('Foto (opsional)')
		.setInputFiles({ name: 'IMG_0420.HEIC', mimeType: 'image/heic', buffer: heifHeader() });
	await form.getByRole('button', { name: 'Tambah barang' }).press('Enter');
	await expect(
		page.getByText(
			'Foto HEIC/HEIF belum bisa dipakai. Ubah format kamera ke JPEG (Android: Kamera › Setelan › Format gambar; iPhone: Pengaturan › Kamera › Format › Paling Kompatibel), lalu pilih lagi.'
		)
	).toBeVisible();

	const again = page.locator('section.inline-form');
	await again
		.getByLabel('Foto (opsional)')
		.setInputFiles({ name: 'rice.png', mimeType: 'image/png', buffer: realPng() });
	await again.getByRole('button', { name: 'Tambah barang' }).press('Enter');
	await expect(page.getByText('Barang dan fotonya ditambahkan.')).toBeVisible();
	const stored = await savedPhoto(page, 'Rice cooker');
	expect(stored.type).toBe('image/png');
	expect(stored.body.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false);
	await context.close();
});
