import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, isPhone, simulatedClientIp, waitForHydration } from './helpers';
import { addWallet, BASE, freshUser, ids, postExpense, postForm, rp, today } from './ledger';

/**
 * FN-07/08 journeys: Beranda's budget, safe-to-spend line, today's list and chart picker. Every test signs up
 * its own fictional user in its own context, so its personal space starts empty.
 */

const main = (page: Page) => page.locator('main');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Anggaran bulanan' });
/** "Rp3 jt tersisa · Rp… rb sehari untuk N hari" (compact amounts use a no-break space before the unit). */
const sisa = (millions: number) =>
	new RegExp(`Rp${millions}\\sjt tersisa · Rp.+ sehari untuk \\d+ hari`);

const shiftDays = (date: string, days: number) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};

async function openBeranda(page: Page) {
	await page.goto('/');
	await waitForHydration(page);
}

async function setBudgetInSheet(page: Page, opener: string, amount: string) {
	await main(page).getByRole('link', { name: opener }).click();
	await expect(sheet(page)).toBeVisible();
	await sheet(page).getByLabel('Anggaran per bulan').fill(amount);
	await sheet(page).getByRole('button', { name: 'Simpan' }).click();
	await expect(sheet(page)).toBeHidden();
}

test('budget set in the sheet shows the safe-to-spend line and survives a reload', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn07');
	await openBeranda(page);
	await expect(main(page).getByText(/^Pengeluaran \p{L}+$/u)).toBeVisible();
	await expect(main(page).getByText('Belum ada transaksi hari ini.')).toBeVisible();
	await expect(main(page).getByText(/ tersisa · /)).toHaveCount(0);

	await setBudgetInSheet(page, 'Atur anggaran', '3000000');
	await expect(page.getByText('Anggaran disimpan.')).toBeVisible();
	await expect(main(page).getByText(sisa(3))).toBeVisible();

	await page.reload();
	await expect(main(page).getByText(sisa(3))).toBeVisible();
	await expect(main(page).getByRole('link', { name: 'Ubah anggaran' })).toBeVisible();
	await context.close();
});

test('edit the budget, then "Hapus anggaran" returns Beranda to the no-budget state', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn07');
	await openBeranda(page);
	await setBudgetInSheet(page, 'Atur anggaran', '3000000');
	await expect(main(page).getByText(sisa(3))).toBeVisible();

	await setBudgetInSheet(page, 'Ubah anggaran', '4000000');
	await expect(main(page).getByText(sisa(4))).toBeVisible();

	await main(page).getByRole('link', { name: 'Ubah anggaran' }).click();
	await expect(sheet(page).getByLabel('Anggaran per bulan')).toHaveValue('4.000.000');
	await sheet(page).getByRole('button', { name: 'Hapus anggaran' }).click();
	await expect(sheet(page)).toBeHidden();
	await expect(page.getByText('Anggaran dihapus.')).toBeVisible();
	await expect(main(page).getByRole('link', { name: 'Atur anggaran' })).toBeVisible();
	await expect(main(page).getByText(/ tersisa · /)).toHaveCount(0);
	await page.reload();
	await expect(main(page).getByRole('link', { name: 'Atur anggaran' })).toBeVisible();
	await context.close();
});

test('chart picker switches views without a request; tapping a bar changes the readout', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn07');
	await addWallet(page, 'BCA', '1.000.000');
	const { wallet, category } = await ids(page);
	const walletId = await wallet('BCA');
	await postExpense(page, {
		walletId,
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi'
	});
	await postForm(page, '/riwayat/baru?/create', {
		type: 'expense',
		amount: '10.000',
		walletId,
		categoryId: await category('Transportasi'),
		title: 'Parkir',
		note: '',
		occurredOn: shiftDays(today(), -1),
		occurredTime: ''
	});

	await openBeranda(page);
	const requests: string[] = [];
	page.on('request', (r) => requests.push(r.url()));

	const picker = main(page).getByRole('combobox', { name: 'Grafik pengeluaran' });
	await expect(picker).toHaveValue('daily');
	const chart = main(page).getByRole('group', { name: 'Pengeluaran 14 hari terakhir' });
	const readout = main(page).locator('figcaption');
	await expect(readout).toContainText(rp('25.000'));
	// Accessible names normalise the no-break space to a plain space.
	await chart.getByRole('button', { name: /: Rp\s10\.000$/ }).click();
	await expect(readout).toContainText(rp('10.000'));

	await picker.selectOption('category');
	await expect(main(page).getByRole('img', { name: 'Pengeluaran per kategori' })).toBeVisible();
	const legend = main(page).locator('.legend li');
	await expect(legend.first()).toContainText('Kopi');
	await expect(legend.first()).toContainText(rp('25.000'));

	await picker.selectOption('lines');
	await expect(
		main(page).getByRole('img', { name: 'Bulan ini dibanding bulan lalu' })
	).toBeVisible();

	// All three views come from the data already loaded: no page or data request while switching.
	expect(requests.filter((u) => u.includes('__data.json') || new URL(u).pathname === '/')).toEqual(
		[]
	);
	await context.close();
});

test('at 360 px: no horizontal scroll, 44 px bar and picker targets, focus returns to the opener', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn07');
	test.skip(!isPhone(page), 'phone layout only');
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi'
	});
	await openBeranda(page);
	await expectNoHorizontalScroll(page);

	// Every day of the bar chart is a ≥44×44 px target; the chart scrolls inside itself, today in view.
	const bars = main(page)
		.getByRole('group', { name: 'Pengeluaran 14 hari terakhir' })
		.getByRole('button');
	await expect(bars).toHaveCount(14);
	for (const bar of await bars.all()) {
		const box = (await bar.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
	}
	await expect(bars.last()).toBeInViewport();
	await expect(bars.last()).toHaveAttribute('aria-pressed', 'true');
	await bars.nth(12).focus();
	await page.keyboard.press(' ');
	await expect(bars.nth(12)).toHaveAttribute('aria-pressed', 'true');
	await expectNoHorizontalScroll(page);

	const picker = await main(page)
		.getByRole('combobox', { name: 'Grafik pengeluaran' })
		.boundingBox();
	expect(picker!.height).toBeGreaterThanOrEqual(44);
	const opener = main(page).getByRole('link', { name: 'Atur anggaran' });
	expect((await opener.boundingBox())!.height).toBeGreaterThanOrEqual(44);

	await opener.focus();
	await page.keyboard.press('Enter');
	await expect(sheet(page)).toBeVisible();
	await expectNoHorizontalScroll(page);
	await page.keyboard.press('Escape');
	await expect(sheet(page)).toBeHidden();
	await expect(opener).toBeFocused();
	await context.close();
});

test('without JavaScript the budget form works as a plain form: refusal and success', async ({
	browser
}, testInfo) => {
	const signedUp = await freshUser(browser, testInfo, 'fn07');
	const storageState = await signedUp.context.storageState();
	await signedUp.context.close();
	const context = await browser.newContext({
		storageState,
		javaScriptEnabled: false,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
	});
	const page = await context.newPage();
	await page.goto('/');
	await main(page).getByRole('link', { name: 'Atur anggaran' }).click();
	await page.waitForURL(`${BASE}/?anggaran=1`);
	const inline = main(page).locator('section', {
		has: page.getByRole('heading', { name: 'Anggaran bulanan' })
	});
	await inline.getByLabel('Anggaran per bulan').fill('0');
	await inline.getByRole('button', { name: 'Simpan' }).click();
	await expect(
		page.getByText('Isi anggaran lebih dari 0 dengan angka bulat, tanpa sen.')
	).toBeVisible();

	await inline.getByLabel('Anggaran per bulan').fill('2.000.000');
	await inline.getByRole('button', { name: 'Simpan' }).click();
	await expect(page.getByText('Anggaran disimpan.')).toBeVisible();
	await expect(main(page).getByText(sisa(2))).toBeVisible();
	await page.goto('/');
	await expect(main(page).getByText(sisa(2))).toBeVisible();
	await context.close();
});

test('an expense saved on /riwayat/baru shows on Beranda: hero, today header and list', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn07');
	await addWallet(page, 'BCA');
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await page.getByLabel('Jumlah').fill('25000');
	await page.getByRole('radio', { name: /Kopi/ }).check();
	await page.getByLabel('Judul (opsional)').fill('Kopi susu');
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();
	await page.waitForURL(/\/riwayat\?saved=created/);

	await openBeranda(page);
	const month = new Intl.DateTimeFormat('id-ID', {
		timeZone: 'Asia/Jakarta',
		month: 'long'
	}).format(new Date());
	const hero = main(page).locator('section.hero');
	await expect(hero).toContainText(`Pengeluaran ${month}`);
	await expect(hero).toContainText('Rp25.000');
	const todaySection = main(page).locator('section.today');
	await expect(todaySection).toContainText(/Pengeluaran hari ini\s+−Rp\s25\.000/);
	const recent = main(page).locator('section', {
		has: page.getByRole('heading', { name: 'Terbaru' })
	});
	const row = recent.getByRole('link').filter({ hasText: 'Kopi susu' });
	await expect(row).toContainText(`−${rp('25.000')}`);
	await expect(row).toContainText('Kopi · BCA');
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('the eye button hides every amount on Beranda, survives a reload and leaves other pages alone', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn07');
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi susu'
	});
	await openBeranda(page);
	const hero = main(page).locator('section.hero');
	const eye = hero.getByRole('button', { name: 'Sembunyikan nominal' });
	const recent = main(page).locator('section', {
		has: page.getByRole('heading', { name: 'Terbaru' })
	});
	await expect(hero).toContainText('Rp25.000');
	await expect(eye).toHaveAttribute('aria-pressed', 'false');

	await eye.click();
	await expect(eye).toHaveAttribute('aria-pressed', 'true');
	await expect(hero).toContainText('Rp••••');
	await expect(hero).not.toContainText('25.000');
	await expect(recent).toContainText('••••');
	await expect(recent).not.toContainText('25.000');

	await page.reload();
	await waitForHydration(page);
	await expect(eye).toHaveAttribute('aria-pressed', 'true');
	await expect(hero).not.toContainText('25.000');
	// FN-25b red team 1: the server's HTML is already masked, so nothing flashes before hydration.
	const html = await (await page.request.get('/')).text();
	const at = html.indexOf('<section class="hero');
	const heroHtml = html.slice(at, html.indexOf('</section>', at));
	expect(at).toBeGreaterThanOrEqual(0);
	expect(heroHtml).toContain('••••');
	expect(heroHtml).not.toContain('25.000');

	// Transaksi has no hero: its amounts always show.
	await page.goto('/riwayat');
	await expect(main(page).getByRole('link').filter({ hasText: 'Kopi susu' })).toContainText(
		`−${rp('25.000')}`
	);

	await openBeranda(page);
	await eye.click();
	await expect(eye).toHaveAttribute('aria-pressed', 'false');
	await expect(hero).toContainText('Rp25.000');
	await expect(recent).toContainText(`−${rp('25.000')}`);
	await context.close();
});

test('FN-34: "Tutup hari ini" closes today once, shows the streak chip and survives a reload', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn34');
	await openBeranda(page);
	const card = main(page).locator('section.today');
	const chip = main(page).locator('.day-chip');
	const closeButton = card.getByRole('button', { name: 'Tutup hari ini' });
	await expect(chip).toHaveText('0 hari berturut-turut');
	await expect(card.getByText('Belum ada transaksi hari ini.')).toBeVisible();
	await expect(closeButton).toBeVisible();
	if (isPhone(page)) {
		// A full-width tap target ≥ 44 px; neither it nor the chip widens the page at 360 px.
		const button = (await closeButton.boundingBox())!;
		const inner = (await card.boundingBox())!;
		expect(button.height).toBeGreaterThanOrEqual(44);
		// The chip stays one line inside its pill (QA FN-34 #1).
		expect(await chip.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
		expect(button.width).toBeGreaterThanOrEqual(inner.width - 2 * 18 - 1);
		await expectNoHorizontalScroll(page);
	}

	await closeButton.click();
	await expect(card.getByRole('status')).toHaveText('Hari ini ditutup · 1 hari berturut-turut');
	await expect(closeButton).toHaveCount(0);
	await expect(chip).toHaveText('1 hari berturut-turut');
	await expectNoHorizontalScroll(page);

	await page.reload();
	await expect(card.getByRole('status')).toHaveText('Hari ini ditutup · 1 hari berturut-turut');
	await expect(closeButton).toHaveCount(0);
	await expect(chip).toHaveText('1 hari berturut-turut');
	await expect(card.getByRole('link', { name: 'Catat transaksi' })).toBeVisible();
	await context.close();
});
