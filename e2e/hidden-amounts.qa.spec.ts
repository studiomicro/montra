import { expect, test } from '@playwright/test';
import { addWallet, freshUser, ids, postExpense } from './ledger';

/**
 * QA fix-lows-services cycle 2 (N5): with the eye's cookie, the server's HTML of every hero page carries no
 * figure, wherever the figure sits relative to the hero.
 */
test('server HTML of Beranda, Dompet, Laporan, Anggaran and Kekayaan is masked with the cookie', async ({
	browser
}, testInfo) => {
	const { context, page } = await freshUser(browser, testInfo, 'lowsqa');
	await addWallet(page, 'BCA');
	const { wallet, category } = await ids(page);
	await postExpense(page, {
		walletId: await wallet('BCA'),
		categoryId: await category('Kopi'),
		amount: '25.000',
		title: 'Kopi susu'
	});
	const paths = ['/', '/dompet', '/laporan', '/anggaran', '/kekayaan'];
	const figure = (html: string) => html.includes('25.000') || html.includes('75.000');
	const shown: Record<string, boolean> = {};
	for (const p of paths) shown[p] = figure(await (await page.request.get(p)).text());
	// The figure is in at least Beranda and Dompet when shown (guards against a vacuous pass).
	expect(shown, JSON.stringify(shown)).toMatchObject({ '/': true, '/dompet': true });
	const { origin } = new URL(page.url());
	await context.addCookies([{ name: 'montra-amounts-hidden', value: '1', url: origin }]);
	for (const p of paths) {
		const html = await (await page.request.get(p)).text();
		expect(figure(html), p).toBe(false);
		if (shown[p]) expect(html, p).toContain('••••');
	}
	// Other pages are not touched by the cookie: Riwayat still prints the amount.
	expect(await (await page.request.get('/riwayat')).text()).toContain('25.000');
	await context.close();
});
