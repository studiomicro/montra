import { expect, test } from '@playwright/test';
import {
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	STORAGE_STATE,
	waitForHydration,
	APP_ORIGIN
} from './helpers';

/** Each tab: its page heading, and its link in the phone tab bar / the desktop sidebar (APP_PARITY § 1). */
const TABS = [
	{ path: '/', title: 'Beranda', phone: 'Beranda', desktop: 'Ringkasan' },
	{ path: '/riwayat', title: 'Transaksi', phone: 'Riwayat', desktop: 'Transaksi' },
	{ path: '/laporan', title: 'Laporan', phone: 'Laporan', desktop: 'Laporan' },
	{ path: '/dompet', title: 'Dompet', phone: 'Dompet', desktop: 'Dompet' }
];

for (const tab of TABS) {
	test(`${tab.title} renders with active nav and no overflow`, async ({ page }) => {
		const csp = collectCspViolations(page);
		await page.goto(tab.path);
		await waitForHydration(page);
		await expect(page.getByRole('heading', { level: 1, name: tab.title })).toBeVisible();
		const nav = page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });
		const name = isPhone(page) ? tab.phone : tab.desktop;
		await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute(
			'aria-current',
			'page'
		);
		// Exactly one entry claims the page.
		await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
		await expectNoHorizontalScroll(page);
		expect(csp).toEqual([]);
	});
}

test('<html> is marked hydrated only by the hydrated root layout', async ({ page }) => {
	// The server-rendered page never carries the mark.
	expect(await (await page.request.get('/')).text()).not.toContain('data-hydrated');
	await page.goto('/');
	await waitForHydration(page);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	// Right after the wait a client-side link is handled by the router: no full document load.
	const nav = page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });
	const loads: string[] = [];
	page.on('load', () => loads.push(page.url()));
	await nav
		.getByRole('link', { name: isPhone(page) ? 'Riwayat' : 'Transaksi', exact: true })
		.click();
	await expect(page.getByRole('heading', { level: 1, name: 'Transaksi' })).toBeVisible();
	expect(loads).toEqual([]);
});

test('phone shows the tab bar with 44 px targets; desktop shows the sidebar', async ({ page }) => {
	await page.goto('/');
	const nav = page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });
	await expect(nav).toHaveCount(1);
	const links = nav.getByRole('link');
	if (isPhone(page)) {
		await expect(links).toHaveCount(4);
		for (const box of await Promise.all((await links.all()).map((l) => l.boundingBox()))) {
			expect(box!.height).toBeGreaterThanOrEqual(44);
			expect(box!.width).toBeGreaterThanOrEqual(44);
		}
		// Settings has no tab: Beranda's top bar carries the gear the sidebar shows on desktop.
		const gear = page
			.getByRole('link', { name: 'Pengaturan', exact: true })
			.filter({ visible: true });
		await expect(gear).toHaveAttribute('href', '/pengaturan');
		const box = (await gear.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
		await gear.click();
		await expect(page).toHaveURL(/\/pengaturan$/);
	} else {
		// Sections Uang (5, Anggaran since wave C), Fitur (Jelajahi fitur + 5 modules incl. Patungan FN-49 + Alur uang,
		// FN-35, + Agen), Catat (3); plus wordmark, notifications,
		// settings, the space card, the plan card, the account row and Tanya (FN-22).
		for (const section of ['Uang', 'Fitur', 'Catat'])
			await expect(nav.getByText(section, { exact: true })).toBeVisible();
		await expect(links).toHaveCount(5 + 8 + 3 + 7);
		await expect(nav.getByRole('link', { name: /Punya voucher/ })).toHaveAttribute(
			'href',
			'/pengaturan/paket'
		);
		// FN-22: the assistant entry is a real link; /tanya says why it cannot answer on this server.
		await expect(nav.getByRole('link', { name: /Tanya/ })).toHaveAttribute('href', '/tanya');
	}
});

test('at 360 px the tab bar is a bottom-left pill of four icon tabs and Tambah a round button at the bottom-right', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 360, height: 780 },
		hasTouch: true,
		storageState: STORAGE_STATE
	});
	const page = await context.newPage();
	await page.goto(`${APP_ORIGIN}/`);
	await waitForHydration(page);
	const nav = page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });
	const cells = nav.locator(':scope > a');
	await expect(cells).toHaveCount(4);
	// Icons only: each tab is named by its aria-label and shows no text.
	for (const [i, name] of ['Beranda', 'Riwayat', 'Laporan', 'Dompet'].entries()) {
		await expect(cells.nth(i)).toHaveAttribute('aria-label', name);
		await expect(cells.nth(i)).toHaveText('');
	}
	const boxes = await Promise.all((await cells.all()).map((c) => c.boundingBox()));
	for (const box of boxes) {
		expect(box!.height).toBeGreaterThanOrEqual(44);
		expect(Math.abs(box!.width - boxes[0]!.width)).toBeLessThanOrEqual(1);
	}
	const bar = (await nav.boundingBox())!;
	const fab = page.getByRole('button', { name: 'Tambah' }).filter({ visible: true });
	const fabBox = (await fab.boundingBox())!;
	// The pill hugs the left edge, the round button the right; they never overlap, both stay in the viewport.
	expect(bar.x).toBeLessThanOrEqual(20);
	expect(360 - (fabBox.x + fabBox.width)).toBeLessThanOrEqual(20);
	expect(bar.x + bar.width).toBeLessThan(fabBox.x);
	expect(fabBox.width).toBeGreaterThanOrEqual(44);
	expect(fabBox.height).toBeGreaterThanOrEqual(44);
	await expectNoHorizontalScroll(page);
	await nav.getByRole('link', { name: 'Dompet' }).click();
	await page.waitForURL(`${APP_ORIGIN}/dompet`);
	await expect(nav.getByRole('link', { name: 'Dompet' })).toHaveAttribute('aria-current', 'page');
	await context.close();
});

test('N opens the Tambah sheet outside text fields, never while typing', async ({ page }) => {
	await page.goto('/');
	await waitForHydration(page);
	const dialog = page.getByRole('dialog', { name: 'Tambah transaksi' });
	await page.keyboard.press('n');
	await expect(dialog).toBeVisible();
	// A second N while the sheet is open changes nothing; Escape closes it.
	await page.keyboard.press('n');
	await expect(dialog).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	// Modified presses are the browser's (Ctrl+N), not ours.
	await page.keyboard.press('Control+n');
	await expect(dialog).toBeHidden();

	await page.goto('/riwayat');
	await waitForHydration(page);
	const search = page.getByLabel('Cari judul atau catatan');
	await search.click();
	await page.keyboard.type('nasi');
	await expect(search).toHaveValue('nasi');
	await expect(dialog).toBeHidden();
});

test('Tambah sheet opens, lists the capture paths, closes with Esc and returns focus', async ({
	page
}) => {
	await page.goto('/');
	await waitForHydration(page);
	const add = page.getByRole('button', { name: 'Tambah' }).filter({ visible: true });
	await add.click();
	const dialog = page.getByRole('dialog', { name: 'Tambah transaksi' });
	await expect(dialog).toBeVisible();
	for (const name of ['Struk']) {
		await expect(dialog.getByRole('button', { name: new RegExp(name) })).toBeDisabled();
	}
	// FN-15: this e2e server has no AI Gateway, so Struk says why instead of "Segera hadir".
	await expect(dialog.getByRole('button', { name: /Struk/ })).toHaveAccessibleDescription(
		'Pembacaan struk dengan AI belum dikonfigurasi.'
	);
	// FN-19: no INBOUND_EMAIL_DOMAIN on this server, so Otomatis is a disabled row that says why.
	const otomatis = dialog.getByRole('button', { name: /Otomatis/ });
	await expect(otomatis).toBeDisabled();
	await expect(otomatis).toHaveAccessibleDescription(
		'Alamat penerusan e-mail belum dikonfigurasi.'
	);
	await expect(otomatis).not.toContainText('Segera hadir');
	// FN-14: Suara is a real path; recording starts as soon as it opens.
	await expect(dialog.getByRole('link', { name: /Suara/ })).toHaveAttribute(
		'href',
		'/riwayat/suara?mulai=1'
	);
	// FN-16a: Mutasi opens the statement section of Impor.
	await expect(dialog.getByRole('link', { name: /Mutasi/ })).toHaveAttribute(
		'href',
		'/impor#mutasi'
	);
	// FN-05: manual entry is a real path.
	await expect(dialog.getByRole('link', { name: /Ketik manual/ })).toHaveAttribute(
		'href',
		'/riwayat/baru'
	);
	// Every capture path is built: none says "Segera hadir" any more.
	await expect(dialog.getByText('Segera hadir')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(add).toBeFocused();
});

test('Tambah sheet closes with the close button', async ({ page }) => {
	await page.goto('/riwayat');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Tambah' }).filter({ visible: true }).click();
	await page.getByRole('button', { name: 'Tutup' }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
});

test('Tanya says why it is unavailable without an AI Gateway (FN-22)', async ({ page }) => {
	await page.goto('/tanya');
	await expect(page.getByRole('heading', { level: 1, name: 'Tanya' })).toBeVisible();
	const main = page.getByRole('main');
	// This e2e server has no AI Gateway: the composer is off and says why; there is no stub any more.
	await expect(main.getByText('Asisten AI belum dikonfigurasi.')).toBeVisible();
	await expect(main.getByRole('textbox', { name: 'Pertanyaanmu' })).toBeDisabled();
	await expect(
		main.getByText('Informasi dari catatanmu, bukan saran keuangan, pajak, atau hukum.')
	).toBeVisible();
	await expect(main.getByText('Segera hadir')).toHaveCount(0);
});

test('unknown routes 404', async ({ page }) => {
	const res = await page.goto('/tidak-ada');
	expect(res?.status()).toBe(404);
	await expect(page.getByText('Halaman tidak ditemukan.')).toBeVisible();
});

test('English via the lang cookie', async ({ page, context }) => {
	await context.addCookies([{ name: 'lang', value: 'en', url: APP_ORIGIN }]);
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
});

test('dark scheme follows the system; the theme cookie overrides it', async ({ browser }) => {
	const dark = await browser.newContext({ colorScheme: 'dark', storageState: STORAGE_STATE });
	const page = await dark.newPage();
	await page.goto(`${APP_ORIGIN}/`);
	const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	expect(await bg()).toBe('rgb(17, 17, 18)');
	await dark.addCookies([{ name: 'theme', value: 'light', url: APP_ORIGIN }]);
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	expect(await bg()).toBe('rgb(255, 255, 255)');
	await dark.close();
});

test('mono follows the system scheme from the one theme cookie; money keeps its colour', async ({
	browser
}) => {
	const schemes = [
		{ colorScheme: 'light', bg: 'rgb(255, 255, 255)', panel: '#f4f4f4', moneyUp: '#cf3339' },
		{ colorScheme: 'dark', bg: 'rgb(18, 18, 18)', panel: '#1d1d1d', moneyUp: '#ff6b70' }
	] as const;
	for (const scheme of schemes) {
		const context = await browser.newContext({
			colorScheme: scheme.colorScheme,
			storageState: STORAGE_STATE
		});
		await context.addCookies([{ name: 'theme', value: 'mono', url: APP_ORIGIN }]);
		const page = await context.newPage();
		await page.goto(`${APP_ORIGIN}/`);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'mono');
		const token = (name: string) =>
			page.evaluate(
				(n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
				name
			);
		expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
			scheme.bg
		);
		expect(await token('--panel')).toBe(scheme.panel);
		expect(await token('--money-up')).toBe(scheme.moneyUp);
		await context.close();
	}
});

test('glass: solid under reduced transparency and under an open sheet', async ({ page }) => {
	await page.goto('/riwayat');
	await waitForHydration(page);
	const title = page.locator('header.screen-title');
	const filter = () => title.evaluate((el) => getComputedStyle(el).backdropFilter);
	expect(await filter()).toContain('blur');
	// Under the Tambah sheet's scrim the page chrome drops its blur; the sheet itself is the glass layer.
	await page.getByRole('button', { name: 'Tambah' }).filter({ visible: true }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah transaksi' });
	await expect(sheet).toBeVisible();
	expect(await sheet.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur');
	expect(await filter()).toBe('none');
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	expect(await filter()).toContain('blur');
	// Playwright's emulateMedia has no reduced-transparency option: Chromium's DevTools protocol sets it. Clear
	// Playwright's own media emulation first (the suite's reducedMotion), or it keeps precedence over this one.
	await page.emulateMedia({ reducedMotion: null });
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setEmulatedMedia', {
		features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
	});
	expect(await filter()).toBe('none');
	expect(await title.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
		await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
	);
});

test('the sidebar theme button cycles the four choices and keeps Hitam-putih', async ({ page }) => {
	test.skip(isPhone(page), 'the sidebar shows from 1024 px');
	await page.goto('/');
	await waitForHydration(page);
	const html = page.locator('html');
	for (const [label, next] of [
		['Sistem', 'light'],
		['Terang', 'dark'],
		['Gelap', 'mono'],
		['Hitam-putih', 'system']
	] as const) {
		await page.getByRole('button', { name: `Tampilan: ${label}` }).click();
		await expect(html).toHaveAttribute('data-theme', next);
		if (next === 'mono') {
			await page.reload();
			await expect(html).toHaveAttribute('data-theme', 'mono');
			await waitForHydration(page);
		}
	}
	expect((await page.context().cookies()).find((c) => c.name === 'theme')).toBeUndefined();
});

test('pages render without JavaScript', async ({ browser }) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: STORAGE_STATE
	});
	const page = await context.newPage();
	await page.goto(`${APP_ORIGIN}/riwayat`);
	await expect(page.getByRole('heading', { level: 1, name: 'Transaksi' })).toBeVisible();
	await context.close();
});

test('the page title shrinks after a real scroll and never flickers near the top', async ({
	page
}) => {
	await page.goto('/pengaturan');
	await waitForHydration(page);
	const header = page.locator('header.screen-title');
	// A page long enough to scroll on any viewport (test-only spacer).
	await page.evaluate(() => {
		const spacer = document.createElement('div');
		spacer.style.height = '3000px';
		document.querySelector('main')!.appendChild(spacer);
	});
	const states = () =>
		page.evaluate(async () => {
			const el = document.querySelector('header.screen-title')!;
			const out: boolean[] = [];
			for (let i = 0; i < 20; i++) {
				await new Promise((r) => requestAnimationFrame(r));
				out.push(el.classList.contains('compact'));
			}
			return out;
		});
	// A few pixels down: the shrink would move the page back and forth; the title stays as it is.
	await page.evaluate(() => window.scrollTo(0, 5));
	expect(new Set(await states()).size).toBe(1);
	await page.evaluate(() => window.scrollTo(0, 400));
	await expect(header).toHaveClass(/compact/);
	expect(await states()).not.toContain(false);
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect(header).not.toHaveClass(/compact/);
});

// Sub-pages carry a 44 px chevron link back to their parent (ScreenTitle `back`), on phone and desktop.
for (const sub of [
	{ path: '/pengaturan/akun', name: 'Kembali ke Pengaturan', parent: /\/pengaturan$/ },
	{ path: '/riwayat/berulang', name: 'Kembali ke Riwayat', parent: /\/riwayat$/ }
]) {
	test(`${sub.path} has a back link to its parent`, async ({ page }) => {
		await page.goto(sub.path);
		await waitForHydration(page);
		const back = page.getByRole('link', { name: sub.name, exact: true });
		await expect(back).toBeVisible();
		const box = (await back.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
		await expectNoHorizontalScroll(page);
		await back.click();
		await expect(page).toHaveURL(sub.parent);
	});
}

test('the desktop sidebar scrolls above its bottom block: every Catat item is reachable at 1280×800', async ({
	page
}) => {
	test.skip(isPhone(page), 'the sidebar is a desktop layout');
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/');
	await waitForHydration(page);
	const nav = page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });
	const plan = nav.getByRole('link', { name: /Punya voucher/ });
	// The plan card keeps its second line (APP_PARITY § 1).
	await expect(plan.getByText('Punya voucher?')).toBeVisible();
	const planTop = (await plan.boundingBox())!.y;
	for (const name of ['Impor', 'Kotak masuk', 'Aplikasi terhubung']) {
		const item = nav.getByRole('link', { name, exact: true });
		await item.scrollIntoViewIfNeeded();
		await expect(item).toBeVisible();
		const box = (await item.boundingBox())!;
		// Fully above the plan card, not hidden under it.
		expect(box.y + box.height).toBeLessThanOrEqual(planTop + 1);
	}
});
