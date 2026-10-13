import { expect, test, type Page } from '@playwright/test';
import { waitForHydration } from './helpers';
import { addWallet, freshUser } from './ledger';

/**
 * QA probe for FN-02, criterion 1 ("the item persists in IndexedDB across a reload") and the engineer's own
 * "not verified" note: a real page reload while offline. Confirms the two separate layers behave as designed:
 * the service worker's offline shell (FN-13, unmodified here) answers the navigation, while the queued item in
 * IndexedDB (a storage API, not a network request) survives untouched and still drains once online again.
 */

async function serviceWorkerReady(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise((r) =>
				navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
			);
		void reg;
	});
}

const queueSize = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<number>((resolve) => {
				const open = indexedDB.open('financer-queue', 1);
				open.onupgradeneeded = () =>
					open.result
						.createObjectStore('items', { keyPath: 'clientId' })
						.createIndex('byAccount', 'accountId');
				open.onsuccess = () => {
					const req = open.result.transaction('items').objectStore('items').count();
					req.onsuccess = () => {
						resolve(req.result);
						open.result.close();
					};
				};
			})
	);

test('reload while offline: the service worker offline shell answers the navigation, the queued item survives in IndexedDB and still drains once back online', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'fn02reload');
	await serviceWorkerReady(page);
	await addWallet(page, 'BCA');

	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await context.setOffline(true);
	await page.getByLabel('Jumlah').fill('15000');
	await page.getByRole('radio', { name: /Kopi/ }).check();
	await page.getByLabel('Judul (opsional)').fill('Reload offline probe');
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();
	await expect(
		page.getByText('Menunggu koneksi. Dikirim otomatis saat perangkat online.')
	).toBeVisible();
	expect(await queueSize(page)).toBe(1);

	// A real reload while still offline: the service worker's offline shell answers, never a browser error page
	// crashing the tab, and the queued item (IndexedDB, not a network resource) is untouched by it.
	await page.reload().catch(() => {});
	await expect(page.getByRole('heading', { name: 'Kamu sedang offline.' })).toBeVisible();
	expect(await queueSize(page)).toBe(1);

	// Back online: a normal navigation to the app re-loads the real page, and the queue still has its item,
	// which the drain loop then sends.
	await context.setOffline(false);
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await expect(page.getByText('1 perubahan tersimpan.')).toBeVisible({ timeout: 10_000 });
	expect(await queueSize(page)).toBe(0);
	await page.goto('/riwayat');
	await expect(
		page.locator('main').getByRole('link').filter({ hasText: 'Reload offline probe' })
	).toHaveCount(1);
	await context.close();
});
