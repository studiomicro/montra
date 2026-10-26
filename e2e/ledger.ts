import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { APP_ORIGIN, newUser } from './helpers';

// Journey helpers shared by the ledger specs (Riwayat, Beranda). Each test signs up its own fictional user in
// its own context; setup data goes through the app's own form actions (plain form posts), never into D1.

const NBSP = ' ';
export const rp = (text: string) => `Rp${NBSP}${text}`;

export function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	prefix = 'fn05',
	/** FN-54: keep the once-a-day greeting sheet on (only e2e/sapaan.spec.ts tests it; it would cover Beranda). */
	{ sapaan = false }: { sapaan?: boolean } = {}
) {
	return newUser(browser, testInfo, { prefix, name: 'Pencatat', sapaanOff: !sapaan });
}

/** A plain (no-JavaScript-style) form post through the page's own session. */
export async function postForm(page: Page, path: string, form: Record<string, string>) {
	const res = await page.request.post(`${APP_ORIGIN}${path}`, {
		form,
		headers: { origin: APP_ORIGIN, accept: 'text/html' },
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

/** Adds a wallet through the sheet on /dompet; resolves once the server-confirmed row is listed. */
export async function addWalletInSheet(
	page: Page,
	w: { name: string; type?: string; balance?: string; lastFour?: string; favourite?: boolean }
) {
	await page.getByRole('link', { name: 'Tambah dompet' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah dompet' });
	await expect(sheet).toBeVisible();
	await sheet.getByLabel('Nama dompet').fill(w.name);
	await sheet.getByRole('radio', { name: w.type ?? 'Bank' }).check();
	if (w.balance) await sheet.getByLabel('Saldo awal').fill(w.balance);
	if (w.lastFour) await sheet.getByLabel('4 angka terakhir (opsional)').fill(w.lastFour);
	if (w.favourite) await sheet.getByLabel('Jadikan favorit').check();
	await sheet.getByRole('button', { name: 'Tambah dompet' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();
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
	o: {
		walletId: string;
		categoryId: string;
		amount: string;
		title: string;
		type?: string;
		occurredOn?: string;
	}
) {
	const res = await postForm(page, '/riwayat/baru?/create', {
		type: o.type ?? 'expense',
		amount: o.amount,
		walletId: o.walletId,
		categoryId: o.categoryId,
		title: o.title,
		note: '',
		occurredOn: o.occurredOn ?? today(),
		occurredTime: ''
	});
	expect(res.status()).toBe(303);
}
