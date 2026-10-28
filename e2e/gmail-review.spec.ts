import { expect, test, type Page } from '@playwright/test';
import { d1 } from './d1';
import {
	collectCspViolations,
	expectNoHorizontalScroll,
	newUser,
	waitForHydration
} from './helpers';

/**
 * FN-19b "Transaksi dari Gmail" and the auto-save setting in a real browser. The e2e server has no Google client,
 * so a connection, one hourly scan and its captured drafts are seeded straight into the local D1 for a fresh user
 * (fictional ids, `*.example` sender domain, a placeholder sealed token nothing opens). Nothing reaches Google.
 */

const HEX = (n: number) => `18c0a1b2c3d4e5${String(n).padStart(2, '0')}`;

function seed(email: string, kind: 'hourly' | 'lookback' = 'hourly') {
	const out = JSON.parse(
		d1(
			`select u.id as uid, s.id as sid from users u join space_members m on m.user_id = u.id
				join spaces s on s.id = m.space_id where u.email = '${email}' and s.kind = 'personal'`
		)
	) as [{ results: { uid: string; sid: string }[] }];
	const { uid, sid } = out[0].results[0]!;
	const now = Date.now();
	const conn = `gc-${uid.slice(0, 8)}`;
	const scan = `gs-${uid.slice(0, 8)}`;
	const wallet = `w-${uid.slice(0, 8)}`;
	const rows = [0, 1].map((i) => ({
		mail: `gm-${uid.slice(0, 8)}-${i}`,
		draft: `gd-${uid.slice(0, 8)}-${i}`,
		gmail: HEX(i),
		amount: (28 + i) * 100_000,
		title: i === 0 ? 'Kedai Kopi Senja' : 'Toko Roti Pagi'
	}));
	d1(
		[
			`insert into gmail_connections (id, user_id, space_id, status, google_address, encrypted_token, token_nonce,
				token_key_id, scope, auto_check, checked_through, created_at, updated_at)
				values ('${conn}', '${uid}', '${sid}', 'connected', 'pemilik@gmail.example', 'placeholder',
				'0123456789abcdef', '01234567890', 'https://www.googleapis.com/auth/gmail.readonly', 1,
				${Math.floor(now / 1000)}, ${now}, ${now})`,
			`insert into gmail_scans (id, connection_id, user_id, kind, scan_window, days, after_s, status, pages,
				listed, read, drafted, created_at, updated_at)
				values ('${scan}', '${conn}', '${uid}', '${kind}', 'e2e-window', ${kind === 'lookback' ? 7 : 'null'}, 1, 'done', 1, 2, 2, 2, ${now}, ${now})`,
			`insert into wallets (id, space_id, name, type, currency, opening_balance_minor, is_favourite, created_at,
				updated_at, seq) values ('${wallet}', '${sid}', 'BCA Uji', 'bank', 'IDR', 0, 1, ${now}, ${now}, 1)`,
			...rows.flatMap((r) => [
				`insert into drafts (id, space_id, type, amount_minor, currency, title, note, occurred_on, occurred_at,
					source, dedupe_key, flag, is_demo, created_at, updated_at, seq)
					values ('${r.draft}', '${sid}', 'expense', ${r.amount}, 'IDR', '${r.title}', 'Pengirim belum terverifikasi',
					'2026-10-08', ${now}, 'gmail', 'mail:m:${r.draft}', 'needs_review', 0, ${now}, ${now}, 1)`,
				`insert into gmail_mail (id, connection_id, user_id, space_id, gmail_id, received_at, status, trust,
					parser, sender_domain, subject, draft_id, scan_id, updated_at)
					values ('${r.mail}', '${conn}', '${uid}', '${sid}', '${r.gmail}', ${now}, 'draft_created', 'unverified',
					'bank-qris', 'notifikasi.bank-qris.example', 'Transaksi QRIS Berhasil', '${r.draft}', '${scan}', ${now})`
			])
		].join('; ')
	);
	return { uid, sid, wallet };
}

async function open(page: Page) {
	await page.goto('/pengaturan/aplikasi/gmail/transaksi');
	await waitForHydration(page);
}

test('review: grouped per day and check, Gmail links, undo through the dialog with exact counts and focus back', async ({
	browser
}, testInfo) => {
	const { context, page, email } = await newUser(browser, testInfo, {
		prefix: 'fn19b',
		sapaanOff: true
	});
	const csp = collectCspViolations(page);
	seed(email);
	// From the Gmail settings page.
	await page.goto('/pengaturan/aplikasi/gmail');
	await waitForHydration(page);
	await page.getByRole('link', { name: 'Transaksi dari Gmail' }).click();
	await page.waitForURL(/\/pengaturan\/aplikasi\/gmail\/transaksi$/);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'Transaksi dari Gmail', level: 1 })).toBeVisible();
	await expect(
		page.getByRole('heading', { level: 3, name: /^Pemeriksaan otomatis/ })
	).toBeVisible();
	await expect(page.getByText('Kedai Kopi Senja')).toBeVisible();
	await expect(page.getByText('Toko Roti Pagi')).toBeVisible();
	await expect(page.getByText('Draf', { exact: true })).toHaveCount(2);
	await expect(page.getByText('−Rp 28.000', { exact: true })).toBeVisible();
	const links = page.getByRole('link', { name: 'Buka di Gmail' });
	await expect(links).toHaveCount(2);
	for (const i of [0, 1]) {
		await expect(links.nth(i)).toHaveAttribute('rel', 'noopener noreferrer');
		await expect(links.nth(i)).toHaveAttribute(
			'href',
			/^https:\/\/mail\.google\.com\/mail\/u\/pemilik%40gmail\.example\/#all\/18c0a1b2c3d4e50[01]$/
		);
	}
	await expectNoHorizontalScroll(page);

	const opener = page.getByText('Urungkan pemindaian', { exact: true });
	expect((await opener.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
	await opener.click();
	const confirm = page.getByRole('button', { name: 'Ya, urungkan' });
	await expect(confirm).toBeVisible();
	await confirm.click();
	const result = page.getByRole('status').filter({ hasText: '2 dibatalkan' });
	await expect(result).toBeVisible();
	// The scan is undone, so its opener is gone: focus lands on the result line, not the page body.
	await expect(result).toBeFocused();
	await expect(page.getByText('Dibatalkan', { exact: true })).toHaveCount(2);
	await expect(page.getByText('Sudah diurungkan')).toBeVisible();
	// Persisted: a reload shows the same, and Kotak masuk no longer holds the drafts.
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByText('Dibatalkan', { exact: true })).toHaveCount(2);
	await expect(page.getByText('Urungkan pemindaian', { exact: true })).toHaveCount(0);
	expect(csp).toEqual([]);
	await context.close();
});

test('review without JavaScript: the undo form posts and shows its result', async ({
	browser
}, testInfo) => {
	const { context, email } = await newUser(browser, testInfo, {
		prefix: 'fn19b-nojs',
		sapaanOff: true
	});
	seed(email);
	const state = await context.storageState();
	const nojs = await browser.newContext({ javaScriptEnabled: false, storageState: state });
	const page = await nojs.newPage();
	await page.goto('/pengaturan/aplikasi/gmail/transaksi');
	await page.getByText('Urungkan pemindaian', { exact: true }).click();
	await page.getByRole('button', { name: 'Ya, urungkan' }).click();
	await expect(page.getByText('2 dibatalkan')).toBeVisible();
	// A second undo of the same scan is not offered any more; the scan says so.
	await expect(page.getByText('Sudah diurungkan')).toBeVisible();
	await nojs.close();
	await context.close();
});

test('review empty and not connected states', async ({ browser }, testInfo) => {
	const { context, page } = await newUser(browser, testInfo, {
		prefix: 'fn19b-empty',
		sapaanOff: true
	});
	await open(page);
	await expect(page.getByRole('heading', { name: 'Belum terhubung' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Buka pengaturan Gmail' })).toBeVisible();
	await context.close();
});

test('auto-save: off by default, honest "belum ada" while no sender is confirmed, turning on persists', async ({
	browser
}, testInfo) => {
	const { context, page, email } = await newUser(browser, testInfo, {
		prefix: 'fn19b-auto',
		sapaanOff: true
	});
	seed(email);
	await page.goto('/pengaturan/aplikasi/gmail');
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'Simpan otomatis', level: 2 })).toBeVisible();
	await expect(page.getByText('Simpan otomatis: mati')).toBeVisible();
	await expect(
		page.getByText('Simpan otomatis aktif untuk pengirim yang sudah dikonfirmasi: belum ada')
	).toBeVisible();
	const turnOn = page.getByRole('button', { name: 'Nyalakan simpan otomatis' });
	await expect(turnOn).toBeDisabled();
	await page.getByLabel('Simpan ke dompet').selectOption({ label: 'BCA Uji' });
	await expect(turnOn).toBeEnabled();
	expect((await turnOn.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
	await turnOn.click();
	await expect(page.getByText('Simpan otomatis dinyalakan.')).toBeVisible();
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByText('Simpan otomatis: nyala')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Matikan simpan otomatis' })).toBeVisible();
	// The notification toggle is the /pengaturan/notifikasi preference.
	await page.getByRole('button', { name: 'Matikan pemberitahuan' }).click();
	await expect(page.getByText('Pemberitahuan pembayaran dari Gmail dimatikan.')).toBeVisible();
	await page.goto('/pengaturan/notifikasi');
	await expect(page.getByText('Pembayaran dari Gmail')).toBeVisible();
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('look-back: "Simpan semua yang lengkap" with a wallet and a category saves the fresh drafts', async ({
	browser
}, testInfo) => {
	const { context, page, email } = await newUser(browser, testInfo, {
		prefix: 'fn19b-save',
		sapaanOff: true
	});
	seed(email, 'lookback');
	await open(page);
	await expect(
		page.getByRole('heading', { level: 3, name: 'Lihat ke belakang 7 hari' })
	).toBeVisible();
	await page.getByLabel('Dompet untuk yang belum punya').selectOption({ label: 'BCA Uji' });
	const category = page.getByLabel('Kategori untuk pengeluaran yang belum punya');
	const firstCategory = await category.locator('option').nth(1).textContent();
	await category.selectOption({ label: firstCategory!.trim() });
	const save = page.getByRole('button', { name: 'Simpan semua yang lengkap' });
	expect((await save.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: '2 tersimpan' })).toBeVisible();
	await expect(page.getByText('Tersimpan', { exact: true })).toHaveCount(2);
	// Persisted: the saved rows are transactions in Riwayat, tagged "Dari Gmail".
	await page.goto('/riwayat');
	await waitForHydration(page);
	await expect(page.getByText('Kedai Kopi Senja')).toBeVisible();
	await expect(page.getByText('Dari Gmail').first()).toBeVisible();
	// QA F3: the edit page carries the same tag.
	await page.getByText('Kedai Kopi Senja').first().click();
	await expect(page).toHaveURL(/\/riwayat\/[^/]+\/edit/);
	await expect(page.getByText('Dari Gmail')).toBeVisible();
	await expectNoHorizontalScroll(page);
	await context.close();
});
