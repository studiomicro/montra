import { expect, test as setup } from '@playwright/test';
import { APP_ORIGIN, signUp, simulatedClientIp, STORAGE_STATE, uniqueEmail } from './helpers';

/**
 * Signs up one fictional user per run through the real /daftar form and saves its session for the phone and
 * desktop projects (`storageState`). One sign-up for the whole run, not one per test.
 */
setup('sign up the shared e2e user', async ({ browser }, testInfo) => {
	const context = await browser.newContext({
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo) }
	});
	const page = await context.newPage();
	await signUp(page, { email: uniqueEmail('e2e'), name: 'Pengguna Uji' });
	await expect(page).toHaveURL(`${APP_ORIGIN}/`);
	// FN-54: the once-a-day greeting sheet is switched off for the shared user (a device cookie, as Pengaturan ›
	// Tampilan sets it), so journeys that open Beranda are not covered by it; e2e/sapaan.spec.ts tests the sheet.
	await context.addCookies([{ name: 'montra-sapaan-off', value: '1', url: APP_ORIGIN }]);
	await context.storageState({ path: STORAGE_STATE });
	await context.close();
});
