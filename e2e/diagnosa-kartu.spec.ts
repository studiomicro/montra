import { expect, test } from '@playwright/test';
import { waitForHydration } from './helpers';

/**
 * FN-58 "Diagnosa kartu". In a browser there is no NFC bridge, so the page says so. With a fake bridge standing in
 * for the Android app (fictional FeliCa frames, not a real card), a KMT tap shows the balance and a masked log, and
 * a write command never reaches the bridge.
 */

test('in a browser the page says reading needs the Android app', async ({ page }) => {
	await page.goto('/dompet/diagnosa-kartu');
	await waitForHydration(page);
	await expect(
		page.getByText('Membaca kartu lewat NFC hanya bisa di aplikasi Montra untuk Android.')
	).toBeVisible();
});

test('a KMT tap through the bridge shows the balance and a masked log', async ({ page }) => {
	await page.addInitScript(() => {
		const IDM = '0123456789ABCDEF';
		const block = '14CD00' + '00'.repeat(13); // 52.500 = 0x00CD14, little-endian
		const read = '07' + IDM + '0000' + '01' + block;
		const answers: Record<string, string> = {
			'060090B70000': '1201' + IDM + '00'.repeat(8),
			['1006' + IDM + '01171001' + '8000']: (read.length / 2 + 1).toString(16).toUpperCase() + read
		};
		const sent: string[] = [];
		let onCard: ((info: unknown) => void) | undefined;
		(window as unknown as { __sent: string[] }).__sent = sent;
		(window as unknown as { Capacitor: unknown }).Capacitor = {
			isPluginAvailable: (name: string) => name === 'MontraNfc',
			Plugins: {
				MontraNfc: {
					isAvailable: async () => ({ available: true, enabled: true }),
					startReading: async () => {
						setTimeout(() => onCard?.({ techs: ['NfcF'], uidLength: 8, systemCode: '90B7' }), 50);
					},
					stopReading: async () => {},
					addListener: async (_event: string, cb: (info: unknown) => void) => {
						onCard = cb;
						return { remove: async () => {} };
					},
					transceive: async ({ hex }: { hex: string }) => {
						sent.push(hex);
						if (!(hex in answers)) throw new Error('no answer');
						return { hex: answers[hex] };
					}
				}
			}
		};
	});
	await page.goto('/dompet/diagnosa-kartu');
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Mulai membaca' }).click();
	await expect(page.getByText('Saldo KMT')).toBeVisible();
	await expect(page.locator('.balance strong')).toHaveText(/52\.500/);
	const log = await page.locator('pre.log').textContent();
	expect(log).not.toContain('0123456789ABCDEF');
	expect(log).toContain('CDEF');
	// Only read frames reached the bridge.
	const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
	for (const hex of sent) expect(['00', '06']).toContain(hex.slice(2, 4));
});

test('Dompet links to the card reader only inside the Android app', async ({ page }) => {
	await page.goto('/dompet');
	await waitForHydration(page);
	await expect(page.getByRole('link', { name: /Baca kartu e-money/ })).toHaveCount(0);
	await page.addInitScript(() => {
		(window as unknown as { Capacitor: unknown }).Capacitor = {
			isPluginAvailable: (name: string) => name === 'MontraNfc',
			Plugins: { MontraNfc: {} }
		};
	});
	await page.goto('/dompet');
	await waitForHydration(page);
	await page.getByRole('link', { name: /Baca kartu e-money/ }).click();
	await expect(page).toHaveURL(/\/dompet\/diagnosa-kartu$/);
});
