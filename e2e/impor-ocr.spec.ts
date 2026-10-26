import { expect, test, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	expectNoHorizontalScroll,
	newUser,
	STORAGE_STATE,
	waitForHydration
} from './helpers';
import { addWallet } from './ledger';

/**
 * FN-16g on-device OCR (PRD criteria 6, 8, 10, 14, 15, 38 and the PDF path). Chromium, phone project only, serial.
 * Every image is a fictional screenshot drawn in the page on a canvas; the PDF is built here around such a
 * drawing. No binary fixture is committed and nothing contains real data. The engine really runs (Tesseract in a
 * Web Worker) under the shipped CSP; no network other than this app's origin is used.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(({ browserName }, testInfo) =>
	test.skip(
		browserName !== 'chromium' || testInfo.project.name !== 'phone',
		'Chromium phone project only'
	)
);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
/** Three days before today (WIB), as the screen prints it and as Riwayat filters it. */
const DAY = new Date(Date.now() + 7 * 3600_000 - 3 * 86_400_000);
const DAY_ISO = DAY.toISOString().slice(0, 10);
const DAY_PRINTED = `${DAY.getUTCDate()} ${MONTHS[DAY.getUTCMonth()]} ${DAY.getUTCFullYear()}`;
const LONG_TITLE = 'Langganan Toko Contoh Fiktif Nomor Dua Puluh Satu Bulanan Ok';

const SCREEN = [
	'09:41',
	'GoPay',
	'Riwayat transaksi',
	DAY_PRINTED,
	['Kopi Senja Fiktif', '-Rp25.000'],
	'14:30',
	[LONG_TITLE, '-Rp15.000'],
	'15:00',
	['Top Up Fiktif', 'Rp100.000'],
	'16:00'
] as const;

/** Draws the fictional screenshot on a canvas in the page and returns it as PNG or JPEG bytes. */
async function drawScreen(
	page: Page,
	type: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<Buffer> {
	const dataUrl = await page.evaluate(
		({ lines, type }) => {
			const canvas = document.createElement('canvas');
			canvas.width = 1600;
			canvas.height = 1000;
			const g = canvas.getContext('2d')!;
			g.fillStyle = '#fff';
			g.fillRect(0, 0, canvas.width, canvas.height);
			g.fillStyle = '#000';
			g.font = '36px sans-serif';
			lines.forEach((line, i) => {
				const y = 70 + i * 90;
				if (typeof line === 'string') g.fillText(line, 40, y);
				else {
					g.fillText(line[0], 40, y);
					g.textAlign = 'right';
					g.fillText(line[1], 1560, y);
					g.textAlign = 'left';
				}
			});
			const url = canvas.toDataURL(type, 0.92);
			canvas.width = 0;
			return url;
		},
		{ lines: SCREEN as unknown as (string | [string, string])[], type }
	);
	return Buffer.from(dataUrl.split(',')[1]!, 'base64');
}

/** A minimal image-only PDF: `pages` pages each drawing the same JPEG (no text layer at all). */
function imagePdf(jpeg: Buffer, width: number, height: number, pages: number): Buffer {
	const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
	const offsets: number[] = [];
	let length = chunks[0]!.length;
	const add = (body: Buffer | string) => {
		offsets.push(length);
		const b = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
		chunks.push(b);
		length += b.length;
	};
	const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
	add(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
	add(
		`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>\nendobj\n`
	);
	add(
		Buffer.concat([
			Buffer.from(
				`3 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
				'latin1'
			),
			jpeg,
			Buffer.from('\nendstream\nendobj\n', 'latin1')
		])
	);
	const w = width / 2;
	const h = height / 2;
	const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
	for (const id of pageIds) {
		add(
			`${id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 3 0 R >> >> /Contents ${id + 1} 0 R >>\nendobj\n`
		);
		add(
			`${id + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
		);
	}
	const xref = length;
	const count = offsets.length + 1;
	chunks.push(
		Buffer.from(
			`xref\n0 ${count}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
			'latin1'
		)
	);
	return Buffer.concat(chunks);
}

/** CSP violations reported by the page or any of its workers, and every request leaving the page. */
function watch(page: Page) {
	const violations = collectCspViolations(page);
	const requests: string[] = [];
	page.on('request', (r) => requests.push(r.url()));
	return { violations, requests };
}

const ocrBlock = (page: Page) => page.locator('#baca-foto');
/** The "Impor mutasi" card shows one source at a time: pick "Foto" (a radio, so it works without JavaScript too). */
const showOcr = (page: Page) =>
	page
		.getByRole('radiogroup', { name: 'Jenis berkas' })
		.getByRole('radio', { name: 'Foto' })
		.check();
/** Text shown in the block (the live region repeats announcements first, visually hidden). */
const shown = (page: Page, text: string | RegExp) => ocrBlock(page).getByText(text).last();

test('engine loads only after a pick, from this origin only, under the OCR asset policy (criteria 6, 8, 9)', async ({
	page,
	request
}) => {
	await page.addInitScript(() => {
		(window as unknown as { __csp: string[] }).__csp = [];
		document.addEventListener('securitypolicyviolation', (e) =>
			(window as unknown as { __csp: string[] }).__csp.push(
				`${e.violatedDirective} ${e.blockedURI} ${e.disposition} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`
			)
		);
	});
	const seen = watch(page);
	const scripts: string[] = [];
	page.on('response', async (r) => {
		if (r.request().resourceType() === 'script' && r.url().startsWith(APP_ORIGIN))
			scripts.push(await r.text().catch(() => ''));
	});
	for (const path of ['/', '/dompet', '/impor']) {
		await page.goto(`${APP_ORIGIN}${path}`);
		await waitForHydration(page);
	}
	await showOcr(page);
	expect(seen.requests.filter((u) => u.includes('/_ocr/'))).toEqual([]);
	expect(scripts.length).toBeGreaterThan(0);
	for (const body of scripts) expect(body).not.toMatch(/TesseractCore|pdfjsVersion|PDFPageProxy/);

	// The page policy: worker-src self, no wasm-unsafe-eval, no blob:.
	const pageCsp =
		(await request.get(`${APP_ORIGIN}/impor`)).headers()['content-security-policy'] ?? '';
	expect(pageCsp).toContain("worker-src 'self'");
	expect(pageCsp).not.toMatch(/wasm-unsafe-eval|blob:/);

	// Only what happens from the pick on is FN-16g's: the app shell already reports one caught `eval` probe on
	// load (zod's JIT check, `Function('')` in a try/catch; pre-existing, not from the OCR code).
	await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp.splice(0));
	await ocrBlock(page)
		.getByTestId('ocr-gallery')
		.setInputFiles({ name: 'layar.png', mimeType: 'image/png', buffer: await drawScreen(page) });
	await expect(ocrBlock(page).getByRole('heading', { name: 'Siap dimasukkan' })).toBeVisible({
		timeout: 90_000
	});

	const ocr = seen.requests.filter((u) => u.includes('/_ocr/'));
	expect(ocr.length).toBeGreaterThan(3);
	expect(seen.requests.every((u) => u.startsWith(APP_ORIGIN) || u.startsWith('data:'))).toBe(true);
	expect(page.workers().every((w) => !w.url().startsWith('blob:'))).toBe(true);
	expect(seen.violations).toEqual([]);
	expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);

	// The engine files carry the OCR asset policy, nosniff and an immutable cache.
	const assets = ocr.filter((u) => /worker\.min\.js$|traineddata$/.test(u));
	expect(assets.length).toBeGreaterThanOrEqual(2);
	for (const url of assets) {
		const headers = (await request.get(url)).headers();
		expect(headers['content-security-policy']).toBe(
			"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; base-uri 'none'"
		);
		expect(headers['x-content-type-options']).toBe('nosniff');
		expect(headers['cache-control']).toContain('immutable');
	}
});

test('cancel, then a full journey: read → review → tick → import → Riwayat → undo (criteria 10, 14, 38)', async ({
	browser
}, testInfo) => {
	// Its own user: an undone import is still remembered ("Sudah pernah diimpor"), so a second run of the same
	// journey (a retry, --repeat-each) on the shared user would never reach "Diimpor 3".
	const { context, page } = await newUser(browser, testInfo, {
		prefix: 'fn16g',
		sapaanOff: true,
		viewport: { width: 360, height: 780 },
		hasTouch: true,
		isMobile: true
	});
	await addWallet(page, 'GoPay Fiktif');
	await page.goto(`${APP_ORIGIN}/impor`);
	await waitForHydration(page);
	await showOcr(page);
	const block = ocrBlock(page);
	const posts: string[] = [];
	page.on('request', (r) => {
		if (r.method() === 'POST' && r.url().includes('Ocr')) posts.push(r.url());
	});

	// 360 px: both capture actions visible, stacked, at least 44 px high, no horizontal scroll.
	const camera = block.getByRole('button', { name: 'Ambil foto' });
	const gallery = block.getByRole('button', { name: 'Pilih dari galeri/berkas' });
	const [a, b] = [await camera.boundingBox(), await gallery.boundingBox()];
	expect(a && b && a.height >= 44 && b.height >= 44 && b.y > a.y && Math.abs(a.x - b.x) < 2).toBe(
		true
	);
	await gallery.focus();
	await expect(gallery).toBeFocused();
	await expectNoHorizontalScroll(page);

	// Batal while downloading (the network is slowed to 1 MB/s here): nothing is posted, no worker is left.
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.enable');
	const throttle = (bytesPerSecond: number) =>
		cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 0,
			downloadThroughput: bytesPerSecond,
			uploadThroughput: -1
		});
	await throttle(1_000_000);
	const png = { name: 'layar.png', mimeType: 'image/png', buffer: await drawScreen(page) };
	await block.getByTestId('ocr-gallery').setInputFiles(png);
	await expect(
		shown(page, /Mengunduh mesin baca \(sekitar [\d,.]+ MB, sekali saja\)/)
	).toBeVisible();
	await expect(block.getByRole('progressbar')).toBeVisible();
	await block.getByRole('button', { name: 'Batal' }).click();
	await expect(shown(page, 'Dibatalkan. Tidak ada yang dikirim.')).toBeVisible();
	await throttle(-1);

	// Batal while reading: nothing is posted and no engine worker is left. The read is held where the test
	// controls it, so it cannot finish before Batal is pressed: the engine's Worker request (resource type
	// "script"; the download's own fetch of the same file passes) waits until the test has cancelled.
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	let holding!: () => void;
	const held = new Promise<void>((resolve) => (holding = resolve));
	await page.route(/\/_ocr\/[^/]+\/worker\.min\.js$/, async (route) => {
		if (route.request().resourceType() !== 'script') return route.continue();
		holding();
		await released;
		await route.continue().catch(() => {});
	});
	await block.getByTestId('ocr-gallery').setInputFiles(png);
	await expect(shown(page, 'Membaca halaman 1 dari 1 (100%)')).toBeVisible({ timeout: 30_000 });
	await held;
	await block.getByRole('button', { name: 'Batal' }).click();
	await expect(shown(page, 'Dibatalkan. Tidak ada yang dikirim.')).toBeVisible();
	// An engine whose start the cancel overtook is terminated as soon as it arrives.
	release();
	await expect.poll(() => page.workers().length).toBe(0);
	await page.unroute(/\/_ocr\/[^/]+\/worker\.min\.js$/);
	expect(posts).toEqual([]);

	// The full run.
	await block.getByTestId('ocr-gallery').setInputFiles(png);
	await expect(block.getByRole('heading', { name: 'Siap dimasukkan' })).toBeVisible({
		timeout: 90_000
	});
	await expect(shown(page, 'Kopi Senja Fiktif')).toBeVisible();
	await expect(shown(page, LONG_TITLE)).toBeVisible();
	await expectNoHorizontalScroll(page);
	const review = block.locator('details.review');
	await expect(review).not.toHaveAttribute('open', '');
	await review.locator('summary').click();
	await expect(
		review.getByText('Tanda masuk/keluar tidak terbaca, dianggap pengeluaran')
	).toBeVisible();
	await review.getByRole('checkbox').check();
	// Changed ticks: a fresh preview first ("changed meanwhile"), then the import.
	await block.getByRole('button', { name: 'Perbarui pratinjau' }).click();
	const importButton = block.getByRole('button', { name: 'Masukkan 3 transaksi' });
	await expect(importButton).toBeVisible();
	await importButton.dblclick();
	await expect(block.getByRole('heading', { name: 'Hasil bacaan dimasukkan' })).toBeFocused();
	await expect(shown(page, 'Diimpor 3 · Dilewati 0 · Sudah pernah diimpor 0')).toBeVisible();
	expect(posts.filter((u) => u.includes('importOcr'))).toHaveLength(1);

	await page.goto(`${APP_ORIGIN}/riwayat?from=${DAY_ISO}&to=${DAY_ISO}`);
	await expect(page.getByText('Kopi Senja Fiktif')).toBeVisible();
	await expect(page.getByText('−Rp 25.000').first()).toBeVisible();
	await page.reload();
	await expect(page.getByText('Kopi Senja Fiktif')).toBeVisible();

	await page.goto(`${APP_ORIGIN}/impor`);
	await waitForHydration(page);
	const batch = page.getByRole('listitem').filter({ hasText: 'Berkas mutasi' }).first();
	await batch.getByText('Urungkan', { exact: true }).click();
	await batch.getByRole('button', { name: 'Ya, urungkan' }).click();
	await expect(page.getByText('Impor diurungkan.')).toBeVisible();
	await page.goto(`${APP_ORIGIN}/riwayat?from=${DAY_ISO}&to=${DAY_ISO}`);
	await expect(page.getByText('Kopi Senja Fiktif')).toHaveCount(0);
	await context.close();
});

test('camera action: capture input, and without a camera the gallery pick takes over (criteria 15, 40)', async ({
	page,
	browser
}) => {
	// Without JavaScript the block explains that it needs it, and offers no inputs; the PDF/CSV forms remain.
	const noJs = await browser.newContext({ storageState: STORAGE_STATE, javaScriptEnabled: false });
	const plain = await noJs.newPage();
	await plain.goto(`${APP_ORIGIN}/impor`);
	await showOcr(plain);
	await expect(
		ocrBlock(plain).getByText(
			'Membaca foto butuh JavaScript. Untuk sekarang, impor PDF atau CSV di atas.'
		)
	).toBeVisible();
	await expect(ocrBlock(plain).locator('input[type=file]')).toHaveCount(0);
	await expect(plain.getByLabel('Pilih berkas mutasi')).toBeAttached();
	await noJs.close();

	await page.goto(`${APP_ORIGIN}/impor`);
	await waitForHydration(page);
	await showOcr(page);
	const block = ocrBlock(page);
	const input = block.getByTestId('ocr-camera');
	await expect(input).toHaveAttribute('capture', 'environment');
	await expect(input).toHaveAttribute('accept', 'image/*');
	expect(await input.evaluate((el) => el.closest('form'))).toBeNull();
	const cameras = await page.evaluate(
		async () =>
			(await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
				.length
	);
	test.skip(cameras > 0, 'this browser reports a camera');
	await block.getByRole('button', { name: 'Ambil foto' }).click();
	await expect(
		shown(page, 'Kamera tidak tersedia. Pilih foto dari galeri atau berkas.')
	).toBeVisible();
	await expect(block.getByRole('button', { name: 'Pilih dari galeri/berkas' })).toBeFocused();
	// A browser that ignores `capture` hands the camera input a chosen file: the run still completes.
	await input.setInputFiles({
		name: 'foto.jpg',
		mimeType: 'image/jpeg',
		buffer: await drawScreen(page, 'image/jpeg')
	});
	await expect(block.getByRole('heading', { name: 'Siap dimasukkan' })).toBeVisible({
		timeout: 90_000
	});
});

test('a scanned (image-only) PDF is rendered with pdf.js and read; pages past 12 are reported', async ({
	page
}) => {
	test.setTimeout(240_000);
	await page.goto(`${APP_ORIGIN}/impor`);
	await waitForHydration(page);
	await showOcr(page);
	const seen = watch(page);
	const jpeg = await drawScreen(page, 'image/jpeg');
	const pdf = imagePdf(jpeg, 1600, 1000, 13);
	const block = ocrBlock(page);
	await block
		.getByTestId('ocr-gallery')
		.setInputFiles({ name: 'pindaian.pdf', mimeType: 'application/pdf', buffer: pdf });
	await expect(shown(page, /Membaca halaman \d+ dari 12/)).toBeVisible({ timeout: 60_000 });
	await expect(block.getByRole('heading', { name: 'Siap dimasukkan' })).toBeVisible({
		timeout: 200_000
	});
	await expect(shown(page, '1 halaman tidak dibaca (batas 12 halaman per bacaan).')).toBeVisible();
	await expect(shown(page, /GoPay · 12 halaman/)).toBeVisible();
	expect(seen.requests.some((u) => u.includes('/_ocr/') && u.endsWith('pdf.worker.min.mjs'))).toBe(
		true
	);
	expect(seen.requests.every((u) => u.startsWith(APP_ORIGIN) || u.startsWith('data:'))).toBe(true);
	expect(seen.violations).toEqual([]);
});
