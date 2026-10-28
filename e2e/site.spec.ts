import { expect, test, type Page } from '@playwright/test';
import {
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	APP_ORIGIN,
	SIGNED_OUT,
	SITE_ORIGIN
} from './helpers';

const SITE = SITE_ORIGIN;

/** Every request a page makes that leaves its own origin (FN-32: none, ever). */
function collectForeignRequests(page: Page, origin: string): string[] {
	const foreign: string[] = [];
	page.on('request', (r) => {
		if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) foreign.push(r.url());
	});
	return foreign;
}

/** Console errors of any kind (CSP violations included). */
function collectConsoleErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	page.on('pageerror', (e) => errors.push(e.message));
	return errors;
}

test('site home: every landing section, the start button and no request off the site', async ({
	page
}) => {
	const csp = collectCspViolations(page);
	const errors = collectConsoleErrors(page);
	const foreign = collectForeignRequests(page, SITE);
	const res = await page.goto(`${SITE}/`);
	// Prerendered, served by the Worker with the same CSP as every rendered page.
	expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(res?.headers()['content-security-policy']).not.toContain('unsafe-inline');
	expect(res?.headers()['x-content-type-options']).toBe('nosniff');
	await expect(
		page.getByRole('heading', { level: 1, name: 'Semua urusan uangmu, satu aplikasi' })
	).toBeVisible();
	for (const name of [
		'Satu aplikasi, semua urusan uang',
		'Datamu tetap milikmu',
		'Harga',
		'Pertanyaan umum'
	])
		await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
	// The module tree: six modules, each with its art and its status; Tanya and Agen are not active yet.
	for (const id of ['catat', 'lihat', 'atur', 'miliki', 'bagi', 'tanya'])
		await expect(
			page.getByTestId(`site-module-${id}`).getByRole('heading', { level: 3 })
		).toBeVisible();
	await expect(page.getByTestId('site-module-tanya').getByText('Segera')).toBeVisible();
	await expect(page.getByTestId('site-module-catat').getByText('Tersedia')).toBeVisible();
	// FN-30's catalogue: one card per plan, each price badged as a placeholder (AC3).
	for (const plan of ['gratis', 'pro', 'agen'])
		await expect(page.getByTestId(`site-plan-${plan}`).getByText('harga sementara')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Mulai gratis' }).first()).toHaveAttribute(
		'href',
		'/mulai'
	);
	// No JavaScript on the public site at all.
	expect(await page.locator('script').count()).toBe(0);
	await expectNoHorizontalScroll(page);
	expect(foreign).toEqual([]);
	expect(errors).toEqual([]);
	expect(csp).toEqual([]);
});

test('the English site lives under /en, with a language switch both ways', async ({ page }) => {
	await page.goto(`${SITE}/en`);
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(
		page.getByRole('heading', { level: 1, name: 'All your money matters, one app' })
	).toBeVisible();
	await expect(
		page.getByRole('heading', { level: 2, name: 'Your data stays yours' })
	).toBeVisible();
	await page.getByRole('link', { name: 'Bahasa Indonesia' }).first().click();
	await expect(page).toHaveURL(`${SITE}/`);
	await expect(page.locator('html')).toHaveAttribute('lang', 'id');
	await expect(page.getByRole('link', { name: 'English' }).first()).toHaveAttribute('href', '/en');
	const canonical = page.locator('link[rel="canonical"]');
	await expect(canonical).toHaveAttribute('href', 'http://site.localhost/');
	await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
		'content',
		'Montra — super app keuangan untuk Indonesia'
	);
});

test('"Mulai gratis" leads to sign-up on the app host', async ({ browser }) => {
	const context = await browser.newContext({ storageState: SIGNED_OUT });
	const page = await context.newPage();
	await page.goto(`${SITE}/`);
	await page.getByRole('link', { name: 'Mulai gratis' }).first().click();
	await expect(page).toHaveURL(`${APP_ORIGIN}/daftar`);
	await context.close();
});

test('blog: index from the repo posts, a post with its disclaimer, unknown slug 404', async ({
	page
}) => {
	const csp = collectCspViolations(page);
	await page.goto(`${SITE}/blog`);
	const posts = page.locator('.posts li');
	await expect(posts).toHaveCount(3);
	await page.getByRole('link', { name: /Dari struk ke transaksi dalam hitungan detik/ }).click();
	await expect(page).toHaveURL(`${SITE}/blog/struk-jadi-transaksi`);
	await expect(
		page.getByRole('heading', { level: 1, name: 'Dari struk ke transaksi dalam hitungan detik' })
	).toBeVisible();
	await expect(
		page.getByRole('heading', { level: 2, name: 'Kenapa fotonya tidak disimpan' })
	).toBeVisible();
	await expect(page.getByText('Artikel ini informasi umum, bukan nasihat keuangan.')).toBeVisible();
	await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
	await expectNoHorizontalScroll(page);

	await page.goto(`${SITE}/en/blog/struk-jadi-transaksi`);
	await expect(
		page.getByRole('heading', { level: 1, name: 'From receipt to transaction in seconds' })
	).toBeVisible();
	await expect(
		page.getByText('This article is general information, not financial advice.')
	).toBeVisible();

	const missing = await page.goto(`${SITE}/blog/tidak-ada`);
	expect(missing?.status()).toBe(404);
	await expect(page.getByText('Halaman tidak ditemukan.')).toBeVisible();
	expect(csp).toEqual([]);
});

test('/pasang: the public install guide with both platforms and the QR code on desktop', async ({
	page
}) => {
	const csp = collectCspViolations(page);
	const foreign = collectForeignRequests(page, SITE);
	await page.goto(`${SITE}/pasang`);
	await expect(page.getByRole('heading', { level: 1, name: 'Pasang aplikasi' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'iPhone dan iPad (Safari)' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Android (Chrome)' })).toBeVisible();
	await expect(page.getByText('Pilih Tambah ke Layar Utama.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Buka aplikasi' })).toHaveAttribute('href', '/mulai');
	const qr = page.getByRole('img', { name: 'Kode QR ke panduan pemasangan' });
	if (isPhone(page)) {
		await expect(qr).toBeHidden();
		await expectNoHorizontalScroll(page);
	} else {
		await expect(qr).toBeVisible();
		expect(await qr.locator('path').getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
	}
	expect(foreign).toEqual([]);
	expect(csp).toEqual([]);
});

test('legal pages: expanded sections under the draft banner, in both languages', async ({
	page
}) => {
	await page.goto(`${SITE}/`);
	await page.getByRole('link', { name: 'Privasi', exact: true }).click();
	await expect(page).toHaveURL(`${SITE}/privasi`);
	await expect(page.getByRole('heading', { level: 1, name: 'Kebijakan privasi' })).toBeVisible();
	await expect(page.getByText('Draf. Isi lengkap menunggu tinjauan hukum.')).toBeVisible();
	// FN-14 (red team L3): the browser's own recogniser may send audio to its vendor.
	await expect(
		page.getByRole('heading', { level: 2, name: 'Pencatatan dengan suara' })
	).toBeVisible();
	await expect(page.getByText(/mengirim rekaman ke server pembuat browser/)).toBeVisible();
	for (const name of [
		'File yang kamu unggah',
		'Pemrosesan data di luar Indonesia',
		'Statistik pemakaian',
		'Hakmu'
	])
		await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();

	await page.goto(`${SITE}/en/ketentuan`);
	await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible();
	await expect(page.getByText('Draft. Full text awaits legal review.')).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Governing law' })).toBeVisible();

	for (const path of ['/ketentuan', '/hapus-akun', '/blog', '/en/privasi', '/en/hapus-akun']) {
		const res = await page.goto(`${SITE}${path}`);
		expect(res?.status()).toBe(200);
	}
});

test('sitemap.xml and robots.txt list only site-host URLs', async ({ request }) => {
	const sitemap = await request.get(`${SITE}/sitemap.xml`);
	expect(sitemap.status()).toBe(200);
	expect(sitemap.headers()['content-type']).toContain('application/xml');
	const locs = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	expect(locs).toContain('http://site.localhost/pasang');
	expect(locs).toContain('http://site.localhost/en/blog/struk-jadi-transaksi');
	expect(locs.length).toBe(18);
	for (const loc of locs) expect(loc).toMatch(/^http:\/\/site\.localhost\//);

	const robots = await request.get(`${SITE}/robots.txt`);
	expect(await robots.text()).toContain('Sitemap: http://site.localhost/sitemap.xml');
	// The app host is never indexed.
	const app = await request.get(`${APP_ORIGIN}/masuk`);
	expect(app.headers()['x-robots-tag']).toBe('noindex');
	expect((await request.get(`${APP_ORIGIN}/robots.txt`)).status()).toBe(404);
});

test('the site works without JavaScript', async ({ browser }) => {
	const context = await browser.newContext({ javaScriptEnabled: false, storageState: SIGNED_OUT });
	const page = await context.newPage();
	await page.goto(`${SITE}/`);
	await page.getByText('Apakah ini bank atau dompet digital?').click();
	await expect(page.getByText(/Bukan\. Kami hanya mencatat\./)).toBeVisible();
	await page.getByRole('link', { name: 'Blog' }).last().click();
	await expect(page).toHaveURL(`${SITE}/blog`);
	await context.close();
});

test('header links, language switch and footer links are at least 44 px tall', async ({ page }) => {
	await page.goto(`${SITE}/`);
	const links = page.locator('header a:visible, footer a');
	const count = await links.count();
	expect(count).toBeGreaterThan(5);
	for (let i = 0; i < count; i++) {
		const box = await links.nth(i).boundingBox();
		expect(box!.height).toBeGreaterThanOrEqual(44);
	}
});

test('the site tree is not reachable on the app host, encoded or not', async ({ page }) => {
	for (const path of [
		'/site',
		'/site/privasi',
		'/%73ite/privasi',
		'/site%2Fblog',
		'/site.html',
		'/site/blog.html',
		'/blog',
		'/pasang',
		'/en',
		'/sitemap.xml'
	]) {
		const res = await page.goto(path);
		expect(res?.status(), path).toBe(404);
	}
});

test('app routes are not reachable on the site host', async ({ page }) => {
	for (const path of ['/riwayat', '/pengaturan/instal', '/masuk', '/%72iwayat', '/en/riwayat']) {
		const res = await page.goto(`${SITE}${path}`);
		expect(res?.status(), path).toBe(404);
	}
});

test('unknown site paths render the 404 inside the site layout', async ({ page }) => {
	const res = await page.goto(`${SITE}/nope`);
	expect(res?.status()).toBe(404);
	await expect(page.getByRole('link', { name: 'Mulai gratis' })).toBeVisible();
	await expect(page.getByText('Halaman tidak ditemukan.')).toBeVisible();
});

test('the app host still 404s on its internal not-found path', async ({ page }) => {
	const res = await page.goto('/__not_found');
	expect(res?.status()).toBe(404);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`every public page fits 360 px in ${colorScheme}`, async ({ browser }) => {
		const context = await browser.newContext({
			storageState: SIGNED_OUT,
			colorScheme,
			viewport: { width: 360, height: 780 }
		});
		const page = await context.newPage();
		const csp = collectCspViolations(page);
		for (const path of [
			'/',
			'/blog',
			'/blog/email-qris-jadi-transaksi',
			'/pasang',
			'/privasi',
			'/en/ketentuan',
			'/hapus-akun'
		]) {
			await page.goto(`${SITE}${path}`);
			await expectNoHorizontalScroll(page);
		}
		const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		expect(bg).toBe(colorScheme === 'dark' ? 'rgb(17, 17, 18)' : 'rgb(255, 255, 255)');
		expect(csp).toEqual([]);
		await context.close();
	});
}
