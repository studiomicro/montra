import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	tickSignUpBoxes,
	APP_ORIGIN,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration
} from './helpers';

// Journey helpers shared by the ledger specs (Riwayat, Beranda). Each test signs up its own fictional user in
// its own context; setup data goes through the app's own form actions (plain form posts), never into D1.

export const BASE = APP_ORIGIN;
export const PASSWORD = 'terang-benderang-8';
const NBSP = ' ';
export const rp = (text: string) => `Rp${NBSP}${text}`;

export async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	prefix = 'fn05',
	/** FN-54: keep the once-a-day greeting sheet on (only e2e/sapaan.spec.ts tests it; it would cover Beranda). */
	{ sapaan = false }: { sapaan?: boolean } = {}
) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) }
	});
	const page = await context.newPage();
	await page.goto('/daftar');
	await waitForHydration(page);
	await page.getByLabel('Nama').fill('Pencatat');
	// Returned, so a spec that seeds the local D1 directly can find this user's own space (never "the newest
	// space", which a test running in parallel may own).
	const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
	await page.getByLabel('E-mail').fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(`${BASE}/`);
	if (!sapaan) await context.addCookies([{ name: 'montra-sapaan-off', value: '1', url: BASE }]);
	return { context, page, email };
}

/** A plain (no-JavaScript-style) form post through the page's own session. */
export async function postForm(page: Page, path: string, form: Record<string, string>) {
	const res = await page.request.post(`${BASE}${path}`, {
		form,
		headers: { origin: BASE, accept: 'text/html' },
		maxRedirects: 0
	});
	expect([200, 303]).toContain(res.status());
	return res;
}

export async function addWallet(page: Page, name: string, balance = '100.000') {
	await postForm(page, '/dompet?/createWallet', {
		name,
		type: 'bank',
		currency: 'IDR',
		openingBalance: balance,
		lastFour: ''
	});
}

/** Wallet and category ids as the compose page lists them. */
export async function ids(page: Page) {
	await page.goto('/riwayat/baru');
	const wallet = async (name: string) =>
		(await page
			.locator('select[name="walletId"] option')
			.filter({ hasText: name })
			.getAttribute('value'))!;
	const category = async (name: string) =>
		(await page
			.locator('label', { hasText: name })
			.locator('input[name="categoryId"]')
			.first()
			.getAttribute('value'))!;
	return { wallet, category };
}

export const today = () =>
	new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

export async function postExpense(
	page: Page,
	o: { walletId: string; categoryId: string; amount: string; title: string; type?: string }
) {
	const res = await postForm(page, '/riwayat/baru?/create', {
		type: o.type ?? 'expense',
		amount: o.amount,
		walletId: o.walletId,
		categoryId: o.categoryId,
		title: o.title,
		note: '',
		occurredOn: today(),
		occurredTime: ''
	});
	expect(res.status()).toBe(303);
}
