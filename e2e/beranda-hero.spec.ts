import { expect, test, type Page } from '@playwright/test';
import {
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	waitForHydration
} from './helpers';
import { addWallet, BASE, freshUser, ids, postExpense } from './ledger';

/**
 * FN-54 Part B: Beranda's greeting hero, the date badge and the header placement, at 360 px (phone project) and
 * 1280 px (desktop project). The e2e server has no AI Gateway, so Struk and the ask field show their reasons.
 */

const main = (page: Page) => page.locator('main');

test('the hero: date, greeting, today’s line, figure, chips and the ask field, with no CSP violation', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54');
	const csp = collectCspViolations(page);
	await page.goto('/');
	await waitForHydration(page);
	const hero = main(page).locator('section.greeting');
	await expect(hero.getByText(/^Selamat (pagi|siang|sore|malam)\.$/)).toBeVisible();
	await expect(hero.getByText('Belum ada catatan hari ini.')).toBeVisible();
	await expect(hero.getByText(/^Pengeluaran \p{L}+$/u)).toBeVisible();
	await expect(hero.getByRole('link', { name: 'Atur anggaran' })).toHaveAttribute(
		'href',
		'/anggaran'
	);
	// No AI Gateway on the e2e server: the field and its button are disabled and say why.
	await expect(hero.getByRole('textbox', { name: 'Pertanyaanmu' })).toBeDisabled();
	await expect(hero.getByText('Asisten AI belum dikonfigurasi.')).toBeVisible();
	await expect(hero.getByText('%')).toHaveCount(0);
	// Exactly one h1, and the greeting is not a heading.
	await expect(page.locator('h1')).toHaveCount(1);
	await expect(page.getByRole('heading', { name: /Selamat/ })).toHaveCount(0);
	// The greeting and the month figure are on the first screen.
	const greet = await hero.getByText(/^Selamat/).boundingBox();
	const figure = await hero.locator('.figure').boundingBox();
	const height = page.viewportSize()!.height;
	expect(greet!.y + greet!.height).toBeLessThanOrEqual(height);
	expect(figure!.y + figure!.height).toBeLessThanOrEqual(height);
	await expectNoHorizontalScroll(page);
	expect(csp).toEqual([]);
	await context.close();
});

test('a transaction today: the line counts it; the budget chip shows the same figure as the budget line', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn54');
	await addWallet(page, 'BCA', '1.000.000');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi'
	});
	await page.request.post(`${BASE}/?/setBudget`, {
		form: { amount: '3.000.000', currency: 'IDR', updatedAt: '' },
		headers: { origin: BASE }
	});
	await page.goto('/');
	await waitForHydration(page);
	const hero = main(page).locator('section.greeting');
	await expect(hero.getByText('1 transaksi tercatat hari ini')).toBeVisible();
	const chip = hero.getByRole('link', { name: /masih bisa dipakai$/ });
	const sisa = ((await chip.textContent()) ?? '').replace(' masih bisa dipakai', '').trim();
	await expect(main(page).locator('.safe')).toContainText(`${sisa} tersisa`);

	// The eye masks the hero, both chips and their accessible names; the greeting and the count stay readable.
	await hero.getByRole('button', { name: 'Sembunyikan nominal' }).click();
	await expect(hero.getByRole('link', { name: '•••• masih bisa dipakai' })).toBeVisible();
	await expect(hero.getByText('1 transaksi tercatat hari ini')).toBeVisible();
	// A cold load with the cookie is masked from the first server render.
	const html = await (await page.request.get('/')).text();
	expect(html).toContain('•••• masih bisa dipakai');
	expect(html).not.toContain(`${sisa} masih bisa dipakai`);
	await context.close();
});

test('header placement: badge, Struk and Suara (desktop header or phone layout), one of each', async ({
	page
}) => {
	await page.goto('/');
	await waitForHydration(page);
	const badge = page.getByRole('link', { name: /^Kalender, / });
	await expect(badge).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Struk' })).toHaveCount(1);
	await expect(page.getByRole('link', { name: 'Suara' })).toHaveCount(1);
	const struk = page.getByRole('button', { name: 'Struk' });
	await expect(struk).toBeDisabled();
	const why = await struk.getAttribute('aria-describedby');
	await expect(page.locator(`#${why}`)).toHaveText(
		'Pembacaan struk dengan AI belum dikonfigurasi.'
	);
	await expect(page.locator(`#${why}`)).toBeVisible();

	if (isPhone(page)) {
		// Phone: the badge sits top left; the capture pair keeps its place under the charts.
		const b = (await badge.boundingBox())!;
		expect(b.x).toBeLessThan(40);
		await expect(page.getByRole('heading', { level: 1, name: 'Beranda' })).not.toBeInViewport();
		const suara = (await page.getByRole('link', { name: 'Suara' }).boundingBox())!;
		const hero = (await page.locator('section.greeting').boundingBox())!;
		expect(suara.y).toBeGreaterThan(hero.y + hero.height);
		await expectNoHorizontalScroll(page);
	} else {
		await expect(page.getByRole('heading', { level: 1, name: 'Beranda' })).toBeVisible();
		// Tab order: badge → Struk (disabled: skipped) → Suara; the header row holds all three, in that order.
		const xs = await Promise.all(
			[badge, struk, page.getByRole('link', { name: 'Suara' })].map(
				async (l) => (await l.boundingBox())!.x
			)
		);
		expect([...xs].sort((a, b) => a - b)).toEqual(xs);
		const header = (await page.locator('header.topbar').boundingBox())!;
		const suara = (await page.getByRole('link', { name: 'Suara' }).boundingBox())!;
		expect(suara.y).toBeLessThan(header.y + header.height);
		await badge.focus();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('link', { name: 'Suara' })).toBeFocused();
	}
});

test('the badge names the server’s WIB date and opens /kalender', async ({ page }) => {
	await page.goto('/');
	await waitForHydration(page);
	const date = new Intl.DateTimeFormat('id-ID', {
		timeZone: 'Asia/Jakarta',
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	}).format(new Date());
	const badge = page.getByRole('link', { name: `Kalender, ${date}` });
	await expect(badge).toBeVisible();
	const box = (await badge.boundingBox())!;
	expect(box.width).toBeGreaterThanOrEqual(44);
	expect(box.height).toBeGreaterThanOrEqual(44);
	await badge.click();
	await expect(page).toHaveURL(/\/kalender$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Kalender' })).toBeVisible();
});

test('the hero card keeps its height from first paint to hydration (no layout shift)', async ({
	browser,
	page
}) => {
	const viewport = page.viewportSize()!;
	const noJs = await browser.newContext({
		javaScriptEnabled: false,
		viewport,
		storageState: await page.context().storageState()
	});
	const plain = await noJs.newPage();
	await plain.goto(`${BASE}/`);
	const before = (await plain.locator('section.greeting').boundingBox())!.height;
	await page.goto('/');
	await waitForHydration(page);
	const after = (await page.locator('section.greeting').boundingBox())!.height;
	expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
	await noJs.close();
});

test('without JavaScript: the hero, the badge link and the ask form’s target all work', async ({
	browser,
	page
}) => {
	const noJs = await browser.newContext({
		javaScriptEnabled: false,
		storageState: await page.context().storageState()
	});
	const plain = await noJs.newPage();
	await plain.goto(`${BASE}/`);
	await expect(plain.getByText(/^Selamat (pagi|siang|sore|malam)\.$/)).toBeVisible();
	await plain.getByRole('link', { name: /^Kalender, / }).click();
	await expect(plain).toHaveURL(/\/kalender$/);
	// The GET form's target: Tanya opens with the question in its composer and sends nothing.
	await plain.goto(`${BASE}/tanya?q=${encodeURIComponent('Bulan lalu habis berapa buat kopi?')}`);
	await expect(plain.getByRole('textbox', { name: 'Pertanyaanmu' })).toHaveValue(
		'Bulan lalu habis berapa buat kopi?'
	);
	await noJs.close();
});
