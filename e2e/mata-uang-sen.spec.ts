import {
	expect,
	test,
	type Browser,
	type Locator,
	type Page,
	type TestInfo
} from '@playwright/test';
import { APP_ORIGIN, expectNoHorizontalScroll, newUser, waitForHydration } from './helpers';

/**
 * FN-47 real-browser behaviour only (the rules themselves are Vitest vectors in amount-input.test.ts and
 * forms.test.ts): typing cents with the caret and live grouping in Indonesian and English, a paste cut to two
 * fraction digits, the currency switch inside an open form, the 360 px layout and the no-JavaScript post.
 * Every test signs up its own fictional user, so its space starts with no wallets.
 */

async function freshUser(
	browser: Browser,
	testInfo: TestInfo,
	opts: { javaScriptEnabled?: boolean; locale?: 'id' | 'en' } = {}
) {
	const { locale, ...context } = opts;
	const user = await newUser(browser, testInfo, {
		prefix: 'fn47',
		name: 'Pemilik Dompet',
		n: 47,
		...context
	});
	if (locale === 'en')
		await user.context.addCookies([{ name: 'lang', value: 'en', url: APP_ORIGIN }]);
	return user;
}

/** The add-wallet form, opened from its URL (the same sheet the "Tambah dompet" link opens). */
async function openAddWallet(page: Page, js = true) {
	await page.goto('/dompet?tambah=1');
	if (js) await waitForHydration(page);
	const form = page.locator('form.wallet-form');
	await expect(form).toBeVisible();
	return {
		form,
		name: form.locator('input[name="name"]'),
		currency: form.locator('select[name="currency"]'),
		amount: form.locator('input[name="openingBalance"]')
	};
}

const caret = (input: Locator) =>
	input.evaluate((el) => (el as HTMLInputElement).selectionStart ?? -1);

test('id: typing cents groups live, a 3rd fraction digit is dropped with the caret held, a paste is cut', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo);
	const f = await openAddWallet(page);
	await f.name.fill('Wise USD');
	await f.currency.selectOption('USD');
	await expect(f.amount).toHaveAttribute('inputmode', 'decimal');
	await expect(f.form.getByText('Pakai koma untuk sen: 12,50')).toBeVisible();
	await expect(f.currency.locator('option')).toHaveText([
		'IDR',
		'USD',
		'SGD',
		'MYR',
		'EUR',
		'JPY',
		'AUD',
		'GBP',
		'TWD',
		'HKD',
		'CNY (RMB)'
	]);

	await f.amount.click();
	await f.amount.pressSequentially('1250,50');
	await expect(f.amount).toHaveValue('1.250,50');
	expect(await caret(f.amount)).toBe(8);
	await f.amount.press('5');
	await expect(f.amount).toHaveValue('1.250,50');
	expect(await caret(f.amount)).toBe(8);
	// A digit typed inside a full fraction is dropped too; the caret stays where it was.
	await f.amount.press('ArrowLeft');
	await f.amount.press('9');
	await expect(f.amount).toHaveValue('1.250,50');
	expect(await caret(f.amount)).toBe(7);

	// `0,5` stays as typed; `,50` gets its leading 0.
	await f.amount.fill('');
	await f.amount.pressSequentially(',50');
	await expect(f.amount).toHaveValue('0,50');

	// A paste of `12,345` lands as `12,34`: cut, never rounded.
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await f.amount.fill('');
	await page.evaluate(() => navigator.clipboard.writeText('12,345'));
	await f.amount.focus();
	await f.amount.press('ControlOrMeta+V');
	await expect(f.amount).toHaveValue('12,34');

	await f.amount.fill('');
	await f.amount.pressSequentially('1250,5');
	await f.form.locator('button[type="submit"]').click();
	await expect(page.getByText('Dompet ditambahkan.')).toBeVisible();
	const row = page.locator('main').getByRole('listitem').filter({ hasText: 'Wise USD' });
	await expect(row).toContainText('USD 1.250,50');
	await page.reload();
	await expect(row).toContainText('USD 1.250,50');
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('en: a dot for cents and comma grouping; the stored amount comes back with its cents', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { locale: 'en' });
	const f = await openAddWallet(page);
	await f.name.fill('Octopus');
	await f.currency.selectOption('HKD');
	await expect(f.form.getByText('Use a dot for cents: 12.50')).toBeVisible();
	await f.amount.click();
	await f.amount.pressSequentially('1250.5');
	await expect(f.amount).toHaveValue('1,250.5');
	await f.amount.press('0');
	await expect(f.amount).toHaveValue('1,250.50');
	await f.amount.press('7');
	await expect(f.amount).toHaveValue('1,250.50');
	// A comma typed in English is grouping, never a decimal mark.
	await f.amount.fill('');
	await f.amount.pressSequentially('12,50');
	await expect(f.amount).toHaveValue('1,250');
	await f.amount.fill('');
	await f.amount.pressSequentially('1250.50');
	await f.form.locator('button[type="submit"]').click();
	const row = page.locator('main').getByRole('listitem').filter({ hasText: 'Octopus' });
	await expect(row).toContainText('HKD 1,250.50');
	// The edit form opens with the cents, not the whole units only.
	await page.goto('/dompet');
	await waitForHydration(page);
	await row.click();
	await expect(page.locator('form.wallet-form input[name="openingBalance"]')).toHaveValue(
		'1,250.50'
	);
	await context.close();
});

test('currency switch in an open form: kept between two with cents, cleared to IDR, kept from IDR', async ({
	browser
}, testInfo) => {
	for (const locale of ['id', 'en'] as const) {
		const { context, page } = await freshUser(browser, testInfo, { locale });
		const f = await openAddWallet(page);
		const typed = locale === 'id' ? '12,50' : '12.50';
		await f.currency.selectOption('USD');
		await f.amount.click();
		await f.amount.pressSequentially(typed);
		await f.currency.selectOption('EUR');
		await expect(f.amount).toHaveValue(typed);
		await f.currency.selectOption('IDR');
		await expect(f.amount).toHaveValue('');
		await expect(f.amount).toHaveAttribute('inputmode', 'numeric');
		await f.amount.click();
		// IDR ignores a decimal mark exactly as before FN-47.
		await f.amount.pressSequentially(locale === 'id' ? '25000,5' : '25000.5');
		await expect(f.amount).toHaveValue('250.005');
		await f.amount.fill('');
		await f.amount.pressSequentially('25000');
		await expect(f.amount).toHaveValue('25.000');
		await f.currency.selectOption('USD');
		await expect(f.amount).toHaveValue(locale === 'id' ? '25.000' : '25,000');
		await f.name.fill(`Switch ${locale}`);
		await f.form.locator('button[type="submit"]').click();
		await expect(
			page
				.locator('main')
				.getByRole('listitem')
				.filter({ hasText: `Switch ${locale}` })
		).toContainText(locale === 'id' ? 'USD 25.000' : 'USD 25,000');
		await context.close();
	}
});

test('no JavaScript: a USD opening balance of 12,50 is saved as $12.50; 12,345 is refused and echoed', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, { javaScriptEnabled: false });
	let f = await openAddWallet(page, false);
	await f.name.fill('Tunai USD');
	await f.currency.selectOption('USD');
	await f.amount.fill('12,345');
	await f.form.locator('button[type="submit"]').click();
	// QA FN-47 #2 and #3: the refusal names the two-digit rule, and the field still shows what was typed.
	await expect(
		page.getByText('Isi saldo awal dengan maksimal 2 angka di belakang koma.')
	).toBeVisible();
	await expect(page.locator('input[name="openingBalance"]')).toHaveValue('12,345');
	f = await openAddWallet(page, false);
	await f.name.fill('Tunai USD');
	await f.currency.selectOption('USD');
	await f.amount.fill('12,50');
	await f.form.locator('button[type="submit"]').click();
	await expect(
		page.locator('main').getByRole('listitem').filter({ hasText: 'Tunai USD' })
	).toContainText('USD 12,50');
	await context.close();
});
