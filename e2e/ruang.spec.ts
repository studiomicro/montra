import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
	APP_ORIGIN,
	expectNoHorizontalScroll,
	PASSWORD,
	SIGNED_OUT,
	simulatedClientIp,
	STORAGE_STATE,
	tickSignUpBoxes,
	waitForHydration
} from './helpers';

/**
 * FN-03 journeys. The owner is the shared signed-in e2e user (`page`); everyone else is a fresh account in its
 * own context with its own simulated client address (n ≥ 1), so the sign-up throttle never mixes users.
 */
const INVITE_LINK = new RegExp(`^${APP_ORIGIN}/ruang/undangan/[A-Za-z0-9_-]{43}$`);

const unique = (tag: string, testInfo: TestInfo) =>
	`${tag} ${testInfo.project.name} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Creates a shared space through /ruang/baru and an invite link; returns the space URL and the link. */
async function createSpaceWithInvite(page: Page, name: string) {
	await page.goto('/ruang/baru');
	await waitForHydration(page);
	await page.getByLabel('Nama ruang').fill(name);
	await page.getByRole('button', { name: 'Buat ruang' }).click();
	await page.waitForURL(/\/ruang\/[0-9a-f-]{36}$/);
	const spaceUrl = page.url();
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Buat tautan undangan' }).click();
	const link = await page.getByLabel('Tautan undangan').inputValue();
	expect(link).toMatch(INVITE_LINK);
	return { spaceUrl, link };
}

/** A fresh account in its own context: opens the invite signed out, signs up via /masuk → Daftar, lands back. */
async function newUserAtInvite(browser: Browser, testInfo: TestInfo, n: number, link: string) {
	const context = await browser.newContext({
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, n) }
	});
	const page = await context.newPage();
	await page.goto(link);
	const next = new URL(link).pathname;
	await expect(page).toHaveURL(`${APP_ORIGIN}/masuk?next=${encodeURIComponent(next)}`);
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Daftar' }).click();
	await page.waitForURL(/\/daftar\?next=/);
	await waitForHydration(page);
	await page.getByLabel('Nama').fill(`Tamu ${n}`);
	await page
		.getByLabel('E-mail')
		.fill(`fn03-${n}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(page);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await page.waitForURL(link);
	await waitForHydration(page);
	return { context, page };
}

async function join(page: Page) {
	await page.getByRole('button', { name: 'Gabung ke ruang' }).click();
	await page.waitForURL(`${APP_ORIGIN}/`);
}

test('owner creates a shared space and copies the invite link; focus stays on the copy button', async ({
	page
}, testInfo) => {
	await page
		.context()
		.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN });
	const name = unique('Keluarga', testInfo);
	await page.goto('/ruang');
	await page.getByRole('link', { name: 'Buat ruang bersama' }).first().click();
	await expect(page).toHaveURL(`${APP_ORIGIN}/ruang/baru`);
	const { spaceUrl, link } = await createSpaceWithInvite(page, name);
	const copy = page.getByRole('button', { name: 'Salin tautan' });
	await copy.click();
	await expect(page.getByText('Tautan disalin.')).toBeVisible();
	await expect(copy).toBeFocused();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
	// A second read of the page shows only that a link is live, never the link itself.
	await page.goto(spaceUrl);
	await expect(page.getByText(/Tautan undangan aktif sampai/)).toBeVisible();
	expect(await page.content()).not.toContain(link.split('/').pop()!);
	// The new space is current and listed after the personal one.
	await page.goto('/ruang');
	const row = page.getByRole('listitem').filter({ hasText: name });
	await expect(row.getByText('Sedang dipakai')).toBeVisible();
});

test('signed-out invitee goes through /masuk?next=, signs up, joins and lands on Beranda', async ({
	page,
	browser
}, testInfo) => {
	const name = unique('Rumah', testInfo);
	const { link } = await createSpaceWithInvite(page, name);
	const guest = await newUserAtInvite(browser, testInfo, 1, link);
	await expect(guest.page.getByText(`Kamu diundang ke ruang ${name}.`)).toBeVisible();
	await join(guest.page);
	await expect(guest.page.getByRole('heading', { level: 1, name: 'Beranda' })).toBeVisible();
	await guest.page.goto('/ruang');
	const row = guest.page.getByRole('listitem').filter({ hasText: name });
	await expect(row.getByText('Anggota')).toBeVisible();
	await expect(row.getByText('Sedang dipakai')).toBeVisible();
	await guest.context.close();
});

test('owner removes a member; the member’s old URL is a plain 404', async ({
	page,
	browser
}, testInfo) => {
	const { spaceUrl, link } = await createSpaceWithInvite(page, unique('Kos', testInfo));
	const guest = await newUserAtInvite(browser, testInfo, 1, link);
	await join(guest.page);
	await guest.page.goto(spaceUrl);
	await expect(guest.page.getByText('Kamu anggota ruang ini')).toBeVisible();

	await page.goto(spaceUrl);
	await waitForHydration(page);
	await page.locator('summary', { hasText: 'Keluarkan' }).click();
	await page.getByRole('button', { name: 'Ya, keluarkan' }).click();
	await expect(page.getByText('Anggota dikeluarkan dari ruang.')).toBeVisible();
	await expect(page.getByText('Tamu 1')).toHaveCount(0);

	const res = await guest.page.goto(spaceUrl);
	expect(res?.status()).toBe(404);
	await expect(guest.page.getByText('Halaman tidak ditemukan.')).toBeVisible();
	// Their next page falls back to the personal space without an error.
	expect((await guest.page.goto('/'))?.status()).toBe(200);
	await guest.context.close();
});

test('a member leaves; once five are in, a sixth person sees that the space is full', async ({
	page,
	browser
}, testInfo) => {
	test.setTimeout(120_000);
	const { spaceUrl, link } = await createSpaceWithInvite(page, unique('Arisan', testInfo));
	const guests = [];
	for (let n = 1; n <= 4; n++) {
		const g = await newUserAtInvite(browser, testInfo, n, link);
		await join(g.page);
		guests.push(g);
	}
	// Member 1 leaves through the confirm.
	const leaver = guests[0]!.page;
	await leaver.goto(spaceUrl);
	await waitForHydration(leaver);
	await leaver.locator('summary', { hasText: 'Keluar dari ruang' }).click();
	await leaver.getByRole('button', { name: 'Ya, keluar' }).click();
	await expect(leaver).toHaveURL(`${APP_ORIGIN}/ruang`);
	await expect(leaver.getByText('Kamu sudah keluar dari ruang.')).toBeVisible();

	// The freed slot is taken by a fifth person; the sixth is refused.
	const fifth = await newUserAtInvite(browser, testInfo, 5, link);
	await join(fifth.page);
	const sixth = await newUserAtInvite(browser, testInfo, 6, link);
	await expect(sixth.page.getByText(/Ruang ini sudah penuh\./)).toBeVisible();
	await expect(sixth.page.getByRole('button', { name: 'Gabung ke ruang' })).toHaveCount(0);

	await page.goto(spaceUrl);
	await expect(page.getByText('5 dari 5 orang')).toBeVisible();
	for (const g of [...guests, fifth, sixth]) await g.context.close();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`/ruang pages fit 360 px in ${colorScheme} with 44 px targets`, async ({
		browser
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'phone', '360 px layout is a phone check');
		const context = await browser.newContext({
			colorScheme,
			storageState: STORAGE_STATE,
			viewport: { width: 360, height: 780 },
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo) }
		});
		const page = await context.newPage();
		const { spaceUrl } = await createSpaceWithInvite(
			page,
			unique('Panjang sekali namanya', testInfo)
		);
		await expectNoHorizontalScroll(page);
		for (const name of ['Buat tautan baru', 'Cabut tautan']) {
			const box = await page.getByRole('button', { name }).boundingBox();
			expect(box?.height).toBeGreaterThanOrEqual(44);
		}
		await page.goto('/ruang');
		await expectNoHorizontalScroll(page);
		await page.goto(spaceUrl);
		await expectNoHorizontalScroll(page);
		await context.close();
	});
}

test('without JavaScript: create a space, make a link, and a new user accepts it', async ({
	browser
}, testInfo) => {
	const owner = await browser.newContext({
		javaScriptEnabled: false,
		storageState: STORAGE_STATE,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo) }
	});
	const page = await owner.newPage();
	const name = unique('Tanpa JS', testInfo);
	await page.goto('/ruang/baru');
	await page.getByLabel('Nama ruang').fill(name);
	await page.getByRole('button', { name: 'Buat ruang' }).click();
	await page.waitForURL(/\/ruang\/[0-9a-f-]{36}$/);
	await page.getByRole('button', { name: 'Buat tautan undangan' }).click();
	const link = await page.getByLabel('Tautan undangan').inputValue();
	expect(link).toMatch(INVITE_LINK);

	const guestContext = await browser.newContext({
		javaScriptEnabled: false,
		storageState: SIGNED_OUT,
		extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 1) }
	});
	const guest = await guestContext.newPage();
	await guest.goto(`/daftar?next=${encodeURIComponent(new URL(link).pathname)}`);
	await guest.getByLabel('Nama').fill('Tamu Tanpa JS');
	await guest
		.getByLabel('E-mail')
		.fill(`fn03-nojs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
	await guest.getByLabel('Kata sandi').fill(PASSWORD);
	await tickSignUpBoxes(guest);
	await guest.getByRole('button', { name: 'Daftar' }).click();
	await guest.waitForURL(link);
	await guest.getByRole('button', { name: 'Gabung ke ruang' }).click();
	await guest.waitForURL(`${APP_ORIGIN}/`);
	await guest.goto('/ruang');
	await expect(guest.getByRole('listitem').filter({ hasText: name })).toBeVisible();
	await owner.close();
	await guestContext.close();
});
