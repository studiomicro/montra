import { expect, test } from '@playwright/test';
import {
	collectCspViolations,
	expectNoHorizontalScroll,
	PASSWORD,
	waitForHydration
} from './helpers';
import {} from './ledger';

/** The shared e2e user's password (e2e/auth.setup.ts). */

/**
 * FN-38 public API: create a token in Pengaturan → API (shown once), call the API with it, see a session
 * cookie refused there, revoke it and see it refused. The phone and desktop projects share one signed-up user
 * and run in parallel, so each works only on its own token (named after the project).
 */
test('token shown once, works as Bearer only, and stops working once revoked', async ({
	page
}, testInfo) => {
	const csp = collectCspViolations(page);
	const name = `E2E ${testInfo.project.name} ${Date.now()}`;
	await page.goto('/pengaturan');
	await waitForHydration(page);
	await page.locator('main').getByRole('link', { name: 'API' }).click();
	await page.waitForURL(/\/pengaturan\/api$/);
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'API', level: 1 })).toBeVisible();
	await expectNoHorizontalScroll(page);

	await page.getByRole('textbox', { name: 'Nama' }).fill(name);
	await page.getByLabel('Kata sandi saat ini').fill(PASSWORD);
	await page.getByRole('combobox', { name: 'Izin' }).selectOption('read');
	await page.getByRole('button', { name: 'Buat token' }).click();
	const secret = page.getByLabel('Token', { exact: true });
	await expect(secret).toBeVisible();
	const token = await secret.inputValue();
	expect(token).toMatch(/^fin_[A-Za-z0-9_-]{43}$/);
	await expect(page.getByText(/hanya ditampilkan sekali/)).toBeVisible();
	const row = page.getByRole('listitem').filter({ hasText: name });
	await expect(row).toContainText(`…${token.slice(-4)}`);
	await expect(row).toContainText('Belum pernah dipakai');
	await expectNoHorizontalScroll(page);
	await page.screenshot({ path: testInfo.outputPath('api-created-light.png'), fullPage: true });

	// The browser's own request carries the session cookie and no token: refused like no credential at all.
	const cookieOnly = await page.request.get('/api/v1/spaces');
	expect(cookieOnly.status()).toBe(401);
	const bearer = await page.request.get('/api/v1/spaces', {
		headers: { authorization: `Bearer ${token}` }
	});
	expect(bearer.status()).toBe(200);
	const spaces = (await bearer.json()).data as { id: string; kind: string }[];
	expect(spaces.some((s) => s.kind === 'personal')).toBe(true);
	const write = await page.request.post(`/api/v1/transactions?space_id=${spaces[0]!.id}`, {
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		data: {}
	});
	expect(write.status()).toBe(403);

	// Reload: the raw token is gone from the page; the list shows its last four and that it was used.
	await page.reload();
	await waitForHydration(page);
	expect(await page.content()).not.toContain(token);
	await expect(row).toContainText('Terakhir dipakai');

	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoHorizontalScroll(page);
	await page.screenshot({ path: testInfo.outputPath('api-list-dark.png'), fullPage: true });
	await page.emulateMedia({ colorScheme: 'light' });

	await row.getByText('Cabut', { exact: true }).click();
	await row.getByRole('button', { name: 'Ya, cabut' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Token dicabut' })).toBeVisible();
	await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
	const after = await page.request.get('/api/v1/spaces', {
		headers: { authorization: `Bearer ${token}` }
	});
	expect(after.status()).toBe(401);
	expect(csp).toEqual([]);
});

test('the docs page renders the reference without a third-party bundle; openapi.json is public', async ({
	page,
	playwright
}, testInfo) => {
	const csp = collectCspViolations(page);
	const scripts: string[] = [];
	page.on('request', (r) => {
		if (r.resourceType() === 'script') scripts.push(new URL(r.url()).origin);
	});
	await page.goto('/pengaturan/api/dokumentasi');
	await waitForHydration(page);
	await expect(page.getByRole('heading', { name: 'Dokumentasi API', level: 1 })).toBeVisible();
	await expect(page.getByRole('heading', { name: /POST\s*\/api\/v1\/transactions/ })).toBeVisible();
	await expectNoHorizontalScroll(page);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoHorizontalScroll(page);
	await page.screenshot({ path: testInfo.outputPath('api-docs-dark.png') });
	expect(new Set(scripts)).toEqual(new Set([new URL(page.url()).origin]));
	expect(csp).toEqual([]);

	const anonymous = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
	const spec = await anonymous.get('/api/v1/openapi.json');
	expect(spec.status()).toBe(200);
	const doc = await spec.json();
	expect(doc.openapi).toBe('3.1.0');
	expect(Object.keys(doc.paths)).toContain('/api/v1/transactions/{id}');
	await anonymous.dispose();
});

test('without JavaScript: create shows the token once, reload hides it, revoke works', async ({
	browser
}, testInfo) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: testInfo.project.use.storageState,
		viewport: testInfo.project.use.viewport
	});
	const page = await context.newPage();
	const name = `NoJS ${testInfo.project.name} ${Date.now()}`;
	await page.goto('/pengaturan/api');
	await page.getByRole('textbox', { name: 'Nama' }).fill(name);
	await page.getByLabel('Kata sandi saat ini').fill(PASSWORD);
	await page.getByRole('button', { name: 'Buat token' }).click();
	const token = await page.getByLabel('Token', { exact: true }).inputValue();
	expect(token).toMatch(/^fin_[A-Za-z0-9_-]{43}$/);
	await expect(page.getByText(/hanya ditampilkan sekali/)).toBeVisible();
	const ok = await page.request.get('/api/v1/spaces', {
		headers: { authorization: `Bearer ${token}` }
	});
	expect(ok.status()).toBe(200);

	await page.goto('/pengaturan/api');
	expect(await page.content()).not.toContain(token);
	const row = page.getByRole('listitem').filter({ hasText: name });
	await expect(row).toContainText(`…${token.slice(-4)}`);
	await row.getByText('Cabut', { exact: true }).click();
	await row.getByRole('button', { name: 'Ya, cabut' }).click();
	await expect(
		page.getByText('Token dicabut. Permintaan dengan token itu langsung ditolak.')
	).toBeVisible();
	await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
	const after = await page.request.get('/api/v1/spaces', {
		headers: { authorization: `Bearer ${token}` }
	});
	expect(after.status()).toBe(401);
	await expectNoHorizontalScroll(page);
	await context.close();
});

test('over real HTTP like an external script: POST, PATCH and a bodyless DELETE with only Authorization', async ({
	page,
	playwright
}, testInfo) => {
	await page.goto('/pengaturan/api');
	await waitForHydration(page);
	await page
		.getByRole('textbox', { name: 'Nama' })
		.fill(`HTTP ${testInfo.project.name} ${Date.now()}`);
	await page.getByLabel('Kata sandi saat ini').fill(PASSWORD);
	await page.getByRole('combobox', { name: 'Izin' }).selectOption('read_write');
	await page.getByRole('button', { name: 'Buat token' }).click();
	const token = await page.getByLabel('Token', { exact: true }).inputValue();

	// A separate client: no cookies, no Origin, no browser — exactly what a script sends.
	const script = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
	const auth = { authorization: `Bearer ${token}` };
	const spaceId = (
		(await (await script.get('/api/v1/spaces', { headers: auth })).json()).data as {
			id: string;
			kind: string;
		}[]
	).find((s) => s.kind === 'personal')!.id;
	const q = `space_id=${spaceId}`;
	// A wallet through the app's own form action (same origin, so it passes the cross-site check).
	const origin = new URL(page.url()).origin;
	const made = await page.request.post('/dompet?/createWallet', {
		headers: { origin },
		form: {
			name: `Skrip ${testInfo.project.name}`,
			type: 'bank',
			currency: 'IDR',
			openingBalance: ''
		}
	});
	expect(made.status()).toBe(200);
	const wallets = await script.get(`/api/v1/wallets?${q}`, { headers: auth });
	const walletId = ((await wallets.json()).data as { id: string; name: string }[]).find(
		(w) => w.name === `Skrip ${testInfo.project.name}`
	)!.id;
	const categories = (await (await script.get(`/api/v1/categories?${q}`, { headers: auth })).json())
		.data as { id: string; kind: string; is_hidden: boolean }[];
	const category = categories.find((c) => c.kind === 'expense' && !c.is_hidden)!.id;
	const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

	const created = await script.post(`/api/v1/transactions?${q}`, {
		headers: { ...auth, 'content-type': 'application/json' },
		data: {
			client_id: crypto.randomUUID(),
			type: 'expense',
			amount_minor: 1_250_000,
			wallet_id: walletId,
			category_id: category,
			title: 'Dari skrip',
			occurred_on: today
		}
	});
	expect(created.status()).toBe(201);
	const row = (await created.json()).data as { id: string; updated_at: number };

	const patched = await script.patch(`/api/v1/transactions/${row.id}?${q}`, {
		headers: { ...auth, 'content-type': 'application/json' },
		data: { expected_updated_at: row.updated_at, title: 'Diubah skrip' }
	});
	expect(patched.status()).toBe(200);
	const after = (await patched.json()).data as { updated_at: number; title: string };
	expect(after.title).toBe('Diubah skrip');

	// The QA blocker: DELETE with no body, no Content-Type and no Origin reaches the handler.
	const stale = await script.delete(
		`/api/v1/transactions/${row.id}?${q}&expected_updated_at=${row.updated_at}`,
		{ headers: auth }
	);
	expect(stale.status()).toBe(409);
	expect(stale.headers()['content-type']).toContain('application/json');
	expect((await stale.json()).error.code).toBe('stale');
	const removed = await script.delete(
		`/api/v1/transactions/${row.id}?${q}&expected_updated_at=${after.updated_at}`,
		{ headers: auth }
	);
	expect(removed.status()).toBe(200);
	expect(await removed.json()).toEqual({ data: { id: row.id, deleted: true } });
	// Every refusal on these routes is the fixed JSON shape, also without a token.
	const anonymous = await script.delete(
		`/api/v1/transactions/${row.id}?${q}&expected_updated_at=1`
	);
	expect(anonymous.status()).toBe(401);
	expect((await anonymous.json()).error.code).toBe('unauthorized');
	await script.dispose();
});

test('app form actions stay protected: a cross-site form POST with the session cookie is refused', async ({
	page
}) => {
	await page.goto('/pengaturan/api');
	const crossSite = await page.request.post('/pengaturan/api?/create', {
		headers: { origin: 'https://evil.example' },
		form: { name: 'CSRF', scope: 'read_write', space: '', lifetime: '90', password: PASSWORD }
	});
	expect(crossSite.status()).toBe(403);
	expect(await crossSite.text()).toBe('Cross-site POST form submissions are forbidden');
	const noOrigin = await page.request.post('/pengaturan/api?/revoke', {
		form: { tokenId: 'x' }
	});
	expect(noOrigin.status()).toBe(403);
	await page.reload();
	await expect(page.getByRole('listitem').filter({ hasText: 'CSRF' })).toHaveCount(0);
});
