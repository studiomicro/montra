import { expect, test } from '@playwright/test';
import {
	collectCspViolations,
	APP_ORIGIN,
	expectNoHorizontalScroll,
	waitForHydration
} from './helpers';
import { d1 } from './d1';

/**
 * FN-19 Gmail, configured states in a real browser (QA cycle 1). Skipped in the default run: it needs the server of
 * playwright.gmail-configured.config.ts (a fictional Google client, so the page is configured). Nothing here reaches
 * Google: the Google URL is only read, and the browser request to it is stubbed.
 */
test.skip(!process.env.QA_GMAIL_CONFIGURED, 'needs playwright.gmail-configured.config.ts');

test.describe.configure({ mode: 'serial' });

test('configured, not connected: explanation, then "Lanjut ke Google" as a plain link (no 3xx, no CSP violation)', async ({
	page
}) => {
	const csp = collectCspViolations(page);
	await page.goto('/pengaturan/aplikasi/gmail');
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'Sebelum menghubungkan' })).toBeVisible();
	await expect(page.locator('section.notice')).toHaveCount(0);
	await expect(page.getByText('akses berakhir setiap 7 hari')).toBeVisible();
	await expectNoHorizontalScroll(page);
	const connect = page.getByRole('button', { name: 'Hubungkan', exact: true });
	expect((await connect.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

	// With JavaScript the page follows the link at once; stub Google so the browser goes nowhere real.
	await page.route('https://accounts.google.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' })
	);
	const post = page.waitForResponse(
		(r) => r.url().includes('/pengaturan/aplikasi/gmail') && r.request().method() === 'POST'
	);
	await connect.click();
	expect((await post).status()).toBeLessThan(300);
	await page.waitForURL(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
	const url = new URL(page.url());
	expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	expect(url.searchParams.get('redirect_uri')).toBe(
		`${APP_ORIGIN}/pengaturan/aplikasi/gmail/callback`
	);
	expect(url.searchParams.get('code_verifier')).toBeNull();
	expect(csp).toEqual([]);
});

test('without JavaScript the POST answers 200 page data with a working "Lanjut ke Google" link', async ({
	browser
}, testInfo) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: testInfo.project.use.storageState
	});
	const page = await context.newPage();
	await page.goto('/pengaturan/aplikasi/gmail');
	const post = page.waitForResponse((r) => r.request().method() === 'POST');
	await page.getByRole('button', { name: 'Hubungkan', exact: true }).click();
	const response = await post;
	expect(response.status()).toBe(200);
	const link = page.getByRole('link', { name: 'Lanjut ke Google' });
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute(
		'href',
		/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/
	);
	await context.close();
});

test('connected: settings, toggle and target persist across reload; 360 px; no horizontal scroll', async ({
	page
}) => {
	const csp = collectCspViolations(page);
	// Seed one connection for the signed-up user (a placeholder sealed token; nothing opens it in this test).
	const user = JSON.parse(
		d1(
			'select u.id as uid, s.id as sid from users u join space_members m on m.user_id = u.id join spaces s on s.id = m.space_id order by u.created_at desc limit 1'
		)
	) as [{ results: { uid: string; sid: string }[] }];
	const row = user[0].results[0];
	expect(row).toBeTruthy();
	const now = Date.now();
	d1(
		`insert into gmail_connections (id, user_id, space_id, status, google_address, encrypted_token, token_nonce, token_key_id, scope, auto_check, checked_through, created_at, updated_at) values ('qa-conn-1', '${row!.uid}', '${row!.sid}', 'connected', 'qa.user@example.test', 'placeholder', '0123456789abcdef', '01234567890', 'https://www.googleapis.com/auth/gmail.readonly', 1, ${Math.floor(now / 1000)}, ${now}, ${now})`
	);
	await page.goto('/pengaturan/aplikasi/gmail');
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'Terhubung', level: 2 })).toBeVisible();
	await expect(page.getByText('qa.user@example.test')).toBeVisible();
	await expect(page.getByText('Belum pernah diperiksa')).toBeVisible();
	await expect(page.getByText('Masa uji Google')).toBeVisible();
	await expectNoHorizontalScroll(page);
	// Gratis: only 7 days is enabled, the rest says "Tersedia di paket Pro".
	const days = page.locator('select[name="days"] option');
	await expect(days).toHaveCount(5);
	await expect(days.nth(0)).not.toHaveAttribute('disabled', /.*/);
	for (const i of [1, 2, 3, 4]) {
		await expect(days.nth(i)).toHaveAttribute('disabled', '');
		await expect(days.nth(i)).toContainText('Tersedia di paket Pro');
	}
	for (const name of [
		'Simpan ruang tujuan',
		'Matikan periksa otomatis',
		'Periksa sekarang',
		'Pindai sekarang'
	]) {
		const box = await page.getByRole('button', { name }).boundingBox();
		expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
	}
	// Toggle off: success only after the server confirmed, and it survives a reload.
	await page.getByRole('button', { name: 'Matikan periksa otomatis' }).click();
	await expect(page.getByText('Periksa otomatis dimatikan.')).toBeVisible();
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByText('Periksa otomatis: mati')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Nyalakan periksa otomatis' })).toBeVisible();
	// The Aplikasi row shows the connected state.
	await page.goto('/pengaturan/aplikasi');
	await expect(page.getByRole('listitem').filter({ hasText: 'Gmail' })).toContainText('Terhubung');
	// The disconnect confirmation opens (it is not submitted: that would call Google).
	await page.goto('/pengaturan/aplikasi/gmail');
	await waitForHydration(page);
	await page.getByText('Putuskan Gmail', { exact: true }).last().click();
	await expect(page.getByRole('button', { name: 'Ya, putuskan' })).toBeVisible();
	expect(csp).toEqual([]);
});

test('connected, no JavaScript: the toggle form posts and shows its result', async ({
	browser
}, testInfo) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: testInfo.project.use.storageState
	});
	const page = await context.newPage();
	await page.goto('/pengaturan/aplikasi/gmail');
	await page.getByRole('button', { name: 'Nyalakan periksa otomatis' }).click();
	await expect(page.getByText('Periksa otomatis dinyalakan.')).toBeVisible();
	await context.close();
});
