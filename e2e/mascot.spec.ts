import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	STORAGE_STATE,
	waitForHydration
} from './helpers';
import { addWallet, freshUser, ids, postExpense } from './ledger';

/**
 * FN-44: Koko in a real browser — theme repaint, finite motion (none under reduced motion), the placements, the
 * three success moments (only after the server confirmed the write) and the navigation indicator. Every page is
 * watched for CSP violations: Koko needs no inline style.
 */

const SHOTS = 'docs/features/fn-44-mascot/shots';
const main = (page: Page) => page.locator('main');

let cspLogs: string[][] = [];
async function open(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	cspLogs.push(collectCspViolations(page));
	return page;
}
test.beforeEach(({ page }) => {
	cspLogs = [collectCspViolations(page)];
});
test.afterEach(() => {
	expect(cspLogs.flat()).toEqual([]);
});

async function kit(browser: Browser, reducedMotion: 'reduce' | 'no-preference') {
	const context = await browser.newContext({
		reducedMotion,
		viewport: { width: 360, height: 780 },
		storageState: STORAGE_STATE
	});
	const page = await open(context);
	await page.goto(`${APP_ORIGIN}/dev/ui`);
	await waitForHydration(page);
	return { context, page };
}

const animationOf = (page: Page, selector: string) =>
	page
		.locator(selector)
		.first()
		.evaluate((el) => {
			const s = getComputedStyle(el);
			return { name: s.animationName, count: s.animationIterationCount };
		});

const POSES = ['idle', 'wave', 'hop', 'celebrate', 'sad', 'sleep'];

test.describe('Koko in the kit', () => {
	test.skip(({ isMobile }) => !isMobile, 'own contexts; one project is enough');

	test('repaints from the theme tokens in light, dark, mono-light and mono-dark', async ({
		browser
	}) => {
		const bodies: Record<string, string> = {};
		for (const [theme, colorScheme] of [
			['light', 'light'],
			['dark', 'dark'],
			['mono', 'light'],
			['mono', 'dark']
		] as const) {
			const context = await browser.newContext({ colorScheme, storageState: STORAGE_STATE });
			await context.addCookies([{ name: 'theme', value: theme, url: APP_ORIGIN }]);
			const page = await open(context);
			await page.goto(`${APP_ORIGIN}/dev/ui`);
			const koko = page.locator('[data-pose="idle"] svg');
			await expect(koko).toHaveAttribute('aria-hidden', 'true');
			const fill = (cls: string) =>
				koko
					.locator(`.${cls}`)
					.first()
					.evaluate((el) => getComputedStyle(el).fill);
			const key = `${theme}-${colorScheme}`;
			bodies[key] = await fill('k-body');
			for (const cls of [
				'k-body',
				'k-ink',
				'k-chest',
				'k-muzzle',
				'k-shade',
				'k-lit',
				'k-eye',
				'k-glint',
				'k-cheek'
			]) {
				const value = await fill(cls);
				expect(value, `${key} ${cls}`).toMatch(/^(rgb|color)\(/);
			}
			// The face reads in every theme: eyes differ from the fur, the glint from the eye, the cheeks, the sheen,
			// the muzzle and the chest's V from the fur.
			expect(await fill('k-eye'), key).not.toBe(bodies[key]);
			expect(await fill('k-glint'), key).not.toBe(await fill('k-eye'));
			expect(await fill('k-cheek'), key).not.toBe(bodies[key]);
			expect(await fill('k-lit'), key).not.toBe(bodies[key]);
			expect(await fill('k-muzzle'), key).not.toBe(bodies[key]);
			expect(await fill('k-chest'), key).not.toBe(bodies[key]);
			if (theme === 'mono') {
				const [r, g, b] = (bodies[key].match(/[\d.]+/g) ?? []).slice(-3).map(Number);
				expect(r, `${key} ${bodies[key]}`).toBeCloseTo(g!, 0);
				expect(g, `${key} ${bodies[key]}`).toBeCloseTo(b!, 0);
			}
			await page
				.locator('[data-pose]')
				.first()
				.locator('xpath=..')
				.screenshot({ path: `${SHOTS}/poses-${key}.png` });
			await context.close();
		}
		expect(new Set(Object.values(bodies)).size).toBe(4);
	});

	test('with motion every pose plays a finite number of cycles; reduced motion shows the resting frame', async ({
		browser
	}) => {
		const moving = await kit(browser, 'no-preference');
		for (const pose of POSES) {
			const a = await animationOf(moving.page, `[data-pose="${pose}"] .strip`);
			expect(a.name, pose).not.toBe('none');
			expect(Number(a.count), pose).toBeGreaterThanOrEqual(2);
			expect(Number(a.count), pose).toBeLessThanOrEqual(6);
		}
		// The loading pose has no motion of its own (only the navigation indicator walks it).
		expect((await animationOf(moving.page, '[data-pose="loading"] .strip')).name).toBe('none');
		await expectNoHorizontalScroll(moving.page);
		await moving.context.close();

		const still = await kit(browser, 'reduce');
		for (const pose of [...POSES, 'loading']) {
			expect((await animationOf(still.page, `[data-pose="${pose}"] .strip`)).name, pose).toBe(
				'none'
			);
			// Frame 0 in view: the strip is not moved.
			const transform = await still.page
				.locator(`[data-pose="${pose}"] .strip`)
				.evaluate((el) => getComputedStyle(el).transform);
			expect(transform, pose).toBe('none');
		}
		await still.context.close();
	});
});

test.describe('placements', () => {
	test('a 404 shows Koko sad above the unchanged text, decorative', async ({ page }) => {
		for (const path of ['/halaman-yang-tidak-ada', '/riwayat/tidak-ada/edit']) {
			const res = await page.goto(path);
			expect(res?.status(), path).toBe(404);
			await expect(page.getByText('Halaman tidak ditemukan.')).toBeVisible();
			const koko = page.locator('svg.mascot.pose-sad');
			await expect(koko, path).toBeVisible();
			await expect(koko).toHaveAttribute('aria-hidden', 'true');
			await expect(page.locator('svg.illustration')).toHaveCount(0);
			await expectNoHorizontalScroll(page);
		}
		if (isPhone(page)) await page.screenshot({ path: `${SHOTS}/error-404-360.png` });
	});

	test('an empty state without a scene shows Koko asleep (Pengaturan → API, no tokens)', async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn44');
		cspLogs.push(collectCspViolations(page));
		await page.goto('/pengaturan/api');
		await expect(page.getByText('Belum ada token')).toBeVisible();
		const koko = main(page).locator('svg.mascot.pose-sleep');
		await expect(koko).toBeVisible();
		await expect(koko).toHaveAttribute('aria-hidden', 'true');
		await expectNoHorizontalScroll(page);
		await context.close();
	});
});

test.describe('success moments (only after the server confirmed)', () => {
	test.skip(({ isMobile }) => !isMobile, 'one project is enough for the journeys');

	test('a new transaction: Koko hops beside "Transaksi disimpan."; an edit does not', async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn44');
		cspLogs.push(collectCspViolations(page));
		await addWallet(page, 'BCA');
		await page.goto('/riwayat/baru');
		await waitForHydration(page);
		await page.getByLabel('Jumlah').fill('25000');
		await page.getByRole('radio', { name: /Kopi/ }).check();
		// Nothing before the server answered.
		await expect(page.locator('svg.mascot.pose-hop')).toHaveCount(0);
		await page.getByRole('button', { name: 'Simpan transaksi' }).click();
		await page.waitForURL(/\/riwayat\?saved=created/);
		const status = page.getByRole('status').filter({ hasText: 'Transaksi disimpan.' });
		await expect(status).toHaveText('Transaksi disimpan.');
		const koko = status.locator('svg.mascot.pose-hop');
		await expect(koko).toBeVisible();
		await expect(koko).toHaveAttribute('aria-hidden', 'true');
		await expectNoHorizontalScroll(page);
		await page.screenshot({ path: `${SHOTS}/riwayat-saved-hop-360.png` });

		// A real edit: the notice needs the server's one-shot cookie, not just the URL (FN-44 L1).
		await main(page).locator('a[href$="/edit"]').first().click();
		await page.waitForURL(/\/riwayat\/.+\/edit$/);
		await waitForHydration(page);
		await page.getByLabel('Jumlah').fill('30000');
		await page.getByRole('button', { name: 'Simpan perubahan' }).click();
		await page.waitForURL(/\/riwayat\?saved=updated/);
		await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
		await expect(page.locator('svg.mascot.pose-hop')).toHaveCount(0);
		await context.close();
	});

	test('the voice toast: Koko hops only once the row is recorded', async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn44');
		cspLogs.push(collectCspViolations(page));
		await addWallet(page, 'BCA');
		const { wallet, category } = await ids(page);
		await postExpense(page, {
			walletId: await wallet('BCA'),
			categoryId: await category('Kopi'),
			amount: '25.000',
			title: 'Kopi susu'
		});
		await page.goto('/riwayat/suara');
		await waitForHydration(page);
		await expect(page.locator('svg.mascot.pose-hop')).toHaveCount(0);
		await main(page)
			.getByRole('region', { name: 'Catat lagi' })
			.getByRole('button', { name: /Kopi susu/ })
			.click();
		const toast = page.getByRole('status').filter({ hasText: 'Dicatat' });
		await expect(toast).toBeVisible();
		await expect(toast.locator('svg.mascot.pose-hop')).toHaveAttribute('aria-hidden', 'true');
		await expectNoHorizontalScroll(page);
		await context.close();
	});

	test('closing the day: Koko celebrates right after; a reload of the closed day does not', async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn44');
		cspLogs.push(collectCspViolations(page));
		await page.goto('/');
		await waitForHydration(page);
		const card = main(page).locator('section.today');
		await expect(card.locator('svg.mascot')).toHaveCount(0);
		await card.getByRole('button', { name: 'Tutup hari ini' }).click();
		const status = card.getByRole('status');
		await expect(status).toHaveText('Hari ini ditutup · 1 hari berturut-turut');
		const koko = status.locator('svg.mascot.pose-celebrate');
		await expect(koko).toBeVisible();
		await expect(koko).toHaveAttribute('aria-hidden', 'true');
		await expectNoHorizontalScroll(page);
		await card.screenshot({ path: `${SHOTS}/beranda-day-closed-360.png` });

		await page.reload();
		await expect(status).toHaveText('Hari ini ditutup · 1 hari berturut-turut');
		await expect(card.locator('svg.mascot')).toHaveCount(0);
		await context.close();
	});

	test('a budget save: Koko celebrates while safe-to-spend is left, never once it is over', async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn44');
		cspLogs.push(collectCspViolations(page));
		await addWallet(page, 'BCA', '5.000.000');
		const setBudget = async (amount: string) => {
			await page.goto('/anggaran?ubah=bulanan');
			await waitForHydration(page);
			const sheet = page.getByRole('dialog', { name: 'Anggaran bulanan' });
			await sheet.getByLabel('Anggaran per bulan').fill(amount);
			await sheet.getByRole('button', { name: 'Simpan' }).click();
			await expect(sheet).toBeHidden();
			return page.getByRole('status').filter({ hasText: 'Anggaran disimpan.' });
		};

		const left = await setBudget('2000000');
		await expect(left).toHaveText('Anggaran disimpan.');
		await expect(left.locator('svg.mascot.pose-celebrate')).toHaveAttribute('aria-hidden', 'true');
		await expectNoHorizontalScroll(page);
		await page.screenshot({ path: `${SHOTS}/anggaran-safe-celebrate-360.png` });

		const { wallet, category } = await ids(page);
		await postExpense(page, {
			walletId: await wallet('BCA'),
			categoryId: await category('Kopi'),
			amount: '300.000',
			title: 'Belanja besar'
		});
		const over = await setBudget('100000');
		await expect(over).toHaveText('Anggaran disimpan.');
		await expect(page.getByText('Sudah melebihi anggaran.')).toBeVisible();
		await expect(page.locator('svg.mascot.pose-celebrate')).toHaveCount(0);
		await context.close();
	});
});

test.describe('navigation indicator', () => {
	test.skip(({ isMobile }) => !isMobile, 'own contexts; one project is enough');

	for (const reducedMotion of ['no-preference', 'reduce'] as const) {
		test(`while a navigation is in flight (${reducedMotion}), then gone`, async ({ browser }) => {
			const context = await browser.newContext({
				reducedMotion,
				viewport: { width: 360, height: 780 },
				storageState: STORAGE_STATE
			});
			const page = await open(context);
			await page.goto(`${APP_ORIGIN}/`);
			await waitForHydration(page);
			await expect(page.locator('.nav-loading')).toHaveCount(0);

			let release = () => {};
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/riwayat/__data.json**', async (route) => {
				await held;
				await route.continue();
			});
			await page
				.getByRole('link', { name: 'Riwayat', exact: true })
				.filter({ visible: true })
				.first()
				.click();
			const indicator = page.locator('.nav-loading');
			await expect(indicator).toBeAttached();
			if (reducedMotion === 'reduce') {
				// Plain text only: no still mascot.
				await expect(indicator).toHaveText('Memuat…');
				await expect(indicator.locator('svg')).toBeHidden();
			} else {
				const koko = indicator.locator('svg.mascot.pose-loading');
				await expect(koko).toBeVisible();
				await expect(koko).toHaveAttribute('aria-hidden', 'true');
				const walk = await animationOf(page, '.nav-loading .strip');
				expect(walk.name).not.toBe('none');
				expect(walk.count).toBe('infinite');
				// Shown after its short delay (a quick navigation never flashes it).
				await expect.poll(() => indicator.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
				await page.screenshot({ path: `${SHOTS}/nav-loading-360.png` });
			}
			await expectNoHorizontalScroll(page);
			release();
			await page.waitForURL(`${APP_ORIGIN}/riwayat`);
			await expect(indicator).toHaveCount(0);
			await context.close();
		});
	}
});
