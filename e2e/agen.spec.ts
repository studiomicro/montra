import { expect, test, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	waitForHydration
} from './helpers';
import { addWallet, freshUser, ids, postExpense } from './ledger';

/**
 * FN-23 Agen (beta) journeys on `wrangler dev` (app + jobs Worker, so the local queue runs the steps). No AI
 * Gateway is configured on the e2e server, so the narrative box is disabled ("Belum dikonfigurasi") and no test can reach
 * Anthropic. Each test signs up its own fictional user; the Agent plan comes from the "mode uji" checkout
 * (BILLING_MOCK_ENABLED=1, no provider).
 */

async function upgradeToAgen(page: Page) {
	await page.goto('/pengaturan/paket');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Pilih Agen (mode uji)' }).click();
	await expect(page).toHaveURL(/\/pengaturan\/paket\/uji\/mock_[A-Za-z0-9_-]+$/);
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Bayar (mode uji)' }).click();
	await expect(page.getByText('Pembayaran uji berhasil. Paketmu sekarang Agen.')).toBeVisible();
}

async function seedToday(page: Page) {
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Makan'),
		amount: '45000',
		title: 'Warteg'
	});
}

test('locked off the Agent plan; on it a monthly report runs its steps to two downloads (360 px, no scroll)', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn23');
	const csp = collectCspViolations(page);
	await page.goto('/agen');
	await expect(page.getByRole('heading', { level: 1, name: 'Agen' })).toBeVisible();
	await expect(page.getByText('Tersedia di paket Agen')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Lihat paket' })).toHaveAttribute(
		'href',
		'/pengaturan/paket'
	);
	await expect(page.getByRole('button', { name: 'Buat laporan' })).toHaveCount(0);

	await upgradeToAgen(page);
	await seedToday(page);
	await page.goto('/agen');
	await waitForHydration(page);
	await expect(page.getByText('Belum ada laporan. Laporan siap disimpan 30 hari.')).toBeVisible();
	const narrative = page.getByRole('checkbox', { name: 'Tulis ringkasan dengan AI' });
	await expect(narrative).toBeDisabled();
	await expect(narrative).toHaveAccessibleDescription(/^Belum dikonfigurasi/);
	await expect(page.getByText(/bukan pelaporan SPT/)).toBeVisible();
	await expectNoHorizontalScroll(page);

	await page.getByRole('radio', { name: 'Laporan bulanan' }).check();
	await page.getByRole('button', { name: 'Buat laporan' }).click();
	// The run row exists (server-confirmed), then advances through the queue; the page polls its load.
	const list = page.getByRole('list', { name: 'Laporanmu' });
	await expect(list.getByText(/Laporan bulanan ·/)).toBeVisible();
	await expect(list.getByText('Siap')).toBeVisible({ timeout: 60_000 });
	const csv = list.getByRole('link', { name: /Unduh CSV/ });
	const html = list.getByRole('link', { name: /Unduh HTML/ });
	await expect(csv).toBeVisible();
	await expect(html).toBeVisible();
	await expect(list.getByText(/Tanpa ringkasan AI: tidak diminta/)).toBeVisible();
	const res = await page.request.get(`${APP_ORIGIN}${await csv.getAttribute('href')}`);
	expect(res.status()).toBe(200);
	expect(res.headers()['content-disposition']).toMatch(
		/^attachment; filename="montra-laporan-bulanan-\d{4}-\d{2}\.csv"$/
	);
	expect(await res.text()).toContain('Warteg');
	// Reload keeps the list (persisted in D1, not the page).
	await page.reload();
	await expect(page.getByRole('list', { name: 'Laporanmu' }).getByText('Siap')).toBeVisible();
	// Headings never skip.
	const levels = await page
		.locator('main h1, main h2, main h3, main h4')
		.evaluateAll((els) => els.map((e) => Number(e.tagName[1])));
	for (let i = 1; i < levels.length; i++)
		expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
	await expectNoHorizontalScroll(page);
	expect(csp).toEqual([]);
	await context.close();
});

test('without JavaScript: create, the refresh advances the run, then delete; all full-page posts', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn23nojs');
	await upgradeToAgen(page);
	await seedToday(page);
	const state = await context.storageState();
	await context.close();

	const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: state });
	const p = await noJs.newPage();
	await p.goto(`${APP_ORIGIN}/agen`);
	await p.getByRole('radio', { name: 'Laporan bulanan' }).check();
	await p.getByRole('button', { name: 'Buat laporan' }).click();
	await expect(p).toHaveURL(`${APP_ORIGIN}/agen`);
	const list = p.getByRole('list', { name: 'Laporanmu' });
	await expect(list.getByText(/Laporan bulanan ·/)).toBeVisible();
	// The <noscript> refresh (5 s) reloads until the run is ready.
	await expect(list.getByText('Siap')).toBeVisible({ timeout: 60_000 });
	await expect(list.getByRole('link', { name: /Unduh HTML/ })).toBeVisible();
	await list.getByRole('button', { name: 'Hapus' }).click();
	await expect(p).toHaveURL(`${APP_ORIGIN}/agen`);
	await expect(p.getByText('Belum ada laporan. Laporan siap disimpan 30 hari.')).toBeVisible();
	await noJs.close();
});
