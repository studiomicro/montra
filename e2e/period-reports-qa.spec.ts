import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, simulatedClientIp, waitForHydration } from './helpers';
import { d1, spaceIdOf } from './d1';
import { addWallet, freshUser } from './ledger';

/**
 * FN-53 QA: /kekayaan/laporan with real snapshot rows (the engineer's e2e only saw the empty state). Snapshots are
 * written into the e2e server's local D1 with wrangler (never a remote); the page reads them like any snapshot.
 */
const SHOTS = process.env.QA_SHOTS ?? 'test-results/qa-shots';

async function seedSnapshots(email: string) {
	const space = spaceIdOf(email);
	const row = (date: string, total: number, partial: number, classes: object | null) =>
		`('${space}','${date}',${total},'IDR',${partial},1,1,null,1,${classes ? `'${JSON.stringify(classes)}'` : 'null'})`;
	const M = 1_000_000_00;
	d1(
		`insert into net_worth_snapshots(space_id,date,total_minor,currency,partial,created_at,updated_at,deleted_at,seq,classes) values ${[
			row('2026-06-28', 100 * M, 0, { wallets: 80 * M, gold: 30 * M, debt: -10 * M }),
			row('2026-08-31', 112 * M, 0, { wallets: 82 * M, gold: 50 * M, debt: -20 * M }),
			row('2026-09-28', 125 * M, 0, { wallets: 85 * M, gold: 60 * M, debt: -20 * M }),
			row('2026-09-30', 126 * M, 1, null)
		].join(',')}`
	);
}

for (const scheme of ['light', 'dark'] as const) {
	test(`snapshots: Q3 report with a gap, a partial month and group changes (${scheme})`, async ({
		browser
	}, testInfo) => {
		const signedUp = await freshUser(browser, testInfo, 'nwqa');
		await addWallet(signedUp.page, 'BCA', '100.000');
		await seedSnapshots(signedUp.email);
		const storageState = await signedUp.context.storageState();
		await signedUp.context.close();
		const phone = testInfo.project.name === 'phone';
		const context = await browser.newContext({
			storageState,
			colorScheme: scheme,
			viewport: phone ? { width: 360, height: 780 } : { width: 1280, height: 900 },
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 3) }
		});
		const page = await context.newPage();
		const tag = `${phone ? '360' : '1280'}-${scheme}`;

		await page.goto('/kekayaan/laporan?k=2026-Q3');
		await waitForHydration(page);
		const body = page.locator('main');
		// opening: 28 Jun is 2 days before the day-before-start (30 Jun): earlier, date printed.
		await expect(body).toContainText('28 Jun');
		await expect(body).toContainText('catatan terakhir sebelum periode ini');
		// closing: the complete 28 Sep snapshot, never the partial 30 Sep one; change +25M.
		await expect(page.getByText('Naik')).toBeVisible();
		// Cycle 2: the change shows once, on the hero ("+Rp" then the figure, no text space between them).
		await expect(body).toContainText(/\+Rp\s?25\.000\.000/);
		await expect(body).toContainText('28 Sep');
		// groups: gold +30M, wallets +5M, debt grew: "Utang bertambah".
		await expect(body).toContainText('Utang bertambah');
		await expect(body).toContainText(/Rp\s10\.000\.000/);
		const rows = await page
			.locator('section[aria-labelledby="nw-report-groups"] li')
			.allInnerTexts();
		expect(rows.length).toBe(3);
		expect(rows[0]).toContain('Emas');
		// trend: July is a gap, Sep is partial (hollow).
		const slider = page.getByRole('slider', { name: /Kekayaan bersih per bulan/ });
		await slider.focus();
		await page.keyboard.press('Home').catch(() => {});
		const pill = page.locator('figcaption.pill');
		// selected starts at the last slot (Sep, partial): the note shows.
		await expect(pill).toContainText('Sep');
		await expect(pill).toContainText('Sebagian harga belum tersedia hari itu');
		expect(await page.locator('circle.dot[data-partial="1"]').count()).toBe(1);
		await page.keyboard.press('ArrowLeft'); // Agu
		await expect(pill).toContainText('Agu');
		await page.keyboard.press('ArrowLeft'); // Jul: gap
		await expect(pill).toContainText('Jul');
		await expect(pill).toContainText('Belum ada catatan');
		const polylines = await page.locator('svg polyline.line').count();
		const dots = await page.locator('svg circle.dot').count();
		expect(dots).toBe(3); // awal, Aug, Sep (Jul gap)
		expect(polylines).toBe(1); // awal alone then gap: awal is a single dot run; Aug..Sep one line
		await expectNoHorizontalScroll(page);
		if (tag === '360-light' || tag === '1280-dark')
			await page.screenshot({ path: `${SHOTS}/nw-q3-${tag}.png`, fullPage: true });

		// Q4 (current): opening is the 28 Sep complete snapshot ("earlier"), closing is the live wallet total.
		await page.goto('/kekayaan/laporan');
		await waitForHydration(page);
		await expect(body).toContainText('sekarang');
		await expect(body).toContainText('Utang berkurang');
		await expect(body).toContainText('28 Sep');
		await expectNoHorizontalScroll(page);
		if (tag === '360-dark')
			await page.screenshot({ path: `${SHOTS}/nw-q4-${tag}.png`, fullPage: true });

		// Hidden through the eye (cookie and stored choice): server HTML carries no figure; line and dots absent.
		await page.goto('/kekayaan/laporan?k=2026-Q3');
		await waitForHydration(page);
		await page.getByRole('button', { name: 'Sembunyikan nominal' }).click();
		await expect(page.getByRole('button', { name: 'Sembunyikan nominal' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		const html = await (await page.request.get('/kekayaan/laporan?k=2026-Q3')).text();
		expect(html).not.toMatch(/25\.000\.000|100\.000\.000|125\.000\.000|10\.000\.000/);
		expect(html).toContain('••••');
		await page.reload();
		await waitForHydration(page);
		expect(await page.locator('svg polyline.line').count()).toBe(0);
		expect(await page.locator('svg circle.dot').count()).toBe(0);
		await expect(body).not.toContainText(/25\.000\.000/);
		await expect(pill).not.toContainText(/\d\.\d{3}/);
		// Cycle 2: hidden mode says nothing about direction after hydration either (words, sign, glyph, colour).
		const text = await body.innerText();
		expect(text).not.toMatch(/Naik|Turun|Tetap|Utang berkurang|Utang bertambah|[\u2212+]Rp|[↑↓]/);
		expect(await page.locator('.hero.up, .hero.down, .amount.up, .amount.down').count()).toBe(0);
		await expect(page.getByText('Perubahan kekayaan bersih')).toBeVisible();
		if (tag === '1280-dark')
			await page.screenshot({ path: `${SHOTS}/nw-hidden-${tag}.png`, fullPage: true });

		// Year 2026 so far: since the first complete snapshot (28 Jun), gaps Jan–May.
		await page.goto('/kekayaan/laporan?y=2026');
		await page.getByRole('button', { name: 'Sembunyikan nominal' }).click();
		await waitForHydration(page);
		await expect(body).toContainText('Dihitung sejak 28 Jun');
		await expectNoHorizontalScroll(page);
		if (tag === '1280-light')
			await page.screenshot({ path: `${SHOTS}/nw-year-${tag}.png`, fullPage: true });
		await context.close();
	});
}
