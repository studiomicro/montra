import { expect, test, type Page } from '@playwright/test';
import { BASE, addWallet, freshUser, today } from './ledger';
import { waitForHydration } from './helpers';

/**
 * FN-54 Part D: the once-a-day greeting sheet. Only this spec keeps it on (`freshUser(…, { sapaan: true })`); every
 * other journey's user has it switched off so it never covers Beranda.
 */

const story = (page: Page) => page.getByRole('dialog', { name: 'Sapaan harian' });
const seen = async (page: Page) =>
	(await page.context().cookies(BASE)).find((c) => c.name === 'montra-sapaan-seen')?.value;

test('opens once after hydration, steps only on Berikutnya, Escape closes, the WIB date is remembered', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54s', { sapaan: true });
	// No wallet yet: nothing to greet with, so no sheet.
	await page.goto('/');
	await waitForHydration(page);
	await expect(story(page)).toHaveCount(0);

	await addWallet(page, 'BCA', '1.000.000');
	await page.goto('/');
	await waitForHydration(page);
	await expect(story(page)).toBeVisible();
	await expect(story(page).getByRole('heading', { name: 'Kemarin' })).toBeVisible();
	await expect(story(page).getByText('Tidak ada pengeluaran tercatat kemarin.')).toBeVisible();
	await expect(story(page).locator('.progress li')).toHaveCount(1);
	await expect(story(page).getByRole('button', { name: 'Selesai' })).toBeVisible();
	// Nothing advances by itself.
	await page.waitForTimeout(1500);
	await expect(story(page).getByRole('heading', { name: 'Kemarin' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(story(page)).toBeHidden();
	await expect(page.locator('main')).toBeFocused();
	expect(await seen(page)).toBe(today());

	await page.reload();
	await waitForHydration(page);
	await expect(story(page)).toBeHidden();
	const second = await context.newPage();
	await second.goto('/');
	await waitForHydration(second);
	await expect(story(second)).toBeHidden();
	await context.close();
});

test('"Matikan sapaan harian" switches it off once the server confirmed; Tampilan turns it back on', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54s', { sapaan: true });
	await addWallet(page, 'BCA', '1.000.000');
	await page.goto('/');
	await waitForHydration(page);
	await story(page).getByRole('button', { name: 'Matikan sapaan harian' }).click();
	await expect(story(page)).toBeHidden();
	await expect(page.getByText('Sapaan harian dimatikan.')).toBeVisible();

	await page.goto('/pengaturan/tampilan');
	await waitForHydration(page);
	const toggle = page.getByRole('switch', { name: /Sapaan harian/ });
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await expect(page.getByText('Perubahan disimpan.')).toBeVisible();
	await page.reload();
	await expect(page.getByRole('switch', { name: /Sapaan harian/ })).toBeChecked();
	// Back on: due again today (the "seen" date was cleared with the switch).
	await page.goto('/');
	await waitForHydration(page);
	await expect(story(page)).toBeVisible();
	await context.close();
});

test('without JavaScript the Tampilan switch saves and the sheet never opens', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54s', { sapaan: true });
	await addWallet(page, 'BCA', '1.000.000');
	const noJs = await browser.newContext({
		javaScriptEnabled: false,
		storageState: await context.storageState()
	});
	const plain = await noJs.newPage();
	await plain.goto(`${BASE}/`);
	await expect(story(plain)).toBeHidden();
	await plain.goto(`${BASE}/pengaturan/tampilan`);
	const toggle = plain.getByRole('switch', { name: /Sapaan harian/ });
	await expect(toggle).toBeChecked();
	await toggle.uncheck();
	await plain.locator('form.sapaan').getByRole('button', { name: 'Simpan' }).click();
	await expect(plain.getByText('Perubahan disimpan.')).toBeVisible();
	await expect(plain.getByRole('switch', { name: /Sapaan harian/ })).not.toBeChecked();
	expect((await noJs.cookies(BASE)).find((c) => c.name === 'montra-sapaan-off')?.value).toBe('1');
	await noJs.close();
	await context.close();
});

test('never over another open dialog: ?anggaran=1 opens the budget form, not the greeting', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54s', { sapaan: true });
	await addWallet(page, 'BCA', '1.000.000');
	await page.goto('/?anggaran=1');
	await waitForHydration(page);
	await expect(page.getByRole('dialog', { name: 'Anggaran bulanan' })).toBeVisible();
	await expect(story(page)).toBeHidden();
	await context.close();
});

test('the per-day figure is printed as Beranda prints it (compact, no sen)', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54s', { sapaan: true });
	await addWallet(page, 'BCA', '1.000.000');
	await page.request.post(`${BASE}/?/setBudget`, {
		form: { amount: '3.000.001', currency: 'IDR', updatedAt: '' },
		headers: { origin: BASE }
	});
	await page.goto('/');
	await waitForHydration(page);
	await story(page).getByRole('button', { name: 'Berikutnya' }).click();
	const line = story(page).getByText(/sehari untuk \d+ hari$/);
	await expect(line).toBeVisible();
	const text = (await line.textContent())!.trim();
	expect(text).not.toMatch(/,\d\d /);
	const perDay = text.replace(/ sehari untuk \d+ hari$/, '');
	await page.keyboard.press('Escape');
	await expect(page.locator('main .safe')).toContainText(`${perDay} sehari untuk`);
	await context.close();
});
