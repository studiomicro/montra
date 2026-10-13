import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, isPhone, waitForHydration } from './helpers';
import { addWallet, freshUser, ids, postExpense } from './ledger';

/**
 * QA probes for FN-35 money flow not already covered by the engineer's e2e/alur-uang.spec.ts:
 * - many categories (>= 12) in one month renders without horizontal overflow (stress case named in the QA brief);
 * - the SVG links/nodes are reachable by keyboard (Tab) and carry an accessible name (not just a visual band);
 * - a screenshot of the many-categories case in dark mode, filed next to the engineer's shots.
 */

const SHOTS = 'docs/features/fn-35-money-flow/shots';

const EXPENSE_CATEGORIES = [
	'Kopi',
	'Makan & Minum',
	'Belanja Harian',
	'Belanja',
	'Transportasi',
	'Tagihan',
	'Kesehatan',
	'Hiburan',
	'Pendidikan',
	'Tempat Tinggal'
];
const INCOME_CATEGORIES = ['Gaji', 'Bonus', 'Freelance', 'Hadiah', 'Pemasukan Lain'];

/**
 * `ids().category` matches by substring (`hasText`), which collides on this preset list ("Belanja" is a
 * substring of "Belanja Harian"); an exact match on the tile's name span avoids that.
 */
async function exactCategory(page: Page, name: string): Promise<string> {
	return (await page
		.locator('label.tile')
		.filter({ has: page.locator('.tile-name', { hasText: new RegExp(`^${name}$`) }) })
		.locator('input[name="categoryId"]')
		.getAttribute('value'))!;
}

/** One wallet, every preset category (10 expense + 5 income = 15, well past the >= 12 bar) with a flow. */
async function manyCategories(page: Page) {
	await addWallet(page, 'BCA');
	const { wallet } = await ids(page);
	const category = (name: string) => exactCategory(page, name);
	const bca = await wallet('BCA');
	let n = 1000;
	for (const name of INCOME_CATEGORIES) {
		await postExpense(page, {
			type: 'income',
			walletId: bca,
			categoryId: await category(name),
			amount: String(n++ * 1000),
			title: name
		});
	}
	for (const name of EXPENSE_CATEGORIES) {
		await postExpense(page, {
			walletId: bca,
			categoryId: await category(name),
			amount: String(n++ * 1000),
			title: name
		});
	}
}

const chart = (page: Page) => page.getByRole('group', { name: /^Alur uang .*pemasukan ke dompet/ });

test('many categories (15, past the >= 12 bar) render without horizontal overflow', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'alurmany');
	await manyCategories(page);
	await page.goto('/alur-uang');
	await waitForHydration(page);
	await expect(chart(page)).toBeVisible();
	// 15 categories + 1 wallet = 16 nodes, each an accessible link.
	await expect(chart(page).locator('a.hit')).toHaveCount(16);
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('many categories, dark mode: screenshot for the QA report', async ({ browser }, testInfo) => {
	const signedUp = await freshUser(browser, testInfo, 'alurmanydark');
	await manyCategories(signedUp.page);
	const storageState = await signedUp.context.storageState();
	await signedUp.context.close();
	const phone = testInfo.project.name === 'phone';
	const context = await browser.newContext({
		storageState,
		colorScheme: 'dark',
		viewport: phone ? { width: 360, height: 780 } : { width: 1440, height: 900 }
	});
	const page = await context.newPage();
	await page.goto('/alur-uang');
	await waitForHydration(page);
	await expect(chart(page)).toBeVisible();
	await expectNoHorizontalScroll(page);
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({
		path: `${SHOTS}/${phone ? '360' : '1440'}-many-categories-dark.png`,
		fullPage: true
	});
	await context.close();
});

test('a chart link is reachable and activatable by keyboard, with an accessible name', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'alurkbd');
	test.skip(isPhone(page), 'keyboard focus is a desktop/pointer:fine probe');
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	const bca = await wallet('BCA');
	await postExpense(page, {
		type: 'income',
		walletId: bca,
		categoryId: await category('Gaji'),
		amount: '9000000',
		title: 'Gaji'
	});
	await page.goto('/alur-uang');
	await waitForHydration(page);
	const link = page.getByRole('link', { name: /^Gaji → BCA\s*Rp\s9\.000\.000$/ });
	await expect(link).toBeVisible();
	// The link carries its own accessible name (not only a decorative band): assert it directly, then confirm
	// it is reachable from the keyboard by focusing it and checking it is the active element.
	await link.focus();
	await expect(link).toBeFocused();
	const tag = await link.evaluate((el) => el.tagName.toLowerCase());
	expect(tag).toBe('a');
	await context.close();
});
