import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalScroll, simulatedClientIp, waitForHydration } from './helpers';
import { addWallet, freshUser, ids, postExpense } from './ledger';

/**
 * UI polish pass: before/after screenshots of the four fixed screens (Alur uang ribbons, Beranda Struk button
 * and empty compare line, Langganan/Barang/Koleksi rows, Laporan compare line). Runs only with
 * SHOTS_PHASE=before|after (it only takes pictures) and only in the phone project (it opens its own 360 px and
 * 1440 px contexts). Each test signs up its own fictional user; data goes through the app's own forms.
 */

const SHOTS = 'docs/features/ui-polish/shots';
const PHASE = process.env.SHOTS_PHASE ?? '';

/** Screenshots only: with SHOTS_PHASE=before|after, in the phone project. */
const only = (testInfo: TestInfo) =>
	test.skip(
		!PHASE || testInfo.project.name !== 'phone',
		'SHOTS_PHASE unset or not the phone project'
	);

type Shot = { width: 360 | 1440; scheme: 'light' | 'dark' };
const ALL: Shot[] = [
	{ width: 360, scheme: 'light' },
	{ width: 360, scheme: 'dark' },
	{ width: 1440, scheme: 'light' },
	{ width: 1440, scheme: 'dark' }
];

async function snap(
	browser: Browser,
	testInfo: TestInfo,
	storageState: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>,
	name: string,
	path: string,
	shots: Shot[],
	ready?: (page: Page) => Promise<void>
) {
	mkdirSync(SHOTS, { recursive: true });
	let n = 2;
	for (const { width, scheme } of shots) {
		const context = await browser.newContext({
			storageState,
			colorScheme: scheme,
			viewport: width === 360 ? { width: 360, height: 780 } : { width: 1440, height: 900 },
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, n++) }
		});
		const page = await context.newPage();
		await page.goto(path);
		await waitForHydration(page);
		if (ready) await ready(page);
		await expectNoHorizontalScroll(page);
		await page.screenshot({
			path: `${SHOTS}/${name}-${width}-${scheme}-${PHASE}.png`,
			fullPage: true
		});
		await context.close();
	}
}

test('alur uang', async ({ browser }, testInfo) => {
	only(testInfo);
	const { context, page } = await freshUser(browser, testInfo, 'polish');
	await addWallet(page, 'BCA');
	await addWallet(page, 'GoPay');
	const { wallet, category } = await ids(page);
	const bca = await wallet('BCA');
	const gopay = await wallet('GoPay');
	const kopi = await category('Kopi');
	await postExpense(page, {
		type: 'income',
		walletId: bca,
		categoryId: await category('Gaji'),
		amount: '9000000',
		title: 'Gaji Oktober'
	});
	await postExpense(page, {
		walletId: bca,
		categoryId: await category('Makan'),
		amount: '1450000',
		title: 'Belanja bulanan'
	});
	await postExpense(page, { walletId: bca, categoryId: kopi, amount: '25000', title: 'Kopi' });
	await postExpense(page, { walletId: gopay, categoryId: kopi, amount: '18000', title: 'Kopi' });
	await postExpense(page, {
		walletId: gopay,
		categoryId: await category('Transportasi'),
		amount: '4000',
		title: 'Parkir'
	});
	const state = await context.storageState();
	await context.close();
	await snap(browser, testInfo, state, 'alur-uang', '/alur-uang', ALL, async (p) => {
		await expect(p.locator('main svg[role="group"]')).toBeVisible();
	});
});

test('beranda and laporan, empty', async ({ browser }, testInfo) => {
	only(testInfo);
	const { context } = await freshUser(browser, testInfo, 'polish');
	const state = await context.storageState();
	await context.close();
	await snap(browser, testInfo, state, 'beranda-empty', '/', ALL);
	await snap(browser, testInfo, state, 'laporan-empty', '/laporan', [
		{ width: 360, scheme: 'light' },
		{ width: 1440, scheme: 'light' }
	]);
});

test('langganan, barang, koleksi rows', async ({ browser }, testInfo) => {
	only(testInfo);
	const { context, page } = await freshUser(browser, testInfo, 'polish');
	await addWallet(page, 'BCA');
	const subs: [string, string, string, string][] = [
		['Netflix', '186000', 'monthly', '8'],
		['YouTube Premium Family', '119000', 'monthly', '28'],
		['Laundry Kiloan', '60000', 'weekly', '5'],
		['Domain montra', '210000', 'yearly', '3']
	];
	for (const [name, amount, cycle, day] of subs) {
		const res = await page.request.post('/langganan?/createSubscription', {
			form: {
				catalogueId: '',
				name,
				category: 'lainnya',
				amount,
				currency: 'IDR',
				cycle,
				day,
				weekday: day,
				month: '11',
				walletId: '',
				reminderDays: '1'
			},
			headers: { origin: new URL(page.url()).origin, accept: 'text/html' },
			maxRedirects: 0
		});
		expect([200, 303]).toContain(res.status());
	}
	await page.goto('/barang');
	await waitForHydration(page);
	for (const name of ['Laptop kerja', 'Sepeda lipat untuk ke kantor']) {
		await page.getByRole('link', { name: 'Tambah barang' }).first().click();
		const sheet = page.getByRole('dialog', { name: 'Tambah barang' });
		await sheet.getByLabel('Nama barang').fill(name);
		await sheet.getByLabel('Harga beli').fill('12.000.000');
		await sheet.getByLabel('Tanggal beli').fill('2024-01-15');
		await sheet.getByRole('button', { name: 'Tambah barang' }).click();
		await expect(sheet).toBeHidden();
	}
	await page.goto('/koleksi');
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Tambah koleksi' }).first().click();
	const sheet = page.getByRole('dialog', { name: 'Tambah koleksi' });
	await sheet.getByLabel('Nama koleksi').fill('Kartu Pokemon Charizard edisi pertama');
	await sheet.getByLabel('Harga beli').fill('1.500.000');
	await sheet.getByLabel('Tanggal beli').fill('2024-01-15');
	await sheet.getByLabel('Nilai sekarang').fill('4.250.000');
	await sheet.getByRole('button', { name: 'Tambah koleksi' }).click();
	await expect(sheet).toBeHidden();
	const state = await context.storageState();
	await context.close();
	await snap(browser, testInfo, state, 'langganan', '/langganan', ALL, async (p) => {
		if (PHASE !== 'after' || p.viewportSize()!.width !== 360) return;
		// Two lines per row and the schedule line not cut off, at 360 px.
		const rows = await p.locator('main li .body').evaluateAll((els) =>
			els.map((e) => {
				const meta = e.querySelector('.meta') as HTMLElement;
				return { h: e.getBoundingClientRect().height, cut: meta.scrollWidth > meta.clientWidth };
			})
		);
		expect(rows).toHaveLength(4);
		for (const r of rows) expect(r).toMatchObject({ cut: false });
		for (const r of rows) expect(r.h).toBeLessThanOrEqual(50);
	});
	await snap(browser, testInfo, state, 'barang', '/barang', [{ width: 360, scheme: 'light' }]);
	await snap(browser, testInfo, state, 'koleksi', '/koleksi', [{ width: 360, scheme: 'light' }]);
});
