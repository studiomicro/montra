import { expect, test } from '@playwright/test';
import { collectCspViolations, expectNoHorizontalScroll, waitForHydration } from './helpers';

/**
 * FN-19 Gmail. The e2e server has no Google OAuth client and no CONNECTED_APPS_ENCRYPTION_KEY (production's state
 * until the owner sets them up, docs/RUNBOOK.md › Gmail), so the page must say "Belum dikonfigurasi" with the
 * reasons and offer no Hubungkan. The connect, callback, checks and disconnect run against a fake Google in
 * test/integration/gmail.test.ts; nothing here reaches Google.
 */

test('Aplikasi › Gmail opens its page: "Belum dikonfigurasi" with the reasons, no Hubungkan, no CSP violation', async ({
	page
}) => {
	const csp = collectCspViolations(page);
	await page.goto('/pengaturan/aplikasi');
	await waitForHydration(page);
	const row = page.getByRole('listitem').filter({ hasText: 'Gmail' });
	await expect(row).toContainText('Belum dikonfigurasi');
	await row.getByRole('link').click();
	await page.waitForURL(/\/pengaturan\/aplikasi\/gmail$/);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'Gmail', level: 1 })).toBeVisible();
	const notice = page.locator('section.notice');
	await expect(notice.getByRole('heading', { name: 'Belum dikonfigurasi' })).toBeVisible();
	await expect(notice).toContainText('ID klien Google belum dipasang.');
	await expect(notice).toContainText('Alamat pengalihan belum dipasang.');
	await expect(notice).toContainText('Kunci enkripsi belum dipasang.');
	await expect(notice).not.toContainText('GOOGLE_');
	await expect(page.getByRole('button', { name: 'Hubungkan' })).toHaveCount(0);
	await expect(notice.getByRole('link', { name: 'Teruskan e-mail' })).toBeVisible();
	await expectNoHorizontalScroll(page);
	expect(csp).toEqual([]);
});

test('without JavaScript the page renders the same state', async ({ browser }, testInfo) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: testInfo.project.use.storageState
	});
	const page = await context.newPage();
	await page.goto('/pengaturan/aplikasi/gmail');
	await expect(page.getByRole('heading', { name: 'Belum dikonfigurasi' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Hubungkan' })).toHaveCount(0);
	await context.close();
});

test('the callback answers 404 off the configured origin (none is configured here)', async ({
	request
}) => {
	const r = await request.get('/pengaturan/aplikasi/gmail/callback?state=x&code=y', {
		maxRedirects: 0
	});
	expect(r.status()).toBe(404);
});
