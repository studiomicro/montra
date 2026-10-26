import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocalBaseUrl } from './local-guard.ts';

/**
 * FN-13b: the screenshots in the manifest (`static/screenshots/`), for Chrome's richer install dialog. Run by hand
 * against a LOCAL app with the local D1, then commit the outputs; never part of `npm run gates`, `npm run build`
 * or CI:
 *
 *   npm run build   # or leave `npm run dev` running
 *   FIN_PERSIST_TO=.wrangler/state npx wrangler dev -c wrangler.jsonc --persist-to .wrangler/state --port 8787
 *   node scripts/capture-store-screenshots.ts http://localhost:8787
 *
 * The persist directory must be the one the app serves (`FIN_PERSIST_TO`, default `.wrangler/state`, as for
 * `npm run db:seed:local`). The base URL must be this machine (`assertLocalBaseUrl`). The script signs up one fixed
 * fictional account, adds an IDR wallet, runs the local demo seed (scripts/seed-local.ts) and photographs Riwayat:
 * only `Data demo` rows, each with its badge, and a "Data demo" ribbon in the corner of every image. No real data
 * is ever on screen. Beranda is not shown: demo rows are left out of every total, so it would read Rp 0.
 *
 * Images (manifest rules, web.dev "Richer PWA installation UI"): PNG, each side 320-3840 px, long side at most
 * 2.3 times the short side, one aspect ratio per form factor.
 *   narrow: 1080x2340 (a 360x780 viewport at scale 3): Riwayat, and the Tambah sheet open
 *   wide:   1280x800: Riwayat on a desktop
 * The rows are dated relative to the day the seed ran, so a re-run on another day changes the pixels.
 */

/** The fictional demo account; its address ends in `.local`, which no mail server resolves. */
const DEMO_ACCOUNT = {
	name: 'Akun Demo',
	email: 'demo-screens@montra.local',
	password: 'terang-benderang-8'
} as const;

export interface ShotSpec {
	/** Path under static/screenshots/. */
	file: string;
	formFactor: 'narrow' | 'wide';
	/** CSS viewport and device scale: the PNG is width*scale by height*scale. */
	width: number;
	height: number;
	scale: number;
	label: string;
	/** Open the Tambah sheet before shooting (phone only). */
	sheet?: boolean;
}

export const SHOTS: readonly ShotSpec[] = [
	{
		file: 'screenshots/narrow-riwayat.png',
		formFactor: 'narrow',
		width: 360,
		height: 780,
		scale: 3,
		label: 'Riwayat: transaksi harian, dengan data demo'
	},
	{
		file: 'screenshots/narrow-tambah.png',
		formFactor: 'narrow',
		width: 360,
		height: 780,
		scale: 3,
		label: 'Tambah transaksi: ketik, suara atau foto struk',
		sheet: true
	},
	{
		file: 'screenshots/wide-riwayat.png',
		formFactor: 'wide',
		width: 1280,
		height: 800,
		scale: 1,
		label: 'Riwayat di desktop, dengan data demo'
	}
];

const RIBBON_STYLE =
	'position:fixed;inset:26px -44px auto auto;margin:0;border:0;overflow:visible;width:170px;padding:5px 0;transform:rotate(45deg);' +
	'background:#171717;color:#ffffff;font:700 13px/1.2 system-ui,sans-serif;text-align:center;' +
	'letter-spacing:.02em;z-index:2147483647;pointer-events:none';

async function main(baseUrl: string) {
	const origin = assertLocalBaseUrl(baseUrl).origin;
	const { chromium } = await import('@playwright/test');
	const outDir = join(import.meta.dirname, '..', 'static');
	mkdirSync(join(outDir, 'screenshots'), { recursive: true });
	const browser = await chromium.launch();
	try {
		const phone = SHOTS[0]!;
		const context = await browser.newContext({
			baseURL: origin,
			viewport: { width: phone.width, height: phone.height },
			deviceScaleFactor: phone.scale,
			isMobile: true,
			hasTouch: true,
			locale: 'id-ID',
			reducedMotion: 'reduce',
			// Local app only (asserted above): the ribbon is injected as an inline-styled element.
			bypassCSP: true
		});
		const page = await context.newPage();
		await signIn(page, origin);
		// The preset categories are created on a space's first visit to Riwayat, and the seed needs them.
		await page.goto('/riwayat');
		await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
		// The seed adds `Data demo` rows to every local space that has an IDR wallet.
		execFileSync('node', ['scripts/seed-local.ts'], { stdio: 'inherit', env: process.env });

		for (const shot of SHOTS) {
			await page.setViewportSize({ width: shot.width, height: shot.height });
			// A viewport change does not change the scale, so each form factor gets its own page.
			const shooter =
				shot.scale === phone.scale ? page : await desktopPage(browser, origin, shot, page);
			await shooter.goto('/riwayat');
			await shooter.locator('html[data-hydrated]').waitFor({ state: 'attached' });
			await shooter.getByText('Data demo').first().waitFor();
			if (shot.sheet) {
				await shooter.locator('nav.tabbar button').click();
				await shooter.locator('dialog[open]').waitFor();
			}
			// A popover sits in the top layer, above an open Tambah sheet and its backdrop.
			await shooter.evaluate((html) => {
				document.body.insertAdjacentHTML('beforeend', html);
				document.querySelector<HTMLElement>('#data-demo-ribbon')?.showPopover();
			}, `<div id="data-demo-ribbon" popover="manual" style="${RIBBON_STYLE}">Data demo</div>`);
			const png = await shooter.screenshot({ type: 'png' });
			writeFileSync(join(outDir, shot.file), png);
			console.log(`wrote static/${shot.file} (${png.length} bytes)`);
			if (shooter !== page) await shooter.context().close();
		}
	} finally {
		await browser.close();
	}
}

type Page = Awaited<
	ReturnType<Awaited<ReturnType<typeof import('@playwright/test').chromium.launch>>['newPage']>
>;

/** A desktop context signed in with the demo account (the phone page's cookies are copied across). */
async function desktopPage(
	browser: Awaited<ReturnType<typeof import('@playwright/test').chromium.launch>>,
	origin: string,
	shot: ShotSpec,
	phonePage: Page
): Promise<Page> {
	const context = await browser.newContext({
		baseURL: origin,
		viewport: { width: shot.width, height: shot.height },
		deviceScaleFactor: shot.scale,
		locale: 'id-ID',
		reducedMotion: 'reduce',
		bypassCSP: true,
		storageState: await phonePage.context().storageState()
	});
	return context.newPage();
}

/** Signs the demo account up (first run) or in (later runs), and gives it an IDR wallet on first sign-up. */
async function signIn(page: Page, origin: string) {
	await page.goto('/daftar');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.getByLabel('Nama').fill(DEMO_ACCOUNT.name);
	await page.getByLabel('E-mail').fill(DEMO_ACCOUNT.email);
	await page.getByLabel('Kata sandi').fill(DEMO_ACCOUNT.password);
	await page.getByRole('checkbox', { name: /18 tahun/ }).check();
	await page.getByRole('checkbox', { name: /Saya menyetujui/ }).check();
	await page.getByRole('button', { name: 'Daftar' }).click();
	const signedUp = await page
		.waitForURL(`${origin}/`, { timeout: 8000 })
		.then(() => true)
		.catch(() => false);
	if (signedUp) {
		const res = await page.request.post(`${origin}/dompet?/createWallet`, {
			form: {
				name: 'Rekening demo',
				type: 'bank',
				currency: 'IDR',
				openingBalance: '100.000',
				lastFour: ''
			},
			headers: { origin, accept: 'text/html' },
			maxRedirects: 0
		});
		if (![200, 303].includes(res.status())) throw new Error(`wallet: HTTP ${res.status()}`);
		return;
	}
	// The account exists from an earlier run: sign in.
	await page.goto('/masuk');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.getByLabel('E-mail').fill(DEMO_ACCOUNT.email);
	await page.getByLabel('Kata sandi').fill(DEMO_ACCOUNT.password);
	await page.getByRole('button', { name: 'Masuk' }).click();
	await page.waitForURL(`${origin}/`);
}

if (import.meta.main) await main(process.argv[2] ?? 'http://localhost:8787');
