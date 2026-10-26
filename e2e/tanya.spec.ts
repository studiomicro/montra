import { expect, test } from '@playwright/test';
import { APP_ORIGIN, STORAGE_STATE, waitForHydration } from './helpers.ts';

// FN-22 QA cycle 1: /tanya on a server without an AI Gateway (no real or stubbed provider is reachable here).

test('/tanya at phone width has no horizontal scroll and a disabled, labelled composer', async ({
	page
}) => {
	await page.goto('/tanya');
	await expect(page.getByRole('heading', { level: 1, name: 'Tanya' })).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
	await expect(
		page.getByRole('main').getByRole('textbox', { name: 'Pertanyaanmu' })
	).toBeDisabled();
	// headings never skip: no h3 without an h2 above it
	const levels = await page
		.locator('main h1, main h2, main h3, main h4')
		.evaluateAll((els) => els.map((e) => Number(e.tagName[1])));
	for (let i = 1; i < levels.length; i++)
		expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
});

test('/tanya renders without JavaScript and in English via the lang cookie', async ({
	browser
}) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: STORAGE_STATE
	});
	await context.addCookies([{ name: 'lang', value: 'en', url: APP_ORIGIN }]);
	const page = await context.newPage();
	await page.goto(`${APP_ORIGIN}/tanya`);
	await expect(page.getByRole('heading', { level: 1, name: 'Ask' })).toBeVisible();
	await expect(
		page.getByRole('main').getByText('The AI assistant is not set up yet.')
	).toBeVisible();
	await context.close();
});

test('FN-54: a prefilled question is marked as not sent, and leaves the address bar once loaded', async ({
	page
}) => {
	const q = 'Bulan lalu habis berapa buat kopi?';
	await page.goto(`/tanya?q=${encodeURIComponent(q)}`);
	await waitForHydration(page);
	const composer = page.getByRole('textbox', { name: 'Pertanyaanmu' });
	await expect(composer).toHaveValue(q);
	await expect(
		page.getByText('Pertanyaan ini diisi dari tautan. Belum ada yang dikirim.')
	).toBeVisible();
	// Red team L1: the question is removed from the URL (and so from history) after the page has it.
	await expect(page).toHaveURL(/\/tanya$/);
	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Pertanyaanmu' })).toHaveValue('');
	await expect(
		page.getByText('Pertanyaan ini diisi dari tautan. Belum ada yang dikirim.')
	).toHaveCount(0);
});
