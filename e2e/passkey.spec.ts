import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	newDevice as newDeviceBase,
	expectNoHorizontalScroll,
	PASSWORD,
	SIGNED_OUT,
	signUp,
	uniqueEmail,
	waitForHydration
} from './helpers';

/**
 * FN-50 passkeys in a real browser: Chromium's virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`) stands
 * in for Face ID / a fingerprint reader, so registration and sign-in run through the real `navigator.credentials`
 * and the real server verifier. Each test signs up its own account in its own simulated client. Turnstile is not
 * configured on the e2e server, so these journeys also show sign-in unchanged while it is off.
 */
test.use({ storageState: SIGNED_OUT });
// Several scrypt (128 MiB) and PBKDF2 derivations per journey.
test.describe.configure({ timeout: 180_000 });

const CANCELLED = 'Dibatalkan. Masuk dengan kata sandi atau coba lagi.';
const NOT_OPEN = 'Kunci akun belum dibuka di sesi ini. Buka dengan kata sandi di halaman Akun.';

const freshEmail = (tag: string) => uniqueEmail(`fn50-${tag}`);

async function newDevice(
	browser: Browser,
	opts: { javaScriptEnabled?: boolean; theme?: 'dark' } = {}
): Promise<{ context: BrowserContext; page: Page }> {
	const device = await newDeviceBase(browser, {
		viewport: { width: 360, height: 780 },
		hasTouch: true,
		isMobile: true,
		javaScriptEnabled: opts.javaScriptEnabled
	});
	if (opts.theme)
		await device.context.addCookies([{ name: 'theme', value: opts.theme, url: APP_ORIGIN }]);
	return device;
}

/** A platform authenticator that holds discoverable credentials and verifies the user automatically. */
async function addAuthenticator(context: BrowserContext, page: Page) {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	return { cdp, authenticatorId };
}

async function signUpAndSettle(page: Page, email: string) {
	await signUp(page, { email, timeout: 60_000 });
	// The redirect target finishes loading before the next navigation (a goto mid-load is aborted).
	await waitForHydration(page);
}

async function addPasskey(page: Page, name: string) {
	await page.getByRole('button', { name: 'Tambah passkey' }).click();
	await page.getByLabel('Nama (opsional)').fill(name);
	// The register sheet's own field (each listed passkey's removal form has one too).
	await page.locator('#passkey-password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Buat passkey' }).click();
	await expect(page.getByText('Passkey ditambahkan.')).toBeVisible({ timeout: 60_000 });
}

test.describe('passkeys (FN-50)', () => {
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'CDP virtual authenticator: Chromium only'
	);

	test('register, sign out, sign in with the passkey, open the account key with the password, remove', async ({
		browser
	}) => {
		const email = freshEmail('journey');
		const { context, page } = await newDevice(browser);
		const authenticator = await addAuthenticator(context, page);
		await signUpAndSettle(page, email);

		// AC 16: empty state, then AC 19 and 49: registered, listed after the reload, focus back on the opener.
		await page.goto('/pengaturan/akun/passkey');
		await waitForHydration(page);
		await expect(page.getByText('Belum ada passkey')).toBeVisible();
		await addPasskey(page, 'Pixel Budi');
		await expect(page.getByRole('button', { name: 'Tambah passkey' })).toBeFocused();
		await page.reload();
		await expect(page.getByText('Pixel Budi')).toBeVisible();
		await expect(page.getByText('1 dari 10')).toBeVisible();

		// Sign out, then AC 25/26 through the e-mail field's autofill (conditional mediation): the virtual
		// authenticator answers the conditional request at once, as picking the passkey from the autofill does.
		const signOut = async () => {
			await page.goto('/pengaturan/akun');
			await waitForHydration(page);
			await page.getByRole('button', { name: 'Keluar dari akun' }).click();
			await expect(page).toHaveURL(/\/masuk/);
		};
		await signOut();
		await page.goto('/masuk?next=%2Fpengaturan%2Fakun%2Fpasskey');
		await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/akun/passkey`, { timeout: 60_000 });
		await expect(page.getByText('Pixel Budi')).toBeVisible();
		await expect(page.getByText(/Terakhir dipakai \d/)).toBeVisible();

		// Then the button: the authenticator waits for a touch, so the autofill request stays pending; the button
		// replaces it with a modal request, which the touch (presence switched back on) answers.
		await signOut();
		await authenticator.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
			authenticatorId: authenticator.authenticatorId,
			enabled: false
		});
		await page.goto('/masuk?next=%2Fdev%2Fui');
		await waitForHydration(page);
		const conditional = await page.evaluate(async () => {
			const pkc = window.PublicKeyCredential as unknown as {
				isConditionalMediationAvailable?: () => Promise<boolean>;
			};
			return (await pkc.isConditionalMediationAvailable?.()) ?? false;
		});
		if (conditional)
			await expect(page.getByLabel('E-mail')).toHaveAttribute('autocomplete', 'username webauthn');
		await authenticator.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
			authenticatorId: authenticator.authenticatorId,
			enabled: true
		});
		await page.getByRole('button', { name: 'Masuk dengan passkey' }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/dev/ui`, { timeout: 60_000 });
		await waitForHydration(page);

		// AC 36: no password in this page session, so the account key is closed; the link leads to the unlock form.
		await page.getByLabel('Plaintext').fill('Mutasi BCA Oktober');
		await page.getByRole('button', { name: 'Seal', exact: true }).click();
		await page.getByRole('button', { name: 'Unseal', exact: true }).click();
		await expect(page.getByText(NOT_OPEN)).toBeVisible();
		await page.getByTestId('open-key-link').click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/pengaturan/akun`);
		const unlock = page.getByTestId('unlock-key');
		await unlock.getByLabel('Kata sandi saat ini').fill('salah-sekali-9');
		await unlock.getByRole('button', { name: 'Buka kunci dengan kata sandi' }).click();
		await expect(page.getByText('E-mail atau kata sandi salah.')).toBeVisible({ timeout: 60_000 });
		await unlock.getByLabel('Kata sandi saat ini').fill(PASSWORD);
		await unlock.getByRole('button', { name: 'Buka kunci dengan kata sandi' }).click();
		await expect(page.getByText('Kunci akun dibuka di perangkat ini.')).toBeVisible({
			timeout: 30_000
		});
		// Back to the panel in the same page session: it now unseals as after a password sign-in.
		await page.goBack();
		await expect(page).toHaveURL(`${APP_ORIGIN}/dev/ui`);
		await page.getByLabel('Plaintext').fill('setelah buka kunci');
		await page.getByRole('button', { name: 'Seal', exact: true }).click();
		await page.getByRole('button', { name: 'Unseal', exact: true }).click();
		await expect(page.getByTestId('unsealed')).toHaveText('setelah buka kunci');

		// AC 38: remove it with the password; the list is empty again after the server confirmed.
		await page.goto('/pengaturan/akun/passkey');
		await waitForHydration(page);
		await page.getByText('Hapus', { exact: true }).click();
		await page.getByLabel('Kata sandi saat ini').first().fill(PASSWORD);
		await page.getByRole('button', { name: 'Ya, hapus' }).click();
		await expect(
			page.getByText('Passkey dihapus. Sesi yang dibuat dengannya ditutup.')
		).toBeVisible();
		await expect(page.getByText('Belum ada passkey')).toBeVisible();
		await context.close();
	});

	test('a dismissed passkey prompt says so, makes no server call, and the password form still works', async ({
		browser
	}) => {
		const email = freshEmail('cancel');
		const { context, page } = await newDevice(browser);
		await signUpAndSettle(page, email);
		await page.goto('/pengaturan/akun');
		await waitForHydration(page);
		await page.getByRole('button', { name: 'Keluar dari akun' }).click();
		await expect(page).toHaveURL(/\/masuk/);
		await waitForHydration(page);
		// An authenticator without any credential for this site: the browser rejects the request the way a dismissed
		// prompt does (NotAllowedError).
		await addAuthenticator(context, page);
		const posts: string[] = [];
		page.on('request', (r) => {
			if (r.method() === 'POST' && r.url().includes('?/passkey&')) posts.push(r.url());
			if (r.method() === 'POST' && r.url().endsWith('?/passkey')) posts.push(r.url());
		});
		await page.getByRole('button', { name: 'Masuk dengan passkey' }).click();
		await expect(page.getByText(CANCELLED)).toBeVisible({ timeout: 60_000 });
		expect(posts).toEqual([]);
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await page.waitForURL((url) => url.pathname !== '/masuk', { timeout: 60_000 });
		await context.close();
	});

	test('without JavaScript /masuk has no passkey button and the password form posts as before', async ({
		browser
	}) => {
		const email = freshEmail('nojs');
		const js = await newDevice(browser);
		await signUpAndSettle(js.page, email);
		await js.context.close();
		const { context, page } = await newDevice(browser, { javaScriptEnabled: false });
		await page.goto('/masuk');
		await expect(page.getByRole('button', { name: 'Masuk dengan passkey' })).toHaveCount(0);
		await expect(page.getByLabel('E-mail')).toHaveAttribute('autocomplete', 'email');
		await page.getByLabel('E-mail').fill(email);
		await page.getByLabel('Kata sandi').fill(PASSWORD);
		await page.getByRole('button', { name: 'Masuk', exact: true }).click();
		await page.waitForURL((url) => url.pathname !== '/masuk', { timeout: 60_000 });
		await context.close();
	});

	test('the list at 360 px in the dark theme: long names truncate, controls are 44 px, no horizontal scroll', async ({
		browser
	}) => {
		const email = freshEmail('list');
		const { context, page } = await newDevice(browser, { theme: 'dark' });
		await signUpAndSettle(page, email);
		await page.goto('/pengaturan/akun/passkey');
		await waitForHydration(page);
		// Three devices: one authenticator holds one passkey per account (it refuses a second, excludeCredentials).
		let previous: Awaited<ReturnType<typeof addAuthenticator>> | null = null;
		for (const n of [1, 2, 3]) {
			if (previous)
				await previous.cdp.send('WebAuthn.removeVirtualAuthenticator', {
					authenticatorId: previous.authenticatorId
				});
			previous = await addAuthenticator(context, page);
			await addPasskey(page, `${n} ${'Perangkat keluarga Santoso '.repeat(3)}`.slice(0, 40));
		}
		// The same device again: the browser refuses and the page says why.
		await page.getByRole('button', { name: 'Tambah passkey' }).click();
		await page.locator('#passkey-password').fill(PASSWORD);
		await page.getByRole('button', { name: 'Buat passkey' }).click();
		await expect(
			page.getByText('Perangkat ini sudah menyimpan passkey untuk akun ini.')
		).toBeVisible();
		await page.getByRole('button', { name: 'Batal' }).click();
		await page.reload();
		await waitForHydration(page);
		await expect(page.getByText('3 dari 10')).toBeVisible();
		await expectNoHorizontalScroll(page);
		const names = page.locator('.name');
		await expect(names).toHaveCount(3);
		for (const name of await names.all()) {
			const overflow = await name.evaluate((el) => ({
				ellipsis: getComputedStyle(el).textOverflow,
				clipped: el.scrollWidth > el.clientWidth
			}));
			expect(overflow.ellipsis).toBe('ellipsis');
		}
		await expect(page.getByText(/Dibuat \d{1,2} \S+ 2\d{3}.*WIB/).first()).toBeVisible();
		for (const control of await page.locator('summary, button').all()) {
			if (!(await control.isVisible())) continue;
			const box = await control.boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
		await context.close();
	});
});
