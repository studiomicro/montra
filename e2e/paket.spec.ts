import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	tickSignUpBoxes,
	waitForHydration
} from './helpers';

/**
 * FN-30 journeys. Each test signs up its own fictional user (plan and credits are per account). The e2e server
 * runs with BILLING_MOCK_ENABLED=1 and a local-only MOCK_PAYMENT_WEBHOOK_SECRET (playwright.config.ts): the
 * "mode uji" checkout charges nothing and calls no provider; the absent-when-off case is covered in Vitest.
 */
async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: { javaScriptEnabled?: boolean } = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) },
		...opts
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	if (opts.javaScriptEnabled !== false) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pemilik Paket');
	await page
		.getByLabel('E-mail')
		.fill(`fn30-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill('terang-benderang-8');
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${APP_ORIGIN}/`);
	return { context, page };
}

test('starter credits, placeholder prices, a refused voucher, then a mock upgrade through the signed webhook', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const csp = collectCspViolations(page);
	await page.goto('/pengaturan');
	await page.getByRole('link', { name: 'Paket & kredit' }).click();
	await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/paket`);
	await waitForHydration(page);

	await expect(page.getByTestId('credit-balance')).toHaveText('300');
	await expect(page.getByText('Paketmu: Gratis')).toBeVisible();
	await expect(page.getByText('harga sementara', { exact: true })).toHaveCount(3);
	await expect(page.getByText('Kredit awal', { exact: true })).toBeVisible();
	await expectNoHorizontalScroll(page);

	// A wrong code: the specific refusal, the code kept for correction, no reload needed.
	await page.getByLabel('Kode voucher').fill('salah-kode-1');
	await page.getByRole('button', { name: 'Tukar', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Kode tidak valid atau sudah tidak berlaku.');
	await expect(page.getByLabel('Kode voucher')).toHaveValue('salah-kode-1');

	// Upgrade (mode uji) → the test page, clearly labelled.
	await expect(page.getByText('Mode uji — tidak ada tagihan sebenarnya')).toBeVisible();
	await page.getByRole('button', { name: 'Pilih Pro (mode uji)' }).click();
	await expect(page).toHaveURL(/\/pengaturan\/paket\/uji\/mock_[A-Za-z0-9_-]+$/);
	await waitForHydration(page);
	await expect(page.getByText('Mode uji — tidak ada tagihan sebenarnya')).toBeVisible();
	await expect(page.getByText('harga sementara', { exact: true })).toBeVisible();
	await expectNoHorizontalScroll(page);

	await page.getByRole('button', { name: 'Simulasikan gagal' }).click();
	await expect(page.getByText(/Pembayaran uji gagal \(simulasi\)/)).toBeVisible();

	await page.getByRole('button', { name: 'Bayar (mode uji)' }).click();
	await expect(page.getByText('Pembayaran uji berhasil. Paketmu sekarang Pro.')).toBeVisible();
	await page.getByRole('link', { name: 'Kembali ke Paket & kredit' }).last().click();
	await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/paket`);
	await expect(page.getByTestId('credit-balance')).toHaveText('1.300');
	await expect(page.getByText(/^Paketmu: Pro/)).toBeVisible();
	await expect(page.getByText('Kredit paket', { exact: true })).toBeVisible();
	await expect(page.getByText('+1.000')).toBeVisible();
	// Pro is in force: no upgrade back to it is offered as an "upgrade", only an extension.
	await expect(page.getByRole('button', { name: 'Pilih Pro (mode uji)' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Perpanjang Pro (mode uji)' })).toBeVisible();

	expect(csp).toEqual([]);
	await context.close();
});

test('without JavaScript a voucher refusal still shows', async ({ browser }, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	await page.goto('/pengaturan/paket');
	await page.getByLabel('Kode voucher').fill('BUKAN-KODE');
	await page.getByRole('button', { name: 'Tukar', exact: true }).click();
	await expect(page.getByText('Kode tidak valid atau sudah tidak berlaku.')).toBeVisible();
	await expect(page.getByTestId('credit-balance')).toHaveText('300');
	await context.close();
});
