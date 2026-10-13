import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
	tickSignUpBoxes,
	APP_ORIGIN,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration
} from './helpers';

/**
 * FN-21 account key journeys. Each test signs up its own account (unique e-mail) and every browser context is
 * its own simulated client, so the per-client sign-in/sign-up throttle never mixes tests. A "second device"
 * is a fresh browser context: no cookies, no memory of the first.
 */
test.use({ storageState: SIGNED_OUT });

const PASSWORD = 'terang-benderang-8';
const NEW_PASSWORD = 'pagi-cerah-2026';
const KEY_STALE =
	'Kunci akun tidak bisa dibuka dengan kata sandi barumu. Kunci ulang di bawah ini.';
const NOT_OPEN = 'Kunci akun belum dibuka di sesi ini. Buka dengan kata sandi di halaman Akun.';

function freshEmail(tag: string): string {
	return `fn21-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

let contexts = 0;
async function newDevice(
	browser: Browser,
	opts: {
		javaScriptEnabled?: boolean;
		storageState?: Awaited<ReturnType<BrowserContext['storageState']>>;
	} = {}
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		baseURL: APP_ORIGIN,
		locale: 'id-ID',
		javaScriptEnabled: opts.javaScriptEnabled ?? true,
		storageState: opts.storageState ?? SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(test.info(), ++contexts) }
	});
	return { context, page: await context.newPage() };
}

async function signUp(page: Page, email: string, next?: string, js = true) {
	await page.goto(next ? `/daftar?next=${encodeURIComponent(next)}` : '/daftar');
	if (js) await waitForHydration(page);
	await page.getByLabel('Nama').fill('Budi Santoso');
	await page.getByLabel('E-mail').fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL((url) => url.pathname !== '/daftar', { timeout: 30_000 });
}

async function signIn(page: Page, email: string, password: string, next: string) {
	await page.goto(`/masuk?next=${encodeURIComponent(next)}`);
	await waitForHydration(page);
	await page.getByLabel('E-mail').fill(email);
	await page.getByLabel('Kata sandi').fill(password);
	await page.getByRole('button', { name: 'Masuk', exact: true }).click();
	await page.waitForURL((url) => url.pathname !== '/masuk', { timeout: 30_000 });
}

/** The /dev/ui panel: seal text to the account's public key, then open it with the key this page holds. */
async function sealAndUnseal(page: Page, text: string) {
	await page.getByLabel('Plaintext').fill(text);
	await page.getByRole('button', { name: 'Seal', exact: true }).click();
	await expect(page.getByTestId('sealed')).toBeVisible();
	await page.getByRole('button', { name: 'Unseal', exact: true }).click();
}

test.describe('account key (FN-21)', () => {
	// Several scrypt derivations (128 MiB each) per journey, on two or more simulated devices.
	test.describe.configure({ timeout: 60_000 });
	test('sign-up makes the key; a second device unwraps it at sign-in; a reload or sign-out drops it', async ({
		browser
	}) => {
		const email = freshEmail('key');
		const a = await newDevice(browser);
		await signUp(a.page, email, '/dev/ui');
		await expect(a.page).toHaveURL(`${APP_ORIGIN}/dev/ui`);
		await waitForHydration(a.page);
		// Held right after sign-up (client navigation kept the page session).
		await sealAndUnseal(a.page, 'Mutasi BCA Oktober');
		await expect(a.page.getByTestId('unsealed')).toHaveText('Mutasi BCA Oktober');

		// A reload is a new page session: the key is not available until the next sign-in.
		await a.page.reload();
		await waitForHydration(a.page);
		await sealAndUnseal(a.page, 'setelah muat ulang');
		await expect(a.page.getByText(NOT_OPEN)).toBeVisible();
		await expect(a.page.getByTestId('unsealed')).toHaveCount(0);

		// The account page says the key is on, without a "Kunci dengan akunku" control.
		await a.page.goto('/pengaturan/akun');
		await expect(a.page.getByText(/^Kunci akun aktif\./)).toBeVisible();
		await expect(a.page.getByRole('button', { name: 'Kunci dengan akunku' })).toHaveCount(0);

		// Second device: sign-in derives the wrap key from the password and opens the same key.
		const b = await newDevice(browser);
		await signIn(b.page, email, PASSWORD, '/dev/ui');
		await expect(b.page).toHaveURL(`${APP_ORIGIN}/dev/ui`);
		await waitForHydration(b.page);
		await sealAndUnseal(b.page, 'perangkat kedua');
		await expect(b.page.getByTestId('unsealed')).toHaveText('perangkat kedua');

		// Sign-out replaces the whole document: the JS realm that held the key is gone.
		await b.page.goto('/pengaturan/akun');
		await waitForHydration(b.page);
		await b.page.evaluate(() => ((window as unknown as { fn21: number }).fn21 = 1));
		await b.page.getByRole('button', { name: 'Keluar dari akun' }).click();
		await expect(b.page).toHaveURL(/\/masuk/);
		expect(
			await b.page.evaluate(() => (window as unknown as { fn21?: number }).fn21)
		).toBeUndefined();

		await a.context.close();
		await b.context.close();
	});

	test('a password changed without JavaScript leaves the key on the old password; the new one cannot unwrap it until re-locked', async ({
		browser
	}) => {
		const email = freshEmail('stale');
		const a = await newDevice(browser);
		await signUp(a.page, email, '/');
		const state = await a.context.storageState();

		// The same session on a browser without JavaScript: the password changes, the key cannot be re-wrapped.
		const noJs = await newDevice(browser, { javaScriptEnabled: false, storageState: state });
		await noJs.page.goto('/pengaturan/akun');
		await noJs.page.locator('#change-current-password').fill(PASSWORD);
		await noJs.page.locator('#change-new-password').fill(NEW_PASSWORD);
		await noJs.page.locator('#change-confirm-password').fill(NEW_PASSWORD);
		await noJs.page.getByRole('button', { name: 'Ubah kata sandi' }).click();
		await expect(noJs.page.getByText('Kata sandi diubah.')).toBeVisible();
		await expect(noJs.page.getByText(KEY_STALE).first()).toBeVisible();

		// A key-capable device signing in with the new password cannot unwrap: it lands on the explanation.
		const c = await newDevice(browser);
		await signIn(c.page, email, NEW_PASSWORD, '/dev/ui');
		await expect(c.page).toHaveURL(`${APP_ORIGIN}/pengaturan/akun`);
		await expect(c.page.getByText(KEY_STALE)).toBeVisible();

		// Re-lock: a wrong earlier password is refused on the device, the right one re-wraps the same key.
		await waitForHydration(c.page);
		await c.page.locator('#previous-password').fill('bukan-yang-lama-1');
		await c.page.locator('#rewrap-password').fill(NEW_PASSWORD);
		await c.page.getByRole('button', { name: 'Kunci ulang' }).click();
		await expect(c.page.getByText('Kata sandi sebelumnya salah.')).toBeVisible();
		await c.page.locator('#previous-password').fill(PASSWORD);
		await c.page.locator('#rewrap-password').fill(NEW_PASSWORD);
		await c.page.getByRole('button', { name: 'Kunci ulang' }).click();
		await expect(c.page.getByText('Kunci akun dikunci ulang.')).toBeVisible({ timeout: 30_000 });
		await expect(c.page.getByText(KEY_STALE)).toHaveCount(0);

		// The re-locked key now opens with the new password on another device.
		const d = await newDevice(browser);
		await signIn(d.page, email, NEW_PASSWORD, '/dev/ui');
		await expect(d.page).toHaveURL(`${APP_ORIGIN}/dev/ui`);
		await waitForHydration(d.page);
		await sealAndUnseal(d.page, 'dikunci ulang');
		await expect(d.page.getByTestId('unsealed')).toHaveText('dikunci ulang');

		for (const x of [a, noJs, c, d]) await x.context.close();
	});

	test('a password changed with JavaScript re-wraps the key: it opens with the new password', async ({
		browser
	}) => {
		const email = freshEmail('change');
		const a = await newDevice(browser);
		await signUp(a.page, email, '/pengaturan/akun');
		await waitForHydration(a.page);
		await a.page.locator('#change-current-password').fill('salah-sekali-1');
		await a.page.locator('#change-new-password').fill(NEW_PASSWORD);
		await a.page.locator('#change-confirm-password').fill(NEW_PASSWORD);
		await a.page.getByRole('button', { name: 'Ubah kata sandi' }).click();
		await expect(a.page.getByText('E-mail atau kata sandi salah.')).toBeVisible();

		await a.page.locator('#change-current-password').fill(PASSWORD);
		await a.page.locator('#change-new-password').fill(NEW_PASSWORD);
		await a.page.locator('#change-confirm-password').fill(NEW_PASSWORD);
		await a.page.getByRole('button', { name: 'Ubah kata sandi' }).click();
		await expect(a.page.getByText('Kata sandi diubah.')).toBeVisible({ timeout: 30_000 });
		await expect(a.page.getByText(KEY_STALE)).toHaveCount(0);

		const b = await newDevice(browser);
		await signIn(b.page, email, NEW_PASSWORD, '/dev/ui');
		await expect(b.page).toHaveURL(`${APP_ORIGIN}/dev/ui`);
		await waitForHydration(b.page);
		await sealAndUnseal(b.page, 'kata sandi baru');
		await expect(b.page.getByTestId('unsealed')).toHaveText('kata sandi baru');
		await a.context.close();
		await b.context.close();
	});

	test('sign-up without JavaScript has no key; "Kunci dengan akunku" activates one and disappears', async ({
		browser
	}) => {
		const email = freshEmail('nojs');
		const noJs = await newDevice(browser, { javaScriptEnabled: false });
		await signUp(noJs.page, email, undefined, false);
		await expect(noJs.page).toHaveURL(`${APP_ORIGIN}/`);
		await noJs.page.goto('/pengaturan/akun');
		await expect(noJs.page.getByText(/^Kunci akun belum aktif\./)).toBeVisible();
		// Without JavaScript the server explains why a key cannot be made here.
		await noJs.page.locator('#activate-password').fill(PASSWORD);
		await noJs.page.getByRole('button', { name: 'Kunci dengan akunku' }).click();
		await expect(
			noJs.page.getByText(
				'Browser ini belum bisa membuat kunci akun. Gunakan browser terbaru dengan JavaScript aktif.'
			)
		).toBeVisible();

		const js = await newDevice(browser, { storageState: await noJs.context.storageState() });
		await js.page.goto('/pengaturan/akun');
		await waitForHydration(js.page);
		await js.page.locator('#activate-password').fill(PASSWORD);
		await js.page.getByRole('button', { name: 'Kunci dengan akunku' }).click();
		await expect(js.page.getByText('Kunci akun diaktifkan.')).toBeVisible({ timeout: 30_000 });
		await expect(js.page.getByRole('button', { name: 'Kunci dengan akunku' })).toHaveCount(0);
		await expect(js.page.getByText(/^Kunci akun aktif\./)).toBeVisible();
		await noJs.context.close();
		await js.context.close();
	});

	test('a password change signs the other devices out; this one stays (red team M1)', async ({
		browser
	}) => {
		const email = freshEmail('revoke');
		const a = await newDevice(browser);
		await signUp(a.page, email, '/pengaturan/akun');
		const b = await newDevice(browser);
		await signIn(b.page, email, PASSWORD, '/riwayat');
		await expect(b.page).toHaveURL(`${APP_ORIGIN}/riwayat`);

		await waitForHydration(a.page);
		await a.page.locator('#change-current-password').fill(PASSWORD);
		await a.page.locator('#change-new-password').fill(NEW_PASSWORD);
		await a.page.locator('#change-confirm-password').fill(NEW_PASSWORD);
		await a.page.getByRole('button', { name: 'Ubah kata sandi' }).click();
		await expect(a.page.getByText('Kata sandi diubah.')).toBeVisible({ timeout: 30_000 });

		await b.page.goto('/riwayat');
		await expect(b.page).toHaveURL(/\/masuk\?next=%2Friwayat/);
		await a.page.goto('/riwayat');
		await expect(a.page).toHaveURL(`${APP_ORIGIN}/riwayat`);
		await a.context.close();
		await b.context.close();
	});

	test('signing out in another tab drops the key held in this tab (red team L2)', async ({
		browser
	}) => {
		const email = freshEmail('tabs');
		const a = await newDevice(browser);
		await signUp(a.page, email, '/dev/ui');
		await expect(a.page).toHaveURL(`${APP_ORIGIN}/dev/ui`);
		await waitForHydration(a.page);
		await sealAndUnseal(a.page, 'sebelum keluar');
		await expect(a.page.getByTestId('unsealed')).toHaveText('sebelum keluar');

		// A second tab of the same browser (same cookie) signs out.
		const other = await a.context.newPage();
		await other.goto('/pengaturan/akun');
		await waitForHydration(other);
		await other.getByRole('button', { name: 'Keluar dari akun' }).click();
		await expect(other).toHaveURL(/\/masuk/);

		// No reload in the first tab: its key is gone all the same.
		await sealAndUnseal(a.page, 'setelah keluar di tab lain');
		await expect(a.page.getByText(NOT_OPEN)).toBeVisible();
		await a.context.close();
	});

	test('the scrypt worker script is served with its own CSP (red team L4)', async ({ browser }) => {
		const a = await newDevice(browser);
		const workerUrl = new Promise<string>((resolve) =>
			a.page.on('request', (r) => {
				if (/\/_app\/immutable\/workers\/derive\.worker-[^/]+\.js$/.test(r.url())) resolve(r.url());
			})
		);
		await signUp(a.page, freshEmail('csp'), '/');
		const response = await a.page.request.get(await workerUrl);
		expect(response.status()).toBe(200);
		expect(response.headers()['content-security-policy']).toBe(
			"default-src 'none'; base-uri 'none'"
		);
		await a.context.close();
	});
});
