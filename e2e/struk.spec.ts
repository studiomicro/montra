import { expect, test, type Page, type Route } from '@playwright/test';
import * as devalue from 'devalue';
import {
	collectCspViolations,
	expectNoHorizontalScroll,
	TX_PAGE,
	waitForHydration
} from './helpers';
import { addWallet, BASE, freshUser, ids, today } from './ledger';
import { GPS_MARK, realJpegWithGps } from './photos';
import { readTicketFor, scopeOf } from './receipt-ticket';

/**
 * FN-15 Struk journeys. The e2e server has no AI Gateway ids (so nothing can reach Anthropic): the first journey
 * is the real "Belum dikonfigurasi" state and the real "Lampirkan fotonya saja" save with the photo kept. The
 * second mocks the provider at the browser boundary only — the page data says a key is configured and the `read`
 * answer is a canned, fictional reading — while the save goes to the real server and D1. That mocked read is not
 * a working capture path: the real provider path is verified only by the owner-run `npm run compat:receipts`.
 */

const main = (page: Page) => page.locator('main');
const txRow = (page: Page, title: string) =>
	main(page).locator('a[href$="/edit"]').filter({ hasText: title });

async function pickPhoto(page: Page) {
	const jpeg = await realJpegWithGps(page);
	await page
		.getByLabel('Pilih atau ambil foto struk')
		.setInputFiles({ name: 'IMG_2026.jpg', mimeType: 'image/jpeg', buffer: jpeg });
	await expect(page.getByRole('img', { name: 'Pratinjau foto struk' })).toBeVisible();
}

test('not configured: Struk says why; "Lampirkan fotonya saja" keeps the photo with a manual entry', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn15');
	await addWallet(page, 'Tunai Struk');
	await page.goto('/');
	await waitForHydration(page);
	await expect(main(page).getByRole('button', { name: 'Struk' })).toBeDisabled();
	await expect(
		main(page).getByText('Pembacaan struk dengan AI belum dikonfigurasi.')
	).toBeVisible();

	await page.goto('/riwayat/struk');
	await waitForHydration(page);
	await expect(
		main(page).getByText('Pembacaan struk dengan AI belum dikonfigurasi.')
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Baca struk' })).toHaveCount(0);
	await pickPhoto(page);
	await expectNoHorizontalScroll(page);
	await page.getByRole('link', { name: 'Lampirkan fotonya saja' }).click();
	await page.waitForURL(`${BASE}/riwayat/baru?foto=1`);
	await expect(page.getByText('Foto struk akan disimpan bersama transaksi ini.')).toBeVisible();
	await page.getByLabel('Jumlah').fill('42000');
	await page.getByRole('radio', { name: /Makan & Minum/ }).check();
	await page.getByLabel('Judul (opsional)').fill('Makan malam struk');
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();
	await page.waitForURL(/\/riwayat\?saved=created/);

	await txRow(page, 'Makan malam struk').click();
	await page.waitForURL(TX_PAGE);
	const photo = page.getByRole('img', { name: 'Foto struk' });
	await expect(photo).toBeVisible();
	await expect
		.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
		.toBeGreaterThan(0);
	const href = (await page.getByRole('link', { name: /Lihat foto struk/ }).getAttribute('href'))!;
	const res = await page.request.get(`${BASE}${href}`);
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toBe('image/jpeg');
	expect((await res.body()).includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false);
	await context.close();
});

test('read (mocked provider) → review → "Pisah per item" → saved rows add up to the receipt', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn15');
	await addWallet(page, 'Dompet Struk');
	const violations = collectCspViolations(page);
	const scope = await scopeOf(page);
	type PageData = {
		wallets: { id: string; name: string }[];
		categories: { id: string; tileKey: string; isPreset: boolean }[];
	};
	let pageData: PageData | null = null;

	// The page data as if this server had the gateway and the user a key (both real states elsewhere).
	await page.route(
		(url) => url.pathname === '/riwayat/struk/__data.json',
		async (route: Route) => {
			const response = await route.fetch();
			const json = (await response.json()) as {
				nodes: ({ type: string; data: unknown[] } | null)[];
			};
			for (const node of json.nodes) {
				const root = node?.type === 'data' ? (node.data[0] as Record<string, number>) : null;
				if (!node || !root || !('configured' in root)) continue;
				pageData = devalue.unflatten(node.data) as PageData;
				node.data.push(true);
				root.configured = node.data.length - 1;
				root.hasKey = node.data.length - 1;
			}
			await route.fulfill({ response, json });
		}
	);
	// The provider's reading, canned and fictional; the real server never sees this request.
	await page.route(
		(url) => url.pathname === '/riwayat/struk' && url.search === '?/read',
		async (route: Route) => {
			const data = pageData!;
			// The ticket the real read would issue for the photo the page sent (red team L3).
			const request = route.request();
			const posted = await new Response(new Uint8Array(request.postDataBuffer()!), {
				headers: { 'content-type': request.headers()['content-type']! }
			}).formData();
			const sent = new Uint8Array(await (posted.get('photo') as File).arrayBuffer());
			const readTicket = await readTicketFor(scope, sent);
			const makan = data.categories.find((c) => c.isPreset && c.tileKey === 'makan')!.id;
			const kopi = data.categories.find((c) => c.isPreset && c.tileKey === 'kopi')!.id;
			const review = {
				values: {
					mode: 'single',
					shop: 'Warung Contoh Sejahtera',
					occurredOn: today(),
					walletId: data.wallets[0]!.id,
					categoryId: makan,
					paymentMethod: 'QRIS',
					items: [
						{ name: 'Nasi goreng fiktif', amount: '25.000', categoryId: '' },
						{ name: 'Es teh fiktif', amount: '8.000', categoryId: '' },
						{ name: 'Kopi susu fiktif', amount: '18.000', categoryId: kopi }
					],
					tax: '5.100',
					service: '',
					discount: '',
					total: '56.100',
					keepPhoto: true,
					acceptMismatch: false,
					readTicket
				},
				dateCheck: 'ok',
				duplicates: [],
				alreadySaved: false,
				foreignCurrency: null
			};
			await new Promise((resolve) => setTimeout(resolve, 600));
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					type: 'success',
					status: 200,
					data: devalue.stringify({ action: 'read', review })
				})
			});
		}
	);

	// A client-side navigation, so the page data comes from __data.json.
	await page.goto('/riwayat');
	await waitForHydration(page);
	await page.evaluate(() => {
		const a = document.createElement('a');
		a.href = '/riwayat/struk';
		a.id = 'e2e-struk';
		a.textContent = 'struk';
		document.body.appendChild(a);
	});
	await page.click('#e2e-struk');
	await page.waitForURL(`${BASE}/riwayat/struk`);
	await pickPhoto(page);
	await page.getByRole('button', { name: 'Baca struk' }).click();
	// "Mengunggah…" until the browser reports the upload done, then "Membaca strukmu…" (an intercepted request
	// may skip the upload-done event, so either caption counts here).
	await expect(
		page.getByRole('status').filter({ hasText: /Mengunggah…|Membaca strukmu…/ })
	).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Periksa hasil bacaan' })).toBeVisible();
	await expect(page.getByText('Periksa totalnya')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Simpan 1 transaksi' })).toBeVisible();

	// An edit that breaks the sum shows the banner live; putting it back clears it.
	const total = page.getByLabel('Total', { exact: true });
	await total.fill('56.000');
	await expect(page.getByText('Periksa totalnya')).toBeVisible();
	await total.fill('56100');
	await expect(page.getByText('Periksa totalnya')).toHaveCount(0);

	await page.getByRole('radio', { name: 'Pisah per item' }).check();
	await expect(page.getByRole('button', { name: 'Simpan 4 transaksi' })).toBeVisible();
	await expectNoHorizontalScroll(page);
	await page.getByRole('button', { name: 'Simpan 4 transaksi' }).click();
	await expect(page.getByRole('heading', { name: 'Struk tersimpan' })).toBeFocused();
	await expect(page.getByText('4 transaksi tersimpan.')).toBeVisible();

	await page.goto('/riwayat');
	for (const title of ['Nasi goreng fiktif', 'Es teh fiktif', 'Kopi susu fiktif', 'Pajak & servis'])
		await expect(txRow(page, title)).toBeVisible();
	await expect(txRow(page, 'Pajak & servis')).toContainText('5.100');
	await expect(main(page).getByText(/4 transaksi · Rp\s56\.100 keluar/)).toBeVisible();
	expect(violations).toEqual([]);
	await context.close();
});

test('without JavaScript the save action answers as a page: refusal, then success', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn15');
	await addWallet(page, 'Tunai Tanpa JS');
	const { wallet, category } = await ids(page);
	const photo = await realJpegWithGps(page);
	const readTicket = await readTicketFor(await scopeOf(page), photo);
	const post = (o: Record<string, string>) =>
		page.request.post(`${BASE}/riwayat/struk?/save`, {
			headers: { origin: BASE, accept: 'text/html' },
			multipart: {
				mode: 'single',
				shop: 'Kios Tanpa Skrip',
				occurredOn: today(),
				walletId: o.walletId ?? '',
				categoryId: o.categoryId ?? '',
				paymentMethod: 'TUNAI',
				count: '1',
				'itemName.0': 'Roti fiktif',
				'itemAmount.0': '15.000',
				'itemCategory.0': '',
				tax: '',
				service: '',
				discount: '',
				total: o.total ?? '15.000',
				...(o.accept ? { acceptMismatch: 'on' } : {}),
				readTicket,
				photo: { name: 'struk.jpg', mimeType: 'image/jpeg', buffer: photo }
			}
		});
	const walletId = await wallet('Tunai Tanpa JS');
	const categoryId = await category('Makan & Minum');
	const refused = await post({ walletId, categoryId, total: '16.000' });
	expect(refused.status()).toBe(400);
	const refusedHtml = await refused.text();
	expect(refusedHtml).toContain('Periksa totalnya');
	expect(refusedHtml).toContain('Kios Tanpa Skrip');
	const saved = await post({ walletId, categoryId, total: '16.000', accept: 'on' });
	expect(saved.status()).toBe(200);
	expect(await saved.text()).toContain('Struk tersimpan');
	await page.goto('/riwayat');
	await expect(txRow(page, 'Kios Tanpa Skrip')).toBeVisible();
	await context.close();
});
