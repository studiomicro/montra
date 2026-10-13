import { expect, test, type Page } from '@playwright/test';
import {
	collectCspViolations,
	expectNoHorizontalScroll,
	isPhone,
	simulatedClientIp,
	waitForHydration
} from './helpers';
import { addWallet, BASE, freshUser, ids, postExpense, rp } from './ledger';

/**
 * FN-14 journeys. Playwright has no real microphone: the typed path is tested in full, and the voice path with
 * a fake `SpeechRecognition` injected before the page loads that "hears" a scripted sentence. Every test signs
 * up its own fictional user; setup data goes through the app's own form actions, never into D1.
 */
const main = (page: Page) => page.locator('main');
const txRow = (page: Page, title: string) =>
	main(page).getByRole('link').filter({ hasText: title });
const SENTENCE = 'kopi 25rb dan parkir goceng';

/** No speech recogniser at all (feature detection must fall back to the typed sentence). */
async function withoutSpeech(page: Page) {
	await page.addInitScript(() => {
		for (const name of ['SpeechRecognition', 'webkitSpeechRecognition'])
			Object.defineProperty(window, name, { value: undefined, configurable: true });
	});
}

/**
 * A fake recogniser: `start()` records its language, then emits an interim result, the final transcript
 * (`window.__heard`, default SENTENCE) and the end event; with `deny` it fails like a refused microphone.
 */
async function withFakeSpeech(page: Page, opts: { deny?: boolean; heard?: string } = {}) {
	await page.addInitScript(
		({ deny, heard }) => {
			const w = window as unknown as Record<string, unknown>;
			w.__langs = [];
			w.__heard = heard;
			class FakeRecognition {
				lang = '';
				interimResults = false;
				continuous = true;
				maxAlternatives = 1;
				onresult: ((e: unknown) => void) | null = null;
				onerror: ((e: unknown) => void) | null = null;
				onend: (() => void) | null = null;
				private timers: number[] = [];
				start() {
					(w.__langs as string[]).push(this.lang);
					const text = String(w.__heard);
					const results = (final: boolean, t: string) => {
						const list = [{ isFinal: final, 0: { transcript: t } }];
						return Object.assign(list, { length: 1 });
					};
					const later = (ms: number, fn: () => void) => this.timers.push(window.setTimeout(fn, ms));
					if (deny) {
						later(50, () => {
							this.onerror?.({ error: 'not-allowed' });
							this.onend?.();
						});
						return;
					}
					later(50, () => this.onresult?.({ results: results(false, text.split(' dan ')[0]!) }));
					later(400, () => this.onresult?.({ results: results(true, text) }));
					later(450, () => this.onend?.());
				}
				stop() {
					this.onend?.();
				}
				abort() {
					this.timers.forEach((t) => clearTimeout(t));
					this.onerror?.({ error: 'aborted' });
					this.onend?.();
				}
			}
			w.webkitSpeechRecognition = FakeRecognition;
			w.SpeechRecognition = undefined;
		},
		{ deny: opts.deny ?? false, heard: opts.heard ?? SENTENCE }
	);
}

async function expectJourneyRows(page: Page) {
	const rows = main(page).locator('fieldset.row');
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0).getByLabel('Judul')).toHaveValue('Kopi');
	await expect(rows.nth(0).getByLabel('Jumlah')).toHaveValue('25.000');
	await expect(rows.nth(0).getByLabel('Kategori').locator('option:checked')).toHaveText('Kopi');
	await expect(rows.nth(1).getByLabel('Judul')).toHaveValue('Parkir');
	await expect(rows.nth(1).getByLabel('Jumlah')).toHaveValue('5.000');
	await expect(rows.nth(1).getByLabel('Kategori').locator('option:checked')).toHaveText(
		'Transportasi'
	);
	for (const i of [0, 1]) {
		await expect(rows.nth(i).getByRole('radio', { name: 'Pengeluaran' })).toBeChecked();
		await expect(rows.nth(i).getByRole('button', { name: /Periksa dengan AI/ })).toBeDisabled();
		await expect(rows.nth(i).getByText('Belum dikonfigurasi')).toBeVisible();
		await expect(rows.nth(i).getByLabel('Dompet').locator('option:checked')).toHaveText(
			'BCA · IDR'
		);
	}
}

async function expectSavedInRiwayat(page: Page) {
	await page.goto('/riwayat');
	await page.reload();
	await expect(txRow(page, 'Kopi')).toContainText(`−${rp('25.000')}`);
	await expect(txRow(page, 'Parkir')).toContainText(`−${rp('5.000')}`);
	await expect(main(page).getByText(`2 transaksi · ${rp('30.000')} keluar`)).toBeVisible();
}

test('typed sentence (no speech recogniser): wallet → "kopi 25rb dan parkir goceng" → 2 rows → save → reload', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn14');
	const csp = collectCspViolations(page);
	await withoutSpeech(page);
	await addWallet(page, 'BCA');
	await page.goto('/');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Tambah' }).filter({ visible: true }).click();
	await page
		.getByRole('dialog', { name: 'Tambah transaksi' })
		.getByRole('link', { name: /Suara/ })
		.click();
	await page.waitForURL(`${BASE}/riwayat/suara`);
	await waitForHydration(page);
	await expect(page.getByText('Pengenalan suara tidak tersedia di browser ini')).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Mulai merekam' })).toHaveCount(0);

	await page.getByLabel('Atau ketik satu kalimat').fill(SENTENCE);
	await page.getByRole('button', { name: 'Baca kalimat' }).click();
	await expectJourneyRows(page);
	await expect(main(page).locator('mark')).toHaveText(['25rb', 'goceng']);
	await expectNoHorizontalScroll(page);
	await page.getByRole('button', { name: 'Simpan 2 transaksi' }).click();
	await expect(page.getByText('2 transaksi tersimpan.')).toBeVisible();
	await expect(main(page).locator('fieldset.row')).toHaveCount(0);
	await expectSavedInRiwayat(page);
	expect(csp).toEqual([]);
	await context.close();
});

test('voice (fake recogniser): Beranda Suara pill records at once in id-ID, amounts marked, EN toggle, save', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn14');
	await withFakeSpeech(page);
	await addWallet(page, 'BCA');
	await page.goto('/');
	await waitForHydration(page);
	await expect(main(page).getByRole('button', { name: 'Struk' })).toBeDisabled();
	await main(page).getByRole('link', { name: 'Suara' }).click();
	await page.waitForURL(`${BASE}/riwayat/suara`);
	await expectJourneyRows(page);
	expect(await page.evaluate(() => (window as unknown as { __langs: string[] }).__langs)).toEqual([
		'id-ID'
	]);
	await expect(main(page).locator('mark')).toHaveText(['25rb', 'goceng']);
	await expect(page.getByRole('button', { name: 'Mulai merekam' })).toHaveAttribute(
		'aria-pressed',
		'false'
	);

	// Remove one row, speak again in English: the new rows are added to the list.
	await main(page)
		.locator('fieldset.row')
		.nth(1)
		.getByRole('button', { name: 'Hapus baris' })
		.click();
	await expect(main(page).locator('fieldset.row')).toHaveCount(1);
	await page.evaluate(() => {
		(window as unknown as { __heard: string }).__heard = 'bensin 50rb';
	});
	await page.getByRole('radio', { name: 'EN', exact: true }).check();
	await page.getByRole('button', { name: 'Mulai merekam' }).click();
	await expect(main(page).locator('fieldset.row')).toHaveCount(2);
	expect(await page.evaluate(() => (window as unknown as { __langs: string[] }).__langs)).toEqual([
		'id-ID',
		'en-US'
	]);
	await expect(main(page).locator('fieldset.row').nth(1).getByLabel('Judul')).toHaveValue('Bensin');

	// Every field is editable before saving; the edit is what is stored.
	const first = main(page).locator('fieldset.row').nth(0);
	await first.getByLabel('Judul').fill('kopi susu');
	await first.getByLabel('Jumlah').fill('27000');
	await page.getByRole('button', { name: 'Simpan 2 transaksi' }).click();
	await expect(page.getByText('2 transaksi tersimpan.')).toBeVisible();
	await page.goto('/riwayat');
	await page.reload();
	await expect(txRow(page, 'kopi susu')).toContainText(`−${rp('27.000')}`);
	await expect(txRow(page, 'Bensin')).toContainText(`−${rp('50.000')}`);
	await context.close();
});

test('a full page load of ?mulai=1 (e.g. a link from another site) never starts the microphone (L2)', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn14');
	await withFakeSpeech(page);
	await addWallet(page, 'BCA');
	await page.goto('/riwayat/suara?mulai=1', { referer: 'https://elsewhere.example/' });
	await waitForHydration(page);
	await page.waitForURL(`${BASE}/riwayat/suara`);
	const mic = page.getByRole('button', { name: 'Mulai merekam' });
	await expect(mic).toHaveAttribute('aria-pressed', 'false');
	await page.waitForTimeout(600);
	expect(await page.evaluate(() => (window as unknown as { __langs: string[] }).__langs)).toEqual(
		[]
	);
	await expect(main(page).locator('fieldset.row')).toHaveCount(0);
	// The disclosure (L3) is on the screen; a tap is what starts it.
	await expect(
		page.getByText('sebagian browser mengirim rekamannya ke server pembuat browser')
	).toBeVisible();
	await mic.click();
	await expect(main(page).locator('fieldset.row')).toHaveCount(2);
	await context.close();
});

test('a refused microphone shows the permission message and keeps the typed field', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn14');
	await withFakeSpeech(page, { deny: true });
	await addWallet(page, 'BCA');
	await page.goto('/riwayat/suara');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Mulai merekam' }).click();
	await expect(
		page.getByText('Izin mikrofon ditolak. Aktifkan di pengaturan browser.')
	).toBeVisible();
	await expect(page.getByLabel('Atau ketik satu kalimat')).toBeVisible();
	await expect(main(page).locator('fieldset.row')).toHaveCount(0);
	await context.close();
});

test('zero amounts and hostile text: never a guessed amount, never rendered as markup', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn14');
	const csp = collectCspViolations(page);
	let dialogs = 0;
	page.on('dialog', async (d) => {
		dialogs++;
		await d.dismiss();
	});
	await withoutSpeech(page);
	await addWallet(page, 'BCA');
	await page.goto('/riwayat/suara');
	await waitForHydration(page);
	await page.getByLabel('Atau ketik satu kalimat').fill('beli kopi');
	await page.getByRole('button', { name: 'Baca kalimat' }).click();
	await expect(page.getByText('Tidak bisa membaca jumlahnya. Ketik manual.')).toBeVisible();
	const rows = main(page).locator('fieldset.row');
	await expect(rows).toHaveCount(1);
	await expect(rows.getByLabel('Jumlah')).toHaveValue('');
	await page.getByRole('button', { name: 'Simpan 1 transaksi' }).click();
	await expect(
		page.getByText('Belum ada yang disimpan. Periksa baris yang ditandai.')
	).toBeVisible();
	await rows.getByRole('button', { name: 'Hapus baris' }).click();

	const hostile = '<img src=x onerror=alert(1)>\u200b 25rb \u202e<script>alert(2)</script> goceng';
	await page.getByLabel('Atau ketik satu kalimat').fill(hostile);
	await page.getByRole('button', { name: 'Baca kalimat' }).click();
	await expect(rows).toHaveCount(2);
	// FN-20: the merchant suggestion replaces an unedited title with the cleaned name, as plain text.
	await expect(rows.nth(0).getByLabel('Judul')).toHaveValue('Img Src X Onerror Alert');
	await expect(rows.nth(1).getByLabel('Judul')).toHaveValue('Script Alert Script');
	await expect(main(page).locator('img')).toHaveCount(0);
	await expect(main(page).locator('script')).toHaveCount(0);
	const shown = await main(page)
		.locator('.transcript')
		.evaluate((el) => el.textContent ?? '');
	expect(shown).toContain('25rb');
	expect(/[\u200b\u202e]/.test(shown)).toBe(false);
	for (const i of [0, 1])
		await rows.nth(i).getByLabel('Kategori').selectOption({ label: 'Belanja' });
	await page.getByRole('button', { name: 'Simpan 2 transaksi' }).click();
	await expect(page.getByText('2 transaksi tersimpan.')).toBeVisible();
	await page.goto('/riwayat');
	await expect(txRow(page, 'Img Src X Onerror Alert')).toBeVisible();
	await expect(main(page).locator('img')).toHaveCount(0);
	expect(dialogs).toBe(0);
	expect(csp).toEqual([]);
	await context.close();
});

test('Catat lagi: one tap records today, Urungkan deletes exactly that row', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn14');
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	const walletId = await wallet('BCA');
	const kopi = await category('Kopi');
	await postExpense(page, { walletId, categoryId: kopi, amount: '25.000', title: 'Kopi susu' });
	await postExpense(page, { walletId, categoryId: kopi, amount: '25.000', title: 'Kopi susu' });
	await page.goto('/riwayat/suara');
	await waitForHydration(page);
	const again = main(page).getByRole('region', { name: 'Catat lagi' });
	const chip = again.getByRole('button', { name: `Kopi susu · ${rp('25.000')}` });
	await expect(chip).toBeVisible();
	if (isPhone(page)) {
		const box = (await chip.boundingBox())!;
		expect(box.height).toBeGreaterThanOrEqual(44);
	}
	await chip.click();
	const toast = page.getByRole('status').filter({ hasText: 'Dicatat' });
	await expect(toast).toBeVisible();
	await page.goto('/riwayat');
	await expect(main(page).getByText(`3 transaksi · ${rp('75.000')} keluar`)).toBeVisible();

	await page.goto('/riwayat/suara');
	await waitForHydration(page);
	await chip.click();
	await toast.getByRole('button', { name: 'Urungkan' }).click();
	await expect(page.getByText('Dibatalkan. Transaksinya sudah dihapus.')).toBeVisible();
	await page.goto('/riwayat');
	await expect(main(page).getByText(`3 transaksi · ${rp('75.000')} keluar`)).toBeVisible();
	await context.close();
});

test('without JavaScript the typed sentence works as a plain form: refusal, then success', async ({
	browser
}, testInfo) => {
	const signedUp = await freshUser(browser, testInfo, 'fn14');
	await addWallet(signedUp.page, 'BCA');
	const storageState = await signedUp.context.storageState();
	await signedUp.context.close();
	const context = await browser.newContext({
		storageState,
		javaScriptEnabled: false,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
	});
	const page = await context.newPage();
	await page.goto('/riwayat/suara');
	await expect(page.getByRole('button', { name: 'Mulai merekam' })).toHaveCount(0);
	await page.getByLabel('Atau ketik satu kalimat').fill(SENTENCE);
	await page.getByRole('button', { name: 'Baca kalimat' }).click();
	await expectJourneyRows(page);
	await expect(page.getByLabel('Atau ketik satu kalimat')).toHaveValue(SENTENCE);

	// A refusal keeps every row and its edits, and names the row's problem.
	const rows = main(page).locator('fieldset.row');
	await rows.nth(1).getByLabel('Kategori').selectOption({ label: 'Tanpa kategori' });
	await rows.nth(0).getByLabel('Judul').fill('kopi pagi');
	await page.getByRole('button', { name: 'Simpan 2 transaksi' }).click();
	await expect(
		page.getByText('Belum ada yang disimpan. Periksa baris yang ditandai.')
	).toBeVisible();
	await expect(rows.nth(1).getByText('Pilih kategori.')).toBeVisible();
	await expect(rows.nth(0).getByLabel('Judul')).toHaveValue('kopi pagi');

	await rows.nth(1).getByLabel('Kategori').selectOption({ label: 'Transportasi' });
	await page.getByRole('button', { name: 'Simpan 2 transaksi' }).click();
	await expect(page.getByText('2 transaksi tersimpan.')).toBeVisible();
	await page.goto('/riwayat');
	await expect(txRow(page, 'kopi pagi')).toContainText(`−${rp('25.000')}`);
	await expect(txRow(page, 'Parkir')).toContainText(`−${rp('5.000')}`);
	await context.close();
});
