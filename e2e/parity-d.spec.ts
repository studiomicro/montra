import { expect, test } from '@playwright/test';
import { APP_ORIGIN, expectNoHorizontalScroll, SIGNED_OUT } from './helpers';

/**
 * Parity wave D (APP_PARITY § 3a): every restyled screen keeps a visible H1 and never scrolls sideways at
 * 360 px. Phone project only; uses the shared signed-in e2e user (pages that need data show their empty states).
 */
const SIGNED_IN = [
	'/pengaturan',
	'/pengaturan/akun',
	'/pengaturan/paket',
	'/pengaturan/privasi',
	'/pengaturan/notifikasi',
	'/pengaturan/aplikasi',
	'/pengaturan/instal',
	'/pengaturan/kategori',
	'/pengaturan/fitur',
	'/kotak-masuk',
	'/kotak-masuk/notifikasi',
	'/kotak-masuk/periksa',
	'/ruang',
	'/ruang/baru',
	'/tanya',
	'/langganan',
	'/barang',
	'/koleksi',
	'/riwayat/baru',
	'/riwayat/suara'
];

test('restyled screens: H1 visible, no horizontal scroll at 360 px', async ({ page, browser }) => {
	test.skip((page.viewportSize()?.width ?? 0) > 400, 'phone project only');
	for (const path of SIGNED_IN) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
		await expectNoHorizontalScroll(page);
	}
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		viewport: { width: 360, height: 780 }
	});
	const signedOut = await context.newPage();
	for (const path of ['/masuk', '/daftar']) {
		await signedOut.goto(APP_ORIGIN + path);
		await expect(signedOut.getByRole('heading', { level: 1 }), path).toBeVisible();
		await expectNoHorizontalScroll(signedOut);
	}
	await context.close();
});
