import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, TX_PAGE, waitForHydration } from './helpers';
import { addWallet, BASE, freshUser, ids, PASSWORD, postExpense, rp } from './ledger';
import { composeOffline, PUSH, QUEUED_HERE, queueOneBlocked, queueSize } from './offline-queue';

/**
 * FN-02 offline write queue. Offline is Playwright's `context.setOffline` (navigator.onLine false, the
 * `offline`/`online` events, every request failing); "online but the server unreachable" is the push endpoint
 * aborted with `route.abort()`. Every test signs up its own fictional user.
 */
const main = (page: Page) => page.locator('main');
const txRows = (page: Page, title: string) =>
	main(page).getByRole('link').filter({ hasText: title });

async function user(
	browser: Parameters<typeof freshUser>[0],
	testInfo: Parameters<typeof freshUser>[1]
) {
	const { context, page } = await freshUser(browser, testInfo, 'fn02');
	await addWallet(page, 'BCA');
	const email = await page.evaluate(async () => {
		const r = await fetch('/pengaturan/akun/__data.json');
		const text = await r.text();
		return /[\w.-]+@example\.test/.exec(text)?.[0] ?? '';
	});
	return { context, page, email };
}

async function signIn(page: Page, email: string) {
	await page.goto('/masuk');
	await waitForHydration(page);
	await page.getByLabel('E-mail').fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk', exact: true }).click();
	await page.waitForURL(`${BASE}/`);
}

test('offline create: "Menunggu koneksi", never saved; online: one row, badge clears, a second drain adds nothing', async ({
	browser
}, testInfo) => {
	const { context, page } = await user(browser, testInfo);
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await context.setOffline(true);
	await composeOffline(page, '25000', 'Kopi antre');
	await expect(page.getByText(QUEUED_HERE)).toBeVisible();
	await expect(page.getByText('Menunggu koneksi · 1 menunggu')).toBeVisible();
	await expect(page.getByText(/tersimpan/i)).toHaveCount(0);
	expect(await queueSize(page)).toBe(1);
	await expectNoHorizontalScroll(page);

	await page.getByText('Menunggu koneksi · 1 menunggu').click();
	await expect(page.getByRole('dialog')).toContainText(`Kopi antre · ${rp('25.000')}`);
	await page.keyboard.press('Escape');

	await context.setOffline(false);
	await expect(page.getByText('1 perubahan tersimpan.')).toBeVisible();
	expect(await queueSize(page)).toBe(0);
	// A forced second drain (another online event) sends nothing more.
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await page.goto('/riwayat');
	await expect(txRows(page, 'Kopi antre')).toHaveCount(1);
	await expect(txRows(page, 'Kopi antre')).toContainText(`−${rp('25.000')}`);
	await context.close();
});

test('an offline edit loses to a change made meanwhile on a second device: failed with the reason, no overwrite', async ({
	browser
}, testInfo) => {
	const { context, page } = await user(browser, testInfo);
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi dua'
	});
	await page.goto('/riwayat');
	await txRows(page, 'Kopi dua').click();
	// A client-side navigation keeps the hydrated root layout: wait for the edit page's URL itself.
	await page.waitForURL(TX_PAGE);
	await waitForHydration(page);
	const editUrl = page.url();

	// Device 2: same account, its own browser context.
	const device2 = await browser.newContext({ storageState: await context.storageState() });
	const page2 = await device2.newPage();
	await page2.goto(editUrl);
	await waitForHydration(page2);

	await context.setOffline(true);
	await page.getByLabel('Jumlah').fill('30000');
	await page.getByRole('button', { name: 'Simpan perubahan' }).click();
	await expect(page.getByText(QUEUED_HERE)).toBeVisible();
	// The forms give way: no second, conflicting change can be queued from this page.
	await expect(page.getByRole('button', { name: 'Simpan perubahan' })).toHaveCount(0);

	await page2.getByLabel('Jumlah').fill('40000');
	await page2.getByRole('button', { name: 'Simpan perubahan' }).click();
	await page2.waitForURL(/\/riwayat\?saved=updated/);

	await context.setOffline(false);
	await expect(page.getByText('1 perubahan gagal dikirim')).toBeVisible();
	await page.getByText('1 perubahan gagal dikirim').click();
	await expect(page.getByRole('dialog')).toContainText(
		'Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.'
	);
	await expect(
		page.getByRole('dialog').getByRole('link', { name: 'Buka transaksi' })
	).toBeVisible();
	await page2.goto('/riwayat');
	await expect(txRows(page2, 'Kopi dua')).toContainText(`−${rp('40.000')}`);
	await device2.close();
	await context.close();
});

test('voice offline: the reviewed rows are queued, then saved once online with source voice', async ({
	browser
}, testInfo) => {
	const { context, page } = await user(browser, testInfo);
	await page.goto('/riwayat/suara');
	await waitForHydration(page);
	await context.setOffline(true);
	await page.getByLabel('Atau ketik satu kalimat').fill('kopi 25rb dan parkir goceng');
	await page.getByRole('button', { name: 'Baca kalimat' }).click();
	await page.getByRole('button', { name: 'Simpan 2 transaksi' }).click();
	await expect(page.getByText(QUEUED_HERE)).toBeVisible();
	await expect(page.getByText(/transaksi tersimpan/)).toHaveCount(0);
	await context.setOffline(false);
	await expect(
		page.getByText('2 perubahan tersimpan.').or(page.getByText('1 perubahan tersimpan.'))
	).toBeVisible();
	await page.goto('/riwayat');
	await expect(txRows(page, 'kopi')).toHaveCount(1);
	await expect(txRows(page, 'parkir')).toHaveCount(1);
	await context.close();
});

test('sign-out with a queued change asks first; cancel keeps session and queue; confirm signs out and empties it', async ({
	browser
}, testInfo) => {
	const { context, page, email } = await user(browser, testInfo);
	await queueOneBlocked(context, page, 'Kopi tertahan');
	await page.goto('/pengaturan/akun');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Keluar dari akun' }).click();
	await expect(
		page.getByText(
			'1 perubahan belum tersinkron. Keluar tetap akan membuangnya dari perangkat ini.'
		)
	).toBeVisible();
	await page.getByRole('button', { name: 'Batal' }).click();
	await expect(page).toHaveURL(/\/pengaturan\/akun/);
	await page.reload();
	await expect(page).toHaveURL(/\/pengaturan\/akun/);
	expect(await queueSize(page)).toBe(1);

	await waitForHydration(page);
	await page.getByRole('button', { name: 'Keluar dari akun' }).click();
	await page.getByRole('button', { name: 'Tetap keluar' }).click();
	await expect(page).toHaveURL(/\/masuk/);
	expect(await queueSize(page)).toBe(0);
	await context.unroute(PUSH);
	await signIn(page, email);
	await page.goto('/riwayat');
	await expect(txRows(page, 'Kopi tertahan')).toHaveCount(0);
	await context.close();
});

test('session ended while queued: the queue pauses with the reason; after signing in again it drains', async ({
	browser
}, testInfo) => {
	const { context, page, email } = await user(browser, testInfo);
	await queueOneBlocked(context, page, 'Kopi sesi');
	await context.clearCookies();
	await context.unroute(PUSH);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(
		page.getByRole('button', { name: 'Sesi berakhir. Silakan masuk kembali.' })
	).toBeVisible();
	expect(await queueSize(page)).toBe(1);
	await signIn(page, email);
	await expect(page.getByText('1 perubahan tersimpan.')).toBeVisible();
	await page.goto('/riwayat');
	await expect(txRows(page, 'Kopi sesi')).toHaveCount(1);
	await context.close();
});

test('two tabs come online together: the queued item is sent once', async ({
	browser
}, testInfo) => {
	const { context, page } = await user(browser, testInfo);
	const tabB = await context.newPage();
	await tabB.goto('/riwayat');
	await waitForHydration(tabB);
	await queueOneBlocked(context, page, 'Kopi dua tab');
	let sent = 0;
	context.on('request', (r) => {
		if (r.url().endsWith('/api/v1/sync/push') && r.method() === 'POST') sent++;
	});
	await context.unroute(PUSH);
	await Promise.all([
		page.evaluate(() => window.dispatchEvent(new Event('online'))),
		tabB.evaluate(() => window.dispatchEvent(new Event('online')))
	]);
	// Sending waits for the push round trip and the tabs' lock hand-off, which can take seconds on a CI runner.
	await expect.poll(() => queueSize(page), { timeout: 20_000 }).toBe(0);
	await page.waitForTimeout(500);
	expect(sent).toBe(1);
	await page.goto('/riwayat');
	await expect(txRows(page, 'Kopi dua tab')).toHaveCount(1);
	await context.close();
});

test('account deletion with a queued change needs no extra confirmation', async ({
	browser
}, testInfo) => {
	const { context, page } = await user(browser, testInfo);
	await queueOneBlocked(context, page, 'Kopi hapus');
	await page.goto('/pengaturan/akun');
	await waitForHydration(page);
	await page.locator('#delete-password').fill(PASSWORD);
	await page.getByRole('checkbox', { name: /dihapus permanen/ }).check();
	await page.getByRole('button', { name: 'Hapus akun permanen' }).click();
	await expect(page).toHaveURL(`${BASE}/akun-dihapus`);
	expect(await queueSize(page)).toBe(0);
	await context.close();
});

test('the queue badge at 360 px in dark mode: no horizontal scroll, readable', async ({
	browser
}, testInfo) => {
	const { context, page } = await user(browser, testInfo);
	await page.emulateMedia({ colorScheme: 'dark' });
	await queueOneBlocked(context, page, 'Kopi gelap');
	await page.goto('/');
	await expect(page.getByText(/1 menunggu|Mengirim 1 perubahan/)).toBeVisible();
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('without JavaScript the compose form posts directly, exactly as before', async ({
	browser
}, testInfo) => {
	const { context } = await user(browser, testInfo);
	const noJs = await browser.newContext({
		storageState: await context.storageState(),
		javaScriptEnabled: false
	});
	const page = await noJs.newPage();
	await page.goto('/riwayat/baru');
	await page.getByLabel('Jumlah').fill('12000');
	await page.getByRole('radio', { name: /Kopi/ }).check();
	await page.getByLabel('Judul (opsional)').fill('Kopi tanpa JS');
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();
	await expect(page).toHaveURL(/\/riwayat\?saved=created/);
	await expect(txRows(page, 'Kopi tanpa JS')).toHaveCount(1);
	await noJs.close();
	await context.close();
});
