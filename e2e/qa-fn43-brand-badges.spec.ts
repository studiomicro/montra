import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { newUser, type UserOptions, waitForHydration } from './helpers';
import { addWalletInSheet } from './ledger';

/**
 * QA supplement for FN-43 (PRD acceptance criteria 13, 14 — "Browser/Playwright"). The engineer's own test suite
 * covers matching and SSR-rendered markup with Vitest only; nothing in `e2e/*.spec.ts` opened a real browser and
 * asserted a brand badge is actually drawn on /dompet or in the Langganan catalogue picker. This file closes that
 * gap. Each test signs up its own fictional user in its own context, so its personal space starts empty.
 */

const freshUser = (browser: Browser, testInfo: TestInfo, opts: UserOptions = {}) =>
	newUser(browser, testInfo, { prefix: 'qa-fn43', name: 'QA FN-43', ...opts });

const row = (page: Page, name: string) =>
	page.locator('main').getByRole('listitem').filter({ hasText: name });

async function addWallet(page: Page, name: string) {
	await page.goto('/dompet');
	await waitForHydration(page);
	await addWalletInSheet(page, { name });
}

test('Dompet: a wallet named BCA shows the bca brand badge; an unnamed wallet keeps its initials tile', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await addWallet(page, 'BCA');
	await addWallet(page, 'Dompet harian');

	const bca = row(page, 'BCA');
	const tileBca = bca.locator('.tile').first();
	await expect(tileBca).toHaveText('BCA');
	await expect(tileBca).toHaveClass(/\bb-bca\b/);
	await expect(tileBca).toHaveAttribute('aria-hidden', 'true');
	await expect(tileBca.locator('img, svg')).toHaveCount(0);
	// The wallet's own name is still the row's visible/accessible text, not just the badge.
	await expect(bca.locator('.name-text')).toHaveText('BCA');

	const harian = row(page, 'Dompet harian');
	const tileHarian = harian.locator('.tile').first();
	await expect(tileHarian).not.toHaveClass(/\bb-/);
	await expect(tileHarian).toHaveText('DH');

	// Survives reload: the badge is derived live from the name on every render, not a stored flag.
	await page.reload();
	await waitForHydration(page);
	await expect(row(page, 'BCA').locator('.tile').first()).toHaveClass(/\bb-bca\b/);

	await context.close();
});

test('Langganan catalogue: GoPay Plus shows the gopay badge, Netflix keeps its initials tile', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	await page.goto('/langganan');
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Tambah langganan' }).first().click();
	const picker = page.getByRole('dialog', { name: 'Pilih layanan' });
	await expect(picker).toBeVisible();

	const gopayChoice = picker.getByRole('link', { name: 'GoPay Plus', exact: true });
	await expect(gopayChoice.locator('.tile')).toHaveClass(/\bb-gopay\b/);
	await expect(gopayChoice.locator('.tile')).toHaveText('GoPay');

	const netflixChoice = picker.getByRole('link', { name: 'Netflix', exact: true });
	await expect(netflixChoice.locator('.tile')).not.toHaveClass(/\bb-/);
	await expect(netflixChoice.locator('.tile')).toHaveText('NE');

	await context.close();
});
