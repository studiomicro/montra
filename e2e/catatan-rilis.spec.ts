import { readdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	SITE_ORIGIN,
	STORAGE_STATE,
	waitForHydration
} from './helpers';
import { addWallet, freshUser } from './ledger';
import { queueOneBlocked } from './offline-queue';

/** FN-42b: the changelog page and the one-time "Baru di Montra" notice. */

const KEY = 'montra-last-seen-version';
const NOTE_PAIRS = readdirSync('src/lib/content/release-notes').length / 2;

const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);
const store = (page: Page, value: string) =>
	page.evaluate(([key, v]) => localStorage.setItem(key!, v!), [KEY, value]);
const runningVersion = async (page: Page) =>
	((await (await page.request.get(`${APP_ORIGIN}/api/v1/health`)).json()) as { version: string })
		.version;
const notice = (page: Page) => page.getByRole('status').filter({ hasText: 'Baru di Montra' });

test.describe('Catatan rilis (FN-42b)', () => {
	test('without JavaScript at 360 px: H1, one H2 per release with its date, a 44 px back link to Tentang', async ({
		browser
	}) => {
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			javaScriptEnabled: false,
			viewport: { width: 360, height: 780 }
		});
		const page = await context.newPage();
		const csp = collectCspViolations(page);
		await page.goto(`${APP_ORIGIN}/pengaturan/tentang/catatan-rilis`);
		await expect(page.getByRole('heading', { level: 1, name: 'Catatan rilis' })).toBeVisible();
		await expect(page.getByRole('heading', { level: 2 })).toHaveCount(NOTE_PAIRS);
		await expect(page.locator('main article time')).toHaveCount(NOTE_PAIRS);
		await expect(page.getByRole('heading', { level: 3 })).toHaveCount(0);
		await expect(page.getByText('Versi kamu')).toHaveCount(1);
		await expectNoHorizontalScroll(page);
		expect(csp).toEqual([]);
		const back = page.getByRole('link', { name: 'Kembali ke Tentang Montra' });
		expect((await back.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
		await back.click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/tentang`);
		await expect(page.getByRole('heading', { level: 1, name: 'Tentang Montra' })).toBeVisible();
		await context.close();
	});

	test('signed out, the page sends you to /masuk', async ({ browser }) => {
		const context = await browser.newContext({ storageState: SIGNED_OUT });
		const page = await context.newPage();
		await page.goto(`${APP_ORIGIN}/pengaturan/tentang/catatan-rilis`);
		await expect(page).toHaveURL(/\/masuk/);
		await context.close();
	});
});

test.describe('Baru di Montra (FN-42b)', () => {
	test('never on a first load; once after an update; "Tutup" hides it and focus lands on <main>', async ({
		browser
	}, testInfo) => {
		const { context, page } = await freshUser(browser, testInfo, 'fn42b');
		const version = await runningVersion(page);
		await waitForHydration(page);
		await expect(notice(page)).toHaveCount(0);
		await expect.poll(() => stored(page)).toBe(version);

		await store(page, '0.1.0');
		await page.reload();
		await waitForHydration(page);
		const card = notice(page);
		await expect(card).toBeVisible();
		await expect(card.getByText(`Baru di Montra ${version}`)).toBeVisible();
		await expect(card.getByRole('listitem').first()).toBeVisible();
		await expect(card.getByRole('link', { name: 'Lihat semua catatan rilis' })).toHaveAttribute(
			'href',
			'/pengaturan/tentang/catatan-rilis'
		);
		const close = card.getByRole('button', { name: 'Tutup' });
		expect((await close.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
		expect(await stored(page)).toBe(version);
		await expectNoHorizontalScroll(page);

		// Seen when shown: the next load shows nothing, dismissed or not.
		await page.reload();
		await waitForHydration(page);
		await expect(notice(page)).toHaveCount(0);

		await store(page, '0.1.0');
		await page.reload();
		await waitForHydration(page);
		await notice(page).getByRole('button', { name: 'Tutup' }).click();
		await expect(notice(page)).toHaveCount(0);
		expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');

		// The link leads to the changelog, where the notice never shows.
		await store(page, '0.1.0');
		await page.reload();
		await waitForHydration(page);
		await notice(page).getByRole('link', { name: 'Lihat semua catatan rilis' }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/tentang/catatan-rilis`);
		await expect(page.getByRole('heading', { level: 1, name: 'Catatan rilis' })).toBeVisible();
		await expect(notice(page)).toHaveCount(0);
		await context.close();
	});

	test('a newer stored version shows nothing; blocked storage loads the app without notice or error', async ({
		browser
	}) => {
		const context = await browser.newContext({ storageState: STORAGE_STATE });
		const page = await context.newPage();
		await page.goto('/');
		await waitForHydration(page);
		const version = await runningVersion(page);
		await store(page, '99.0.0');
		await page.reload();
		await waitForHydration(page);
		await expect(notice(page)).toHaveCount(0);
		expect(await stored(page)).toBe(version);
		await context.close();

		const blocked = await browser.newContext({ storageState: STORAGE_STATE });
		await blocked.addInitScript(() => {
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				get() {
					throw new DOMException('blocked', 'SecurityError');
				}
			});
		});
		const page2 = await blocked.newPage();
		const errors: string[] = [];
		page2.on('pageerror', (e) => errors.push(e.message));
		page2.on('console', (m) => {
			if (m.type() === 'error') errors.push(m.text());
		});
		await page2.goto('/');
		await waitForHydration(page2);
		await expect(page2.locator('main')).toBeVisible();
		await expect(notice(page2)).toHaveCount(0);
		expect(errors).toEqual([]);
		await blocked.close();
	});

	test('never on /masuk, the marketing site or the two Tentang pages (visiting them counts as seen)', async ({
		browser
	}) => {
		const out = await browser.newContext({ storageState: SIGNED_OUT });
		const outPage = await out.newPage();
		await outPage.goto(`${APP_ORIGIN}/masuk`);
		await waitForHydration(outPage);
		await store(outPage, '0.1.0');
		await outPage.reload();
		await waitForHydration(outPage);
		await expect(outPage.getByText('Baru di Montra')).toHaveCount(0);
		expect(await stored(outPage)).toBe('0.1.0');
		// The marketing site is prerendered and may not hydrate: wait for the load instead.
		await outPage.goto(`${SITE_ORIGIN}/`);
		await store(outPage, '0.1.0');
		await outPage.reload({ waitUntil: 'load' });
		await expect(outPage.getByRole('heading', { level: 1 })).toBeVisible();
		await expect(outPage.getByText('Baru di Montra')).toHaveCount(0);
		await out.close();

		const context = await browser.newContext({ storageState: STORAGE_STATE });
		const page = await context.newPage();
		await page.goto('/pengaturan/tentang');
		await waitForHydration(page);
		const version = await runningVersion(page);
		for (const path of ['/pengaturan/tentang', '/pengaturan/tentang/catatan-rilis']) {
			await store(page, '0.1.0');
			await page.goto(path);
			await waitForHydration(page);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			await expect(notice(page)).toHaveCount(0);
			await expect.poll(() => stored(page)).toBe(version);
		}
		// Seen there, so Beranda shows nothing either.
		await page.goto('/');
		await waitForHydration(page);
		await expect(notice(page)).toHaveCount(0);
		await context.close();
	});

	test('with the notice open the offline-queue status stays visible and tappable beneath it', async ({
		browser
	}, testInfo) => {
		test.setTimeout(90_000);
		const { context, page } = await freshUser(browser, testInfo, 'fn42bq');
		await addWallet(page, 'BCA');
		await queueOneBlocked(context, page, 'Kopi di bawah kabar baru');
		await store(page, '0.1.0');
		await page.goto('/');
		await waitForHydration(page);
		const card = notice(page);
		await expect(card).toBeVisible();
		const pill = page.locator('main button[aria-haspopup="dialog"]');
		await expect(pill).toBeVisible();
		const [cardBox, pillBox] = [await card.boundingBox(), await pill.boundingBox()];
		expect(pillBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height);
		await expectNoHorizontalScroll(page);
		await pill.click();
		await expect(page.getByRole('dialog', { name: 'Perubahan menunggu' })).toBeVisible();
		await context.close();
	});
});
