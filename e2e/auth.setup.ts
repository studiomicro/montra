import { expect, test as setup } from '@playwright/test';
import {
	tickSignUpBoxes,
	simulatedClientIp,
	STORAGE_STATE,
	waitForHydration,
	APP_ORIGIN
} from './helpers';

/**
 * Signs up one fictional user per run through the real /daftar form and saves its session for the phone and
 * desktop projects (`storageState`). One sign-up for the whole run, not one per test.
 */
setup('sign up the shared e2e user', async ({ browser }, testInfo) => {
	const context = await browser.newContext({
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo) }
	});
	const page = await context.newPage();
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await page.goto(`${APP_ORIGIN}/daftar`);
	await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pengguna Uji');
	await page.getByLabel('E-mail').fill(`e2e-${runId}@example.test`);
	await page.getByLabel('Kata sandi').fill('terang-benderang-8');
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await expect(page).toHaveURL(`${APP_ORIGIN}/`);
	await context.storageState({ path: STORAGE_STATE });
	await context.close();
});
