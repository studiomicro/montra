import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, isPhone, simulatedClientIp, waitForHydration } from './helpers';
import { addWallet, freshUser, ids, postExpense, rp } from './ledger';

/**
 * Alur uang (FN-35): the money-flow chart for one month. Each test signs up its own fictional user; setup data
 * goes through the app's own form actions. Screenshots for the engineer report go to the feature folder.
 */

const SHOTS = 'docs/features/fn-35-money-flow/shots';

/** BCA and GoPay; salary into BCA; Kopi and Makan out of BCA, Kopi out of GoPay. */
async function seed(page: Page) {
	await addWallet(page, 'BCA');
	await addWallet(page, 'GoPay');
	const { wallet, category } = await ids(page);
	const bca = await wallet('BCA');
	const gopay = await wallet('GoPay');
	await postExpense(page, {
		type: 'income',
		walletId: bca,
		categoryId: await category('Gaji'),
		amount: '9000000',
		title: 'Gaji Oktober'
	});
	const kopi = await category('Kopi');
	await postExpense(page, { walletId: bca, categoryId: kopi, amount: '25000', title: 'Kopi' });
	await postExpense(page, {
		walletId: bca,
		categoryId: await category('Makan'),
		amount: '45000',
		title: 'Warteg'
	});
	await postExpense(page, {
		walletId: gopay,
		categoryId: kopi,
		amount: '18000',
		title: 'Kopi susu'
	});
}

const chart = (page: Page) => page.getByRole('group', { name: /^Alur uang .*pemasukan ke dompet/ });

test('the chart draws income → wallets → spending; a node opens its list; reachable from Laporan', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'alur');
	await seed(page);
	await page.goto('/laporan');
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Lihat alur uang' }).click();
	await page.waitForURL(/\/alur-uang$/);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Alur uang' })).toBeVisible();
	await expect(page.getByText(`${rp('9.000.000')} masuk · ${rp('88.000')} keluar`)).toBeVisible();
	await expect(chart(page)).toBeVisible();
	// Text alternative: every link with its exact amount.
	await expect(page.getByRole('link', { name: /^Gaji → BCA\s*Rp\s9\.000\.000$/ })).toBeVisible();
	await expect(page.getByRole('link', { name: /^GoPay → Kopi\s*Rp\s18\.000$/ })).toBeVisible();
	await expectNoHorizontalScroll(page);
	// Every node is a ≥ 44 px target.
	const nodes = chart(page).locator('a.hit');
	await expect(nodes).toHaveCount(5);
	for (const box of await nodes.evaluateAll((els) =>
		els.map((e) => (e as SVGGraphicsElement).getBoundingClientRect().height)
	))
		expect(box).toBeGreaterThanOrEqual(isPhone(page) ? 44 : 40);
	await chart(page)
		.getByRole('link', { name: /^Makan.*: Rp\s45\.000$/ })
		.click();
	await page.waitForURL(/\/riwayat\?type=expense&month=\d{4}-\d{2}&category=/);
	await expect(page.getByText('Warteg')).toBeVisible();
	await context.close();
});

test('an empty month shows the empty state; the Fitur entry opens the page', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'alur');
	if (isPhone(page)) {
		await page.goto('/');
		await waitForHydration(page);
		await page.locator('a.features').click();
		await page
			.getByRole('dialog')
			.getByRole('link', { name: /Alur uang/ })
			.click();
	} else {
		await page.goto('/laporan');
		await waitForHydration(page);
		await page.getByRole('link', { name: 'Alur uang', exact: true }).click();
	}
	await page.waitForURL(/\/alur-uang$/);
	await expect(page.getByRole('heading', { name: 'Belum ada alur uang' })).toBeVisible();
	await expect(page.locator('main svg[role="group"]')).toHaveCount(0);
	await expectNoHorizontalScroll(page);
	await context.close();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`screenshots in ${colorScheme}`, async ({ browser }, testInfo) => {
		const signedUp = await freshUser(browser, testInfo, 'alur');
		await seed(signedUp.page);
		const storageState = await signedUp.context.storageState();
		await signedUp.context.close();
		const phone = testInfo.project.name === 'phone';
		const context = await browser.newContext({
			storageState,
			colorScheme,
			viewport: phone ? { width: 360, height: 780 } : { width: 1440, height: 900 },
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
		});
		const page = await context.newPage();
		await page.goto('/alur-uang');
		await waitForHydration(page);
		await expect(chart(page)).toBeVisible();
		await expectNoHorizontalScroll(page);
		mkdirSync(SHOTS, { recursive: true });
		await page.screenshot({
			path: `${SHOTS}/${phone ? '360' : '1440'}-${colorScheme}.png`,
			fullPage: true
		});
		await context.close();
	});
}
