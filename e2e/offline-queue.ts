import { expect, type BrowserContext, type Page } from '@playwright/test';
import { waitForHydration } from './helpers';

// FN-02 offline-queue helpers shared by e2e/offline-queue.spec.ts and the FN-42 update journey (e2e/pwa.spec.ts).

export const PUSH = '**/api/v1/sync/push';
export const QUEUED_HERE = 'Menunggu koneksi. Dikirim otomatis saat perangkat online.';

export async function composeOffline(page: Page, amount: string, title: string) {
	await page.getByLabel('Jumlah').fill(amount);
	await page.getByRole('radio', { name: /Kopi/ }).check();
	await page.getByLabel('Judul (opsional)').fill(title);
	await page.getByRole('button', { name: 'Simpan transaksi' }).click();
}

/** Items in this browser's queue database (any account). */
export const queueSize = (page: Page) =>
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

/** Queues one expense whose sends keep failing (the push endpoint aborted) until `context.unroute(PUSH)`. */
export async function queueOneBlocked(context: BrowserContext, page: Page, title: string) {
	await context.route(PUSH, (r) => r.abort());
	await page.goto('/riwayat/baru');
	await waitForHydration(page);
	await context.setOffline(true);
	await composeOffline(page, '25000', title);
	await expect(page.getByText(QUEUED_HERE)).toBeVisible();
	await context.setOffline(false);
}
