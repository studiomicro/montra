import { expect, test } from '@playwright/test';
import { collectCspViolations, expectNoHorizontalScroll, waitForHydration } from './helpers';
import { addWallet, BASE, freshUser, ids, postExpense, rp, today } from './ledger';

/**
 * FN-54 Part C: /kalender from the Beranda badge. The month and the day live in the URL, so every control is a
 * link (no JavaScript needed) and a reload shows the same month and day.
 */

const shiftMonth = (month: string, delta: number) => {
	const [y, m] = month.split('-').map(Number) as [number, number];
	const d = new Date(Date.UTC(y, m - 1 + delta, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

test('a day’s figure equals Riwayat’s; stepping months and picking a day live in the URL', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54k');
	await addWallet(page, 'BCA', '1.000.000');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi susu'
	});
	const csp = collectCspViolations(page);
	await page.goto('/kalender');
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Kalender' })).toBeVisible();
	const day = today();
	const detail = page.locator('section', { has: page.locator('#day-title') });
	await expect(detail.locator('p.figure')).toContainText(rp('25.000'));
	await expect(detail.getByText('Kopi susu')).toBeVisible();
	await expect(detail.getByText('Hari ini belum ditutup')).toBeVisible();
	const all = detail.getByRole('link', { name: 'Lihat semua di Riwayat' });
	await expect(all).toHaveAttribute('href', `/riwayat?period=range&from=${day}&to=${day}`);
	await expectNoHorizontalScroll(page);

	// The cell's accessible name carries the same figure; it is a keyboard-reachable link with a focus ring.
	const cell = page.getByRole('link', { name: new RegExp(`: Rp\\s25\\.000`) });
	await cell.focus();
	await expect(cell).toBeFocused();

	// Previous month: a link; the URL holds it, a reload keeps it.
	const thisMonth = day.slice(0, 7);
	const prev = shiftMonth(thisMonth, -1);
	await page.getByRole('link', { name: 'Periode sebelumnya' }).click();
	await expect(page).toHaveURL(new RegExp(`bulan=${prev}$`));
	await page.getByRole('link', { name: /^1 / }).first().click();
	await expect(page).toHaveURL(new RegExp(`bulan=${prev}&hari=${prev}-01$`));
	await page.reload();
	await expect(page.locator('#day-title')).toContainText('1');
	await expect(page.getByText('Tidak ada catatan atau tagihan pada hari itu.')).toBeVisible();

	// Riwayat's one-day view shows the same total for today.
	await page.goto(`/riwayat?period=range&from=${day}&to=${day}`);
	await expect(page.locator('main')).toContainText(rp('25.000'));
	expect(csp).toEqual([]);
	await context.close();
});

test('an out-of-window or malformed month shows this month without an error', async ({ page }) => {
	await page.goto('/kalender?bulan=2099-01&hari=abc');
	await expect(page.getByRole('heading', { level: 1, name: 'Kalender' })).toBeVisible();
	// The stepper's short label, as on Laporan: "Okt '26" (POLISH_AUDIT B9).
	const month = today().slice(0, 7);
	const thisMonth = `${new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', month: 'short' }).format(
		new Date(`${month}-01T00:00:00Z`)
	)} '${month.slice(2, 4)}`;
	await expect(page.locator('.stepper')).toContainText(thisMonth);
	// Two months ahead is the window's end: "next" is not a link there.
	const last = shiftMonth(today().slice(0, 7), 2);
	await page.goto(`/kalender?bulan=${last}`);
	await expect(page.getByRole('link', { name: 'Periode berikutnya' })).toHaveCount(0);
});

test('without JavaScript the stepper, the cells and the Riwayat link are plain links', async ({
	browser,
	page
}) => {
	const noJs = await browser.newContext({
		javaScriptEnabled: false,
		storageState: await page.context().storageState()
	});
	const plain = await noJs.newPage();
	await plain.goto(`${BASE}/kalender`);
	await plain.getByRole('link', { name: 'Periode sebelumnya' }).click();
	await expect(plain).toHaveURL(/bulan=/);
	await plain.getByRole('link', { name: /^2 / }).first().click();
	await expect(plain).toHaveURL(/hari=\d{4}-\d{2}-02$/);
	await expect(plain.locator('#day-title')).toBeVisible();
	await noJs.close();
});

test('hidden amounts: masked on a cold load (HTML and labels) and after a client-side visit from the badge', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54m');
	await addWallet(page, 'BCA', '1.000.000');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi susu'
	});
	await context.addCookies([{ name: 'montra-amounts-hidden', value: '1', url: BASE }]);
	const html = await (await page.request.get(`${BASE}/kalender`)).text();
	const body = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
	expect(body).not.toMatch(/Rp\s?\d/);
	expect(body).toContain('••••');
	expect(body).toContain('Kopi susu');

	// The device's choice (the eye on Beranda) also holds on a client-side visit from the badge.
	await page.goto('/');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Sembunyikan nominal' }).click();
	await expect(page.getByRole('button', { name: 'Sembunyikan nominal' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await page.getByRole('link', { name: /^Kalender, / }).click();
	await expect(page).toHaveURL(/\/kalender$/);
	await expect(page.locator('#day-title')).toBeVisible();
	await expect(page.locator('main')).not.toContainText(/Rp\s?\d/);
	await expect(page.getByRole('link', { name: /: ••••$/ }).first()).toBeVisible();
	await context.close();
});
