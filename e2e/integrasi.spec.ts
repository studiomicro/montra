import { expect, test, type Browser, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	newDevice,
	SIGNED_OUT,
	signUp,
	uniqueEmail,
	waitForHydration
} from './helpers';
import {} from './ledger';

/**
 * FN-41 Integrasi AI: add, replace and remove a personal Anthropic key, with and without JavaScript, at 360 px and
 * on desktop. Each test signs up its own account (one key row per user, and the phone and desktop projects run in
 * parallel). The e2e server has a local sealing key but no AI Gateway ids, so "Tes koneksi" is "Belum
 * dikonfigurasi" and nothing here can reach Anthropic. The keys are synthetic.
 */
test.use({ storageState: SIGNED_OUT });

const key = (tag: string) => `sk-ant-api03-e2e-synthetic-${tag}-${Date.now()}`;

async function signedUp(browser: Browser, javaScriptEnabled = true): Promise<Page> {
	const { page } = await newDevice(browser, {
		javaScriptEnabled,
		viewport: test.info().project.name === 'phone' ? { width: 360, height: 780 } : undefined,
		reducedMotion: 'reduce'
	});
	await signUp(page, { email: uniqueEmail('fn41'), js: javaScriptEnabled });
	return page;
}

test('add, replace and remove a key; only the last four are ever shown', async ({
	browser
}, testInfo) => {
	const page = await signedUp(browser);
	const csp = collectCspViolations(page);
	await page.goto('/pengaturan');
	await waitForHydration(page);
	await page
		.locator('main')
		.getByRole('link', { name: /Integrasi AI/ })
		.click();
	await page.waitForURL(/\/pengaturan\/integrasi$/);
	await expect(page.getByRole('heading', { name: 'Integrasi AI', level: 1 })).toBeVisible();
	await expect(page.getByText(/Belum ada kunci API/)).toBeVisible();
	await expectNoHorizontalScroll(page);

	const input = page.getByLabel('Kunci API Anthropic');
	await expect(input).toHaveAttribute('type', 'password');
	// A wrong paste is refused with its own message.
	await input.fill('sk-proj-not-an-anthropic-key-at-all');
	await page.getByRole('button', { name: 'Simpan kunci' }).click();
	await expect(page.getByRole('alert')).toContainText('Itu bukan kunci Anthropic');

	const first = key('first');
	await input.fill(first);
	await page.getByRole('button', { name: 'Simpan kunci' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Kunci disimpan.' })).toBeVisible();
	const row = page.getByRole('listitem').filter({ hasText: 'Anthropic' });
	await expect(row).toContainText(`•••• ${first.slice(-4)}`);
	await expect(row).toContainText('Belum pernah dicoba');
	// No gateway on the e2e server: the test control says why it is unavailable.
	const unavailable = page.getByRole('button', { name: 'Belum dikonfigurasi' });
	await expect(unavailable).toBeDisabled();
	await expect(page.getByText(/Tes koneksi belum dikonfigurasi di server ini/)).toBeVisible();
	await expectNoHorizontalScroll(page);
	await page.screenshot({
		path: testInfo.outputPath('integrasi-stored-light.png'),
		fullPage: true
	});

	// A full reload reads the stored state back; the key itself is nowhere in the page.
	await page.reload();
	await waitForHydration(page);
	expect(await page.content()).not.toContain(first);
	await expect(row).toContainText(`•••• ${first.slice(-4)}`);

	const second = key('second');
	await input.fill(second);
	await page.getByRole('button', { name: 'Ganti kunci' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Kunci diganti.' })).toBeVisible();
	await expect(row).toContainText(`•••• ${second.slice(-4)}`);

	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoHorizontalScroll(page);
	await page.screenshot({ path: testInfo.outputPath('integrasi-stored-dark.png'), fullPage: true });
	await page.emulateMedia({ colorScheme: 'light' });

	// "Batal" closes the confirm step and returns focus to "Hapus kunci".
	const summary = page.getByText('Hapus kunci', { exact: true });
	await summary.click();
	await page.getByRole('button', { name: 'Batal' }).click();
	await expect(summary).toBeFocused();
	await summary.click();
	await page.getByRole('button', { name: 'Ya, hapus kunci' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Kunci dihapus.' })).toBeVisible();
	await expect(page.getByText(/Belum ada kunci API/)).toBeVisible();
	await expect(input).toBeFocused();
	await page.reload();
	await expect(page.getByText(/Belum ada kunci API/)).toBeVisible();
	expect(csp).toEqual([]);
	await page.context().close();
});

test('works without JavaScript: save and remove re-render from the server', async ({ browser }) => {
	const page = await signedUp(browser, false);
	await page.goto('/pengaturan/integrasi');
	const secret = key('nojs');
	await page.getByLabel('Kunci API Anthropic').fill(secret);
	await page.getByRole('button', { name: 'Simpan kunci' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Kunci disimpan.' })).toBeVisible();
	await expect(page.getByRole('listitem').filter({ hasText: 'Anthropic' })).toContainText(
		`•••• ${secret.slice(-4)}`
	);
	expect(await page.content()).not.toContain(secret);
	await page.getByText('Hapus kunci', { exact: true }).click();
	await page.getByRole('button', { name: 'Ya, hapus kunci' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Kunci dihapus.' })).toBeVisible();
	await expect(page.getByText(/Belum ada kunci API/)).toBeVisible();
	await page.context().close();
});

test('the admin status page is a plain 404 for a non-admin and when signed out', async ({
	browser,
	request
}) => {
	const page = await signedUp(browser);
	const asUser = await page.request.get('/pengaturan/integrasi/admin');
	expect(asUser.status()).toBe(404);
	const signedOut = await request.get(`${APP_ORIGIN}/pengaturan/integrasi/admin`, {
		maxRedirects: 0
	});
	expect(signedOut.status()).toBe(404);
	await page.goto('/pengaturan/integrasi/admin');
	await expect(page.getByText('Halaman tidak ditemukan.')).toBeVisible();
	await page.context().close();
});

// QA cycle 1, FN-30 hardening criterion 25: the admin 404 is the same answer as an unknown path (status and body),
// signed in and signed out, so the route's existence is not an oracle. Only per-request nonces are normalised; the
// unknown path has the same depth, because the page's asset URLs are relative (`../../_app/...`).
test('the admin 404 body equals an unknown path’s 404 body', async ({ browser, request }) => {
	const normalise = (html: string) => html.replace(/nonce="[^"]*"/g, 'nonce=""');
	const page = await signedUp(browser);
	for (const get of [
		(path: string) => page.request.get(path),
		(path: string) => request.get(`${APP_ORIGIN}${path}`, { maxRedirects: 0 })
	]) {
		const adminRes = await get('/pengaturan/integrasi/admin');
		const unknownRes = await get('/tidak-ada/sama/sekali');
		expect(adminRes.status()).toBe(404);
		expect(unknownRes.status()).toBe(404);
		expect(normalise(await adminRes.text())).toBe(normalise(await unknownRes.text()));
	}
	await page.context().close();
});
