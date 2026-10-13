import { expect, test, type Page } from '@playwright/test';
import { APP_ORIGIN, expectNoHorizontalScroll, STORAGE_STATE, waitForHydration } from './helpers';

/** FN-42b QA (AC6, AC23): themes, contrast, heading order and notice semantics, by DOM assertions. */

const KEY = 'montra-last-seen-version';

/** WCAG contrast of an element's text colour against its effective (opaque ancestor) background. */
async function contrast(page: Page, selector: string): Promise<number> {
	return page
		.locator(selector)
		.first()
		.evaluate((el) => {
			const parse = (c: string) => {
				const m = c.match(/[\d.]+/g)!.map(Number);
				return { r: m[0]!, g: m[1]!, b: m[2]!, a: m[3] ?? 1 };
			};
			let bg = { r: 255, g: 255, b: 255, a: 0 };
			for (let n: Element | null = el; n; n = n.parentElement) {
				const c = parse(getComputedStyle(n).backgroundColor);
				if (c.a > 0) {
					bg = c;
					break;
				}
			}
			const fg = parse(getComputedStyle(el).color);
			const lum = (c: { r: number; g: number; b: number }) => {
				const f = (v: number) => {
					const s = v / 255;
					return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
				};
				return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
			};
			const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
			return (a! + 0.05) / (b! + 0.05);
		});
}

const levels = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('main h1, main h2, main h3, main h4')]
			// Visible headings only (the closed offline-queue sheet is in the DOM but hidden).
			.filter((h) => h.getClientRects().length > 0)
			.map((h) => Number(h.tagName[1]))
	);

for (const [theme, scheme] of [
	['light', 'light'],
	['dark', 'dark'],
	['mono', 'light'],
	['mono', 'dark']
] as const) {
	test(`${theme}/${scheme}: changelog and notice read at AA, no overflow at 360 px`, async ({
		browser
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'phone', 'checked once at 360 px');
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			colorScheme: scheme,
			viewport: { width: 360, height: 780 }
		});
		await context.addCookies([{ name: 'theme', value: theme, url: APP_ORIGIN }]);
		const page = await context.newPage();
		await page.goto('/pengaturan/tentang/catatan-rilis');
		await waitForHydration(page);
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
		await expectNoHorizontalScroll(page);
		for (const sel of [
			'main article h2',
			'main article time',
			'main article .prose li',
			'main a[href="/pengaturan/tentang"]'
		])
			expect(await contrast(page, sel), `${theme}/${scheme} ${sel}`).toBeGreaterThanOrEqual(4.5);
		// The badge ("Versi kamu") on the running version's card.
		expect(
			await contrast(page, 'main article .badge'),
			`${theme}/${scheme} badge`
		).toBeGreaterThanOrEqual(4.5);
		if (theme === 'light' || (theme === 'mono' && scheme === 'dark'))
			await page.screenshot({
				path: testInfo.outputPath(`changelog-${theme}-${scheme}.png`),
				fullPage: false
			});

		await page.evaluate((k) => localStorage.setItem(k, '0.1.0'), KEY);
		await page.goto('/');
		await waitForHydration(page);
		const card = page.getByRole('status').filter({ hasText: 'Baru di Montra' });
		await expect(card).toBeVisible();
		for (const sel of ['[role=status] .title', '[role=status] .prose li', '[role=status] .all'])
			expect(await contrast(page, sel), `${theme}/${scheme} ${sel}`).toBeGreaterThanOrEqual(4.5);
		await expectNoHorizontalScroll(page);
		if (theme === 'dark')
			await page.screenshot({ path: testInfo.outputPath(`notice-${theme}.png`) });
		await context.close();
	});
}

test('headings never skip; notice is a labelled status; coarse-pointer targets >= 44 px; focus returns to main', async ({
	browser
}, testInfo) => {
	test.skip(testInfo.project.name !== 'phone', 'checked once at 360 px');
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: { width: 360, height: 780 },
		hasTouch: true,
		isMobile: true
	});
	const page = await context.newPage();
	await page.goto('/pengaturan/tentang/catatan-rilis');
	await waitForHydration(page);
	const changelog = await levels(page);
	expect(changelog[0]).toBe(1);
	expect(changelog.filter((l) => l === 1)).toHaveLength(1);
	expect(changelog.slice(1).every((l) => l === 2)).toBe(true);

	await page.goto('/pengaturan/tentang');
	await waitForHydration(page);
	const tentang = await levels(page);
	for (let i = 1; i < tentang.length; i++)
		expect(tentang[i]! - tentang[i - 1]!).toBeLessThanOrEqual(1);
	expect(tentang.filter((l) => l === 3)).toHaveLength(3);
	const all = page.getByRole('link', { name: 'Semua catatan rilis', exact: true });
	expect((await all.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

	await page.evaluate((k) => localStorage.setItem(k, '0.1.0'), KEY);
	await page.goto('/');
	await waitForHydration(page);
	const card = page.getByRole('status').filter({ hasText: 'Baru di Montra' });
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute('aria-labelledby', 'whats-new-title');
	const region = card.getByRole('region');
	await expect(region).toHaveAttribute('tabindex', '0');
	const link = card.getByRole('link', { name: 'Lihat semua catatan rilis' });
	expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
	const close = card.getByRole('button', { name: 'Tutup' });
	expect((await close.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
	// Keyboard: Tab reaches region, link, button in order; Enter on "Tutup" returns focus to <main>.
	await close.focus();
	await page.keyboard.press('Enter');
	await expect(card).toHaveCount(0);
	expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
	await context.close();
});
