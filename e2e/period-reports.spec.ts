import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalScroll, isPhone, simulatedClientIp, waitForHydration } from './helpers';
import { d1, spaceIdOf } from './d1';
import { addWallet, BASE, freshUser, ids, postForm, rp, today } from './ledger';
import { stripScripts, stripTags } from '../test/helpers/html';

/**
 * FN-53 period reports: the Bulan | Kuartal | Tahun switcher on /alur-uang (with and without JavaScript, Back
 * button, 360 px) and /kekayaan/laporan. Each test signs up its own fictional user; setup goes through the app's own
 * form actions. Screenshots for the engineer report go to the feature folder.
 */

const SHOTS = 'docs/features/fn-53-period-reports/shots';

const year = () => today().slice(0, 4);
const quarter = () => Math.floor((Number(today().slice(5, 7)) - 1) / 3) + 1;
/** A date in the previous quarter (ten days before this quarter began). */
function lastQuarterDate(): string {
	const start = Date.UTC(Number(year()), (quarter() - 1) * 3, 1);
	return new Date(start - 10 * 86_400_000).toISOString().slice(0, 10);
}

/** `YYYY-Qn` of the previous quarter. */
const previousQuarter = () => {
	const date = lastQuarterDate();
	return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
};

/** BCA; salary and coffee today; a meal in the previous quarter. */
async function seed(page: Page) {
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	const bca = await wallet('BCA');
	const post = async (o: Record<string, string>) =>
		expect(
			(
				await postForm(page, '/riwayat/baru?/create', {
					type: 'expense',
					walletId: bca,
					note: '',
					occurredTime: '',
					occurredOn: today(),
					...o
				})
			).status()
		).toBe(303);
	await post({
		type: 'income',
		categoryId: await category('Gaji'),
		amount: '9000000',
		title: 'Gaji'
	});
	await post({ categoryId: await category('Kopi'), amount: '25000', title: 'Kopi' });
	await post({
		categoryId: await category('Makan'),
		amount: '45000',
		title: 'Warteg',
		occurredOn: lastQuarterDate()
	});
}

const kind = (page: Page, name: 'Bulan' | 'Kuartal' | 'Tahun') =>
	page.getByRole('radiogroup', { name: 'Jenis periode' }).getByRole('radio', { name });

test('Bulan → Kuartal → Tahun are navigations: Back returns each period, reload keeps it', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'periode');
	await seed(page);
	await page.goto('/alur-uang');
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Alur uang' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Perbandingan' })).toBeVisible();

	await kind(page, 'Kuartal').check();
	await page.waitForURL(`${BASE}/alur-uang?k=${year()}-Q${quarter()}`);
	await expect(page.getByText(`Q${quarter()} '${year().slice(2)}`)).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Rata-rata per bulan' })).toBeVisible();
	await expect(page.getByText('Dibagi', { exact: false })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Per bulan', exact: true })).toBeVisible();
	await expect(
		page.getByText(`${rp('9.000.000')} masuk · ${rp('25.000')} keluar`).first()
	).toBeVisible();

	await kind(page, 'Tahun').check();
	await page.waitForURL(`${BASE}/alur-uang?y=${year()}`);
	await expect(page.locator('header .subtitle')).toHaveText(`Tahun ${year()} · sejauh ini`);
	await expectNoHorizontalScroll(page);

	await page.goBack();
	await page.waitForURL(`${BASE}/alur-uang?k=${year()}-Q${quarter()}`);
	await expect(kind(page, 'Kuartal')).toBeChecked();
	await page.goBack();
	await page.waitForURL(`${BASE}/alur-uang`);
	await expect(kind(page, 'Bulan')).toBeChecked();

	// The previous quarter, by its stepper link; reload shows the same period and its meal.
	await page.goto(`/alur-uang?k=${year()}-Q${quarter()}`);
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Periode sebelumnya' }).click();
	await page.waitForURL(`${BASE}/alur-uang?k=${previousQuarter()}`);
	const url = page.url();
	await page.reload();
	expect(page.url()).toBe(url);
	await expect(page.getByText(`${rp('45.000')} keluar`).first()).toBeVisible();
	await context.close();
});

test('keyboard: arrows on the switch change the period; the switch sits on its own row at 360 px', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'periode');
	await seed(page);
	await page.goto('/alur-uang');
	await waitForHydration(page);
	await kind(page, 'Bulan').focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForURL(/\/alur-uang\?k=/);
	const group = page.getByRole('radiogroup', { name: 'Jenis periode' });
	const h1 = await page.getByRole('heading', { level: 1 }).boundingBox();
	const box = await group.boundingBox();
	if (isPhone(page)) {
		// Its own full-width row under the title; every option a 44 px target.
		expect(box!.y).toBeGreaterThan(h1!.y + h1!.height - 1);
		const main = await page.locator('main').boundingBox();
		expect(box!.width).toBeGreaterThan(main!.width * 0.6);
		for (const option of await group.locator('label').all())
			expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	} else {
		// In the title row.
		expect(Math.abs(box!.y + box!.height - (h1!.y + h1!.height))).toBeLessThan(40);
	}
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('without JavaScript: the switch is a GET form with "Tampilkan"; stepper links work', async ({
	browser
}, testInfo) => {
	const signedUp = await freshUser(browser, testInfo, 'periode');
	await seed(signedUp.page);
	const storageState = await signedUp.context.storageState();
	await signedUp.context.close();
	const context = await browser.newContext({
		storageState,
		javaScriptEnabled: false,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
	});
	const page = await context.newPage();
	await page.goto('/alur-uang');
	await kind(page, 'Kuartal').check();
	await page.getByRole('button', { name: 'Tampilkan' }).click();
	await page.waitForURL(/\/alur-uang\?p=\d{4}-\d{2}&m=kuartal$/);
	await expect(kind(page, 'Kuartal')).toBeChecked();
	await expect(page.getByRole('heading', { name: 'Rata-rata per bulan' })).toBeVisible();
	await page.getByRole('link', { name: 'Periode sebelumnya' }).click();
	await page.waitForURL(`${BASE}/alur-uang?k=${previousQuarter()}`);
	await expect(page.getByText(`${rp('45.000')} keluar`).first()).toBeVisible();
	await kind(page, 'Tahun').check();
	await page.getByRole('button', { name: 'Tampilkan' }).click();
	await page.waitForURL(`${BASE}/alur-uang?k=${previousQuarter()}&m=tahun`);
	await expect(kind(page, 'Tahun')).toBeChecked();
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('hidden amounts: both pages’ server HTML carries no figure', async ({ browser }, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'periode');
	await seed(page);
	const paths = [`/alur-uang?k=${year()}-Q${quarter()}`, '/alur-uang', '/kekayaan/laporan'];
	const figure = (html: string) => /9\.000\.000|25\.000|9\.030\.000/.test(html);
	for (const p of paths.slice(0, 2))
		expect(figure(await (await page.request.get(p)).text()), p).toBe(true);
	const { origin } = new URL(page.url());
	await context.addCookies([{ name: 'montra-amounts-hidden', value: '1', url: origin }]);
	for (const p of paths) {
		const html = await (await page.request.get(p)).text();
		expect(figure(html), p).toBe(false);
		expect(html, p).toContain('••••');
	}
	await context.close();
});

test('Laporan kekayaan: from Kekayaan, the current quarter closes with the live total; Tahun and back links', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'periode');
	await seed(page);
	await page.goto('/kekayaan');
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Laporan kuartal dan tahun' }).click();
	await page.waitForURL(`${BASE}/kekayaan/laporan`);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Laporan kekayaan' })).toBeVisible();
	await expect(kind(page, 'Kuartal')).toBeChecked();
	// No snapshot yet (the jobs tick writes them): the change is unavailable, never zero; the closing is "sekarang".
	await expect(page.getByText('Belum cukup catatan untuk menghitung perubahan')).toBeVisible();
	await expect(page.getByText(/Nilai akhir Rp\s9\.030\.000 \(sekarang\)/)).toBeVisible();
	const slider = page.getByRole('slider', { name: /Kekayaan bersih per bulan/ });
	await slider.focus();
	const before = await slider.getAttribute('aria-valuenow');
	await page.keyboard.press('ArrowLeft');
	expect(await slider.getAttribute('aria-valuenow')).not.toBe(before);
	await expectNoHorizontalScroll(page);
	await kind(page, 'Tahun').check();
	await page.waitForURL(`${BASE}/kekayaan/laporan?y=${year()}`);
	await page.getByRole('link', { name: 'Lihat alur uang' }).click();
	await page.waitForURL(`${BASE}/alur-uang?y=${year()}`);
	await context.close();
});

test('Laporan kekayaan: a space without wallets or assets shows the empty state', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'periode');
	await page.goto('/kekayaan/laporan');
	await expect(page.getByRole('heading', { name: 'Belum ada catatan kekayaan' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Tambah dompet' })).toHaveAttribute(
		'href',
		'/dompet'
	);
	await expectNoHorizontalScroll(page);
	await context.close();
});

/** A user whose net worth fell this quarter by Rp 124.900.000 (a debt of Rp 10.000.000 paid off). */
async function fall(browser: Browser, testInfo: TestInfo) {
	const { context, page, email } = await freshUser(browser, testInfo, 'periode');
	await seed(page);
	// An expense on the 1st of last month, so this month's comparison has a previous period with rows.
	const { wallet, category } = await ids(page);
	const firstOfLastMonth = new Date(Date.UTC(Number(year()), Number(today().slice(5, 7)) - 2, 1))
		.toISOString()
		.slice(0, 10);
	await postForm(page, '/riwayat/baru?/create', {
		type: 'expense',
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '1000',
		title: 'Kopi lalu',
		note: '',
		occurredOn: firstOfLastMonth,
		occurredTime: ''
	});
	const space = spaceIdOf(email);
	// The day before this quarter: Rp 133.929.000 with a debt of Rp 10.000.000 (live now: Rp 9.029.000, no debt).
	const dayBefore = new Date(Date.UTC(Number(year()), (quarter() - 1) * 3, 1) - 86_400_000)
		.toISOString()
		.slice(0, 10);
	d1(
		`insert into net_worth_snapshots(space_id,date,total_minor,currency,partial,created_at,updated_at,deleted_at,seq,classes)
		values ('${space}','${dayBefore}',13392900000,'IDR',0,1,1,null,1,'{"wallets":14392900000,"debt":-1000000000}')`
	);
	return { context, page };
}

test('a fall: the hero shows the change once, as −Rp (U+2212)', async ({ browser }, testInfo) => {
	const { context, page } = await fall(browser, testInfo);
	await page.goto('/kekayaan/laporan');
	await waitForHydration(page);
	const main = page.locator('main');
	await expect(main.getByText('Turun', { exact: true })).toBeVisible();
	await expect(main.locator('.figure')).toHaveText('\u2212Rp124.900.000');
	// Shown once: the hero only (the from/to line names the two totals, not the change).
	expect(await main.getByText(/124\.900\.000/).count()).toBe(1);
	await expect(main.getByText(/Utang berkurang/)).toBeVisible();
	await context.close();
});

test('hidden amounts hide every direction word, sign and glyph from the server HTML (red team L2)', async ({
	browser
}, testInfo) => {
	const { context, page } = await fall(browser, testInfo);
	expect(await (await page.request.get('/alur-uang')).text()).toMatch(/lebih (banyak|sedikit)/);
	expect(await (await page.request.get('/kekayaan/laporan')).text()).toMatch(/Turun/);
	const { origin } = new URL(page.url());
	await context.addCookies([{ name: 'montra-amounts-hidden', value: '1', url: origin }]);
	const direction =
		/Naik|Turun|Tetap|Utang berkurang|Utang bertambah|lebih banyak|lebih sedikit|Sama dengan|[↑↓]|[\u2212+]Rp/;
	for (const path of ['/kekayaan/laporan', '/alur-uang']) {
		const text = stripTags(stripScripts(await (await page.request.get(path)).text()), ' ');
		expect(text, path).not.toMatch(direction);
		expect(text, path).toContain('••••');
	}
	await context.close();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`screenshots in ${colorScheme}`, async ({ browser }, testInfo) => {
		const signedUp = await freshUser(browser, testInfo, 'periode');
		await seed(signedUp.page);
		const storageState = await signedUp.context.storageState();
		await signedUp.context.close();
		const phone = testInfo.project.name === 'phone';
		const context = await browser.newContext({
			storageState,
			colorScheme,
			viewport: phone ? { width: 360, height: 780 } : { width: 1440, height: 900 },
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
		});
		const page = await context.newPage();
		mkdirSync(SHOTS, { recursive: true });
		for (const [name, path] of [
			['alur-kuartal', `/alur-uang?k=${year()}-Q${quarter()}`],
			['alur-tahun', `/alur-uang?y=${year()}`],
			['kekayaan-laporan', '/kekayaan/laporan']
		] as const) {
			await page.goto(path);
			await waitForHydration(page);
			await expectNoHorizontalScroll(page);
			await page.screenshot({
				path: `${SHOTS}/${name}-${phone ? '360' : '1440'}-${colorScheme}.png`,
				fullPage: true
			});
		}
		await context.close();
	});
}
