import { expect, test, type Page } from '@playwright/test';
import {
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	tickSignUpBoxes,
	waitForHydration
} from './helpers';
import { addWallet, BASE, ids, PASSWORD, postExpense } from './ledger';

/**
 * ios-responsive guard (owner request 2026-10-10): the key screens on WebKit (the closest engine to iOS Safari) at
 * the iPhone SE (375 px) and iPhone 15 Pro Max (430 px) sizes — see the `ios-se` and `ios-pro-max` projects in
 * playwright.config.ts, which run only this file — plus iPhone 17 / 17 Pro / 18 Pro (402 px, and 874 px turned) and
 * iPhone Duo (466 px folded, 626 px and 890 px unfolded; owner request 2026-10-26), and the Galaxy Z Fold on Chromium
 * (the `android-*` projects: Fold 7 cover 360 px, Fold 7 and Fold 6 unfolded 984 and 928 px). Each signs up its own fictional user with long names and a very
 * long rupiah amount, then on every screen asserts: no horizontal scroll, the last list item and every primary
 * button clear of the floating tab bar and the round Tambah button, the tab bar above the home indicator, and a
 * sticky title below the notch. Insets are emulated through the `--sai-*` variables (WebKit cannot fake `env()`).
 * Not covered here, and only a real iPhone can tell: the software keyboard, Dynamic Island and rubber-banding.
 */
const INSETS: Record<string, { top: number; right: number; bottom: number; left: number }> = {
	// iPhone SE has no notch and a home button; the Pro Max has a Dynamic Island and a home indicator.
	'ios-se': { top: 0, right: 0, bottom: 0, left: 0 },
	'ios-pro-max': { top: 47, right: 0, bottom: 34, left: 0 },
	// iPhone 17 / 17 Pro / 18 Pro: Dynamic Island on top upright, on the left or right when turned.
	'ios-17': { top: 62, right: 0, bottom: 34, left: 0 },
	'ios-17-landscape': { top: 0, right: 62, bottom: 21, left: 62 },
	// iPhone Duo: insets not published yet; emulated with the Pro Max's values (upright) and a home indicator
	// (turned) until a real device is measured.
	'ios-duo-folded': { top: 47, right: 0, bottom: 34, left: 0 },
	'ios-duo-open': { top: 47, right: 0, bottom: 34, left: 0 },
	'ios-duo-open-landscape': { top: 24, right: 0, bottom: 20, left: 0 },
	// Galaxy Z Fold in Android Chrome: the browser's own bars sit outside the page, so no insets reach it.
	'android-fold7-cover': { top: 0, right: 0, bottom: 0, left: 0 },
	'android-fold7-open': { top: 0, right: 0, bottom: 0, left: 0 },
	'android-fold6-open': { top: 0, right: 0, bottom: 0, left: 0 }
};

/** Pages whose body splits into two columns on the 860 – 1023 px tablet tier (app +layout.svelte). */
const TWO_COLUMN_SCREENS = ['/', '/dompet', '/anggaran', '/laporan', '/impor'];

const SCREENS = [
	'/',
	'/riwayat',
	'/riwayat/baru',
	'/dompet',
	'/anggaran',
	'/laporan',
	'/langganan',
	'/kotak-masuk',
	'/impor',
	'/pengaturan',
	'/tanya'
];

const LONG_WALLET = 'BCA Tabungan Utama Keluarga Besar Jakarta Selatan';
const LONG_TITLE =
	'Pembelian Peralatan Elektronik dan Perabotan Rumah Tangga di Toko Serba Ada Sentosa Abadi Jaya Makmur';

async function setInsets(
	page: Page,
	v: { top: number; right: number; bottom: number; left: number }
) {
	await page.evaluate((v) => {
		const root = document.documentElement.style;
		root.setProperty('--sai-top', `${v.top}px`);
		root.setProperty('--sai-right', `${v.right}px`);
		root.setProperty('--sai-bottom', `${v.bottom}px`);
		root.setProperty('--sai-left', `${v.left}px`);
	}, v);
}

/** What sits under the floating bars once the page is scrolled to its end. */
async function coverage(page: Page) {
	return page.evaluate(() => {
		const shown = (el: Element) =>
			(el as HTMLElement).checkVisibility({
				checkVisibilityCSS: true,
				contentVisibilityAuto: true
			}) && el.getBoundingClientRect().width > 1;
		const bars = [...document.querySelectorAll('nav.tabbar, button.fab')]
			.filter(shown)
			.map((el) => el.getBoundingClientRect());
		const top = Math.min(...bars.map((r) => r.top));
		const covered = (r: DOMRect) =>
			bars.some(
				(b) => r.bottom > b.top && r.top < b.bottom && r.right > b.left && r.left < b.right
			);
		const items = [...document.querySelectorAll('main li')].filter(
			(el) => !el.closest('dialog') && shown(el)
		);
		const last = items.at(-1)?.getBoundingClientRect();
		const primary = [...document.querySelectorAll('main .btn.primary')]
			.filter((el) => !el.closest('dialog') && shown(el))
			.map((el) => ({ name: (el.textContent ?? '').trim(), rect: el.getBoundingClientRect() }));
		return {
			barTop: top,
			vh: window.innerHeight,
			barBottomGap: window.innerHeight - Math.max(...bars.map((r) => r.bottom)),
			lastItemBottom: last ? Math.round(last.bottom) : null,
			lastItemCovered: last ? covered(last) : false,
			coveredPrimary: primary.filter((p) => covered(p.rect)).map((p) => p.name)
		};
	});
}

test.describe('iPhone and Galaxy Z Fold layout', () => {
	test.use({ storageState: SIGNED_OUT });

	test('key screens: no horizontal scroll, nothing under the tab bar or the notch', async ({
		page,
		browserName
	}, testInfo) => {
		const android = testInfo.project.name.startsWith('android-');
		test.skip(
			browserName !== (android ? 'chromium' : 'webkit'),
			android ? 'Chromium only' : 'WebKit only'
		);
		test.setTimeout(180_000);
		const insets = INSETS[testInfo.project.name]!;
		await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': simulatedClientIp(testInfo) });

		// A fresh user with a long wallet name, a long merchant name and a very long rupiah amount.
		await page.goto('/daftar');
		await waitForHydration(page);
		await page.getByLabel('Nama').fill('Pencatat Panjang Sekali Namanya');
		await page
			.getByLabel('E-mail')
			.fill(`ios-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await page.waitForURL(`${BASE}/`);
		// FN-54: the once-a-day greeting sheet would cover Beranda (e2e/sapaan.spec.ts tests it).
		await page.context().addCookies([{ name: 'montra-sapaan-off', value: '1', url: BASE }]);
		await addWallet(page, LONG_WALLET, '1.264.000.000');
		await addWallet(page, 'Tunai', '250.000');
		const { wallet, category } = await ids(page);
		const walletId = await wallet('BCA');
		const makan = await category('Makan');
		await postExpense(page, {
			walletId,
			categoryId: makan,
			amount: '1.264.000.000',
			title: LONG_TITLE
		});
		for (const [i, title] of [
			'Kopi',
			'Nasi padang',
			'Gojek',
			'Netflix',
			'Listrik',
			'Parkir'
		].entries())
			await postExpense(page, {
				walletId,
				categoryId: makan,
				amount: `${(i + 1) * 12}.500`,
				title: `${title} ${LONG_TITLE.slice(0, 40)}`
			});

		for (const path of SCREENS) {
			await test.step(path, async () => {
				await page.goto(path);
				await waitForHydration(page);
				await setInsets(page, insets);
				await expectNoHorizontalScroll(page);

				// The tab bar: four 44 px icon tabs bottom-left, the round Tambah button bottom-right, both above
				// the home indicator.
				const links = page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('link');
				await expect(links).toHaveCount(4);
				for (const box of await Promise.all((await links.all()).map((l) => l.boundingBox()))) {
					expect(box!.width, `${path} tab width`).toBeGreaterThanOrEqual(44);
					expect(box!.height, `${path} tab height`).toBeGreaterThanOrEqual(44);
				}
				const fab = (await page
					.getByRole('button', { name: 'Tambah', exact: true })
					.boundingBox())!;
				expect(fab.width).toBeGreaterThanOrEqual(44);

				await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
				await page.waitForTimeout(150);
				const c = await coverage(page);
				expect(c.barBottomGap, `${path} bars above the home indicator`).toBeGreaterThanOrEqual(
					insets.bottom
				);
				expect(c.lastItemCovered, `${path}: last list item under the bars`).toBe(false);
				expect(c.coveredPrimary, `${path}: primary buttons under the bars`).toEqual([]);
				await expectNoHorizontalScroll(page);
			});
		}

		await test.step('tablet tier: two-column pages show both columns; narrower screens stack them', async () => {
			const width = page.viewportSize()!.width;
			for (const path of TWO_COLUMN_SCREENS) {
				await page.goto(path);
				await waitForHydration(page);
				const columns = await page
					.locator('main .two-col')
					.first()
					.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
				expect(columns, `${path} at ${width} px`).toBe(width >= 860 ? 2 : 1);
			}
		});

		await test.step('sticky title stays below the top inset', async () => {
			await page.goto('/riwayat');
			await waitForHydration(page);
			await setInsets(page, insets);
			await page.evaluate(() => window.scrollTo(0, 400));
			await expect
				.poll(async () => (await page.locator('header.screen-title').boundingBox())!.y)
				.toBeGreaterThanOrEqual(insets.top);
		});

		await test.step('the Tambah sheet is never taller than the screen and does not scroll the page sideways', async () => {
			await page.goto('/');
			await waitForHydration(page);
			await setInsets(page, insets);
			await page.getByRole('button', { name: 'Tambah', exact: true }).click();
			const dialog = page.locator('dialog[open]');
			await expect(dialog).toBeVisible();
			const box = (await dialog.boundingBox())!;
			const vh = page.viewportSize()!.height;
			expect(box.y).toBeGreaterThanOrEqual(insets.top);
			expect(box.y + box.height).toBeLessThanOrEqual(vh);
			await expectNoHorizontalScroll(page);
		});
	});
});
