import { expect, test } from '@playwright/test';
import {
	tickSignUpBoxes,
	expectNoHorizontalScroll,
	SIGNED_OUT,
	simulatedClientIp,
	waitForHydration,
	APP_ORIGIN,
	SITE_ORIGIN
} from './helpers';

// These journeys start signed out (not the shared e2e session), and each test is its own simulated client, so
// the per-client sign-in/sign-up throttle (20 per 10 min) never mixes tests and they can run in parallel.
test.use({
	storageState: SIGNED_OUT,
	// eslint-disable-next-line no-empty-pattern
	extraHTTPHeaders: async ({}, use, testInfo) =>
		use({ 'cf-connecting-ip': simulatedClientIp(testInfo) })
});

/** FN-01 journeys. Each test creates its own account (unique e-mail) so runs never collide. */
function freshEmail(tag: string): string {
	return `fn01-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

const PASSWORD = 'terang-benderang-8';

async function signUp(
	page: import('@playwright/test').Page,
	email: string,
	opts: { next?: string } = {}
) {
	const target = opts.next ? `/daftar?next=${encodeURIComponent(opts.next)}` : '/daftar';
	await page.goto(target);
	await waitForHydration(page);
	await page.getByLabel('Nama').fill('Budi Santoso');
	await page.getByLabel('E-mail').fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	// Wait for the server's redirect: a navigation started before it lands would abort the sign-up.
	await page.waitForURL((url) => url.pathname !== '/daftar');
}

test.describe('sign-up (/daftar)', () => {
	test('signs up, lands on Beranda signed in, and a reload keeps the session', async ({ page }) => {
		const email = freshEmail('signup');
		await signUp(page, email);
		await expect(page).toHaveURL(`${APP_ORIGIN}/`);
		await expect(page.getByRole('heading', { level: 1, name: 'Beranda' })).toBeVisible();

		await page.reload();
		await expect(page).toHaveURL(`${APP_ORIGIN}/`);
		await page.goto('/pengaturan/akun');
		await expect(page.locator('main').getByText(email)).toBeVisible();
	});

	test('refuses without the 18+ box, inline, with JS and writes nothing (resubmit stays refused)', async ({
		page
	}) => {
		const email = freshEmail('noadult');
		await page.goto('/daftar');
		await waitForHydration(page);
		await page.getByLabel('Nama').fill('Budi Santoso');
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		// The checkbox's own `required` attribute would block the browser from submitting at all; removing
		// it (as a client that skips it would) is how this exercises the *server's* own field check.
		await page.getByRole('checkbox', { name: /Saya menyetujui/ }).check();
		await page
			.getByRole('checkbox', { name: /18 tahun/ })
			.evaluate((el) => el.removeAttribute('required'));
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page).toHaveURL(/\/daftar/);
		await expect(page.getByText('Centang konfirmasi usia untuk melanjutkan.')).toBeVisible();

		// No row was written: signing up again with the same e-mail (now checked) must succeed.
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/`);
	});

	test('refuses without the terms and privacy consent box (FN-31) and writes nothing', async ({
		page
	}) => {
		const email = freshEmail('noconsent');
		await page.goto('/daftar');
		await waitForHydration(page);
		await page.getByLabel('Nama').fill('Budi Santoso');
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('checkbox', { name: /18 tahun/ }).check();
		await page
			.getByRole('checkbox', { name: /Saya menyetujui/ })
			.evaluate((el) => el.removeAttribute('required'));
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page).toHaveURL(/\/daftar/);
		await expect(
			page.getByText('Centang persetujuan ketentuan dan kebijakan privasi untuk melanjutkan.')
		).toBeVisible();

		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/`);
	});

	test('refuses a short password and a duplicate e-mail, inline, without JavaScript', async ({
		browser
	}, testInfo) => {
		const context = await browser.newContext({
			javaScriptEnabled: false,
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo) }
		});
		const page = await context.newPage();
		const email = freshEmail('nojs');

		await page.goto(`${APP_ORIGIN}/daftar`);
		await page.getByLabel('Nama').fill('Budi Santoso');
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill('short1');
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page.getByText('Kata sandi minimal 8 karakter.')).toBeVisible();

		// A real sign-up with JS off, then a second attempt with the same e-mail is the duplicate case.
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/`);

		await page.goto(`${APP_ORIGIN}/pengaturan/akun`);
		await page.getByRole('button', { name: 'Keluar dari akun' }).click();
		await expect(page).toHaveURL(/\/masuk/);

		await page.goto(`${APP_ORIGIN}/daftar`);
		await page.getByLabel('Nama').fill('Budi Lain');
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page.getByText('E-mail sudah terdaftar.')).toBeVisible();
		await context.close();
	});
});

test.describe('sign-in (/masuk)', () => {
	test('with next lands on the requested page; a wrong password shows the generic message', async ({
		page
	}) => {
		const email = freshEmail('signin');
		await signUp(page, email);
		await page.goto('/pengaturan/akun');
		await page.getByRole('button', { name: 'Keluar dari akun' }).click();
		await expect(page).toHaveURL(/\/masuk/);

		await page.goto('/masuk?next=%2Fpengaturan%2Fakun');
		await waitForHydration(page);
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill('wrong-password-1');
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await expect(page.getByText('E-mail atau kata sandi salah.')).toBeVisible();
		await expect(page).toHaveURL(/\/masuk/);

		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/akun`);
	});
});

test.describe('session middleware', () => {
	test('a signed-out visit to /riwayat redirects to /masuk?next=…, then returns there after sign-in', async ({
		page
	}) => {
		const email = freshEmail('nextflow');
		await page.goto('/riwayat');
		await expect(page).toHaveURL(/\/masuk\?next=%2Friwayat/);

		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		// The account does not exist yet: generic refusal, then create it and retry via the same link.
		await expect(page.getByText('E-mail atau kata sandi salah.')).toBeVisible();

		await page.goto('/daftar?next=%2Friwayat');
		await page.getByLabel('Nama').fill('Budi Santoso');
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/riwayat`);
	});

	test('two browser contexts: signing out on one leaves the other signed in', async ({
		browser
	}, testInfo) => {
		const email = freshEmail('twodev');
		const ctxA = await browser.newContext({
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) }
		});
		const pageA = await ctxA.newPage();
		await signUp(pageA, email);
		await expect(pageA).toHaveURL(`${APP_ORIGIN}/`);

		const ctxB = await browser.newContext({
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
		});
		const pageB = await ctxB.newPage();
		await pageB.goto('/masuk');
		await pageB.getByLabel('E-mail').fill(email);
		await pageB.getByLabel('Kata sandi').fill(PASSWORD);
		await pageB.getByRole('button', { name: 'Masuk', exact: true }).click();
		await expect(pageB).toHaveURL(`${APP_ORIGIN}/`);

		await pageA.goto('/pengaturan/akun');
		await pageA.getByRole('button', { name: 'Keluar dari akun' }).click();
		await expect(pageA).toHaveURL(/\/masuk/);

		await pageA.goto('/riwayat');
		await expect(pageA).toHaveURL(/\/masuk/);

		await pageB.goto('/riwayat');
		await expect(pageB).toHaveURL(`${APP_ORIGIN}/riwayat`);
		await expect(pageB.getByRole('heading', { level: 1, name: 'Transaksi' })).toBeVisible();

		await ctxA.close();
		await ctxB.close();
	});
});

test.describe('account page (/pengaturan/akun)', () => {
	test('shows name, e-mail and the WIB creation date; delete refuses a wrong password, then deletes for real', async ({
		page
	}) => {
		const email = freshEmail('delete');
		await signUp(page, email);
		await page.goto('/pengaturan/akun');
		await expect(page.locator('main').getByText('Budi Santoso')).toBeVisible();
		await expect(page.locator('main').getByText(email)).toBeVisible();
		await expect(page.getByText(/WIB$/)).toBeVisible();

		await page.locator('#delete-password').fill('wrong-password-1');
		await page.getByRole('checkbox', { name: /dihapus permanen/ }).check();
		await page.getByRole('button', { name: 'Hapus akun permanen' }).click();
		await expect(page.getByText('E-mail atau kata sandi salah.')).toBeVisible();
		await expect(page).toHaveURL(/\/pengaturan\/akun/);

		await page.locator('#delete-password').fill(PASSWORD);
		await page.getByRole('checkbox', { name: /dihapus permanen/ }).check();
		await page.getByRole('button', { name: 'Hapus akun permanen' }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/akun-dihapus`);

		await page.goto('/masuk');
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await expect(page.getByText('E-mail atau kata sandi salah.')).toBeVisible();
	});
});

test.describe('360 px, light and dark', () => {
	const checks: Array<{ path: string; heading: string; signedIn?: boolean }> = [
		{ path: '/masuk', heading: 'Masuk' },
		{ path: '/daftar', heading: 'Buat akun' },
		{ path: '/pengaturan/akun', heading: 'Akun', signedIn: true }
	];

	for (const { path, heading, signedIn } of checks) {
		for (const theme of ['light', 'dark'] as const) {
			test(`${path} at 360 px, ${theme}`, async ({ page, context }) => {
				if ((page.viewportSize()?.width ?? 0) > 400) test.skip(true, 'phone project only');
				if (signedIn) {
					const email = freshEmail(`w${theme}${path.replace(/\W/g, '')}`);
					await signUp(page, email);
				}
				await context.addCookies([{ name: 'theme', value: theme, url: APP_ORIGIN }]);
				await page.goto(path);
				await waitForHydration(page);
				await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
				await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
				await expectNoHorizontalScroll(page);
				// Buttons must meet the 44 px target themselves; a checkbox's own box can be smaller (22 px by
				// design) as long as its wrapping label is the actual 44 px tap target.
				for (const box of await Promise.all(
					(await page.getByRole('button').all()).map((t) => t.boundingBox())
				)) {
					if (!box) continue;
					expect(box.height).toBeGreaterThanOrEqual(44);
				}
				for (const box of await Promise.all(
					(await page.locator('label.check, label:has(input[type="checkbox"])').all()).map((t) =>
						t.boundingBox()
					)
				)) {
					if (!box) continue;
					expect(box.height).toBeGreaterThanOrEqual(44);
				}
			});
		}
	}
});

test.describe('site host /hapus-akun', () => {
	test('renders the explanation page without a configured support address', async ({ page }) => {
		await page.goto(`${SITE_ORIGIN}/hapus-akun`);
		await expect(page.getByRole('heading', { level: 1, name: 'Hapus akun' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Buka Pengaturan › Akun' })).toHaveAttribute(
			'href',
			`${APP_ORIGIN}/pengaturan/akun`
		);
		// SUPPORT_EMAIL is unset in the e2e webServer env: no mailto link, the fallback note instead.
		await expect(page.getByText('Alamat dukungan belum dikonfigurasi.')).toBeVisible();
	});
});
