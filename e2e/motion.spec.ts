import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
	APP_ORIGIN,
	collectCspViolations,
	SIGNED_OUT,
	STORAGE_STATE,
	expectNoHorizontalScroll,
	simulatedClientIp,
	tickSignUpBoxes,
	waitForHydration
} from './helpers';
import { addWallet, freshUser as freshLedgerUser, ids, postExpense, today } from './ledger';

// Red team L2: every page this spec opens — motion on and off — is watched for CSP violations (the @starting-style
// sheet, the Web Animations fade, the counting number and the illustrations must need no CSP exception).
let cspLogs: string[][] = [];
async function open(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	cspLogs.push(collectCspViolations(page));
	return page;
}

/**
 * Plays every animation on the page at a tenth of its speed (Chromium DevTools protocol), for the tests that must
 * look at an animation while it is still running: a 200–300 ms fade or rise is easily over by the time a slow CI
 * runner reads it. Durations are unchanged in the app; only the test's clock is stretched.
 */
async function slowAnimations(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Animation.enable');
	await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
}
test.beforeEach(() => {
	cspLogs = [];
});
test.afterEach(() => {
	expect(cspLogs.flat()).toEqual([]);
});

// FN-40 Parts 2 and 3 in a real browser: motion runs only when allowed, ends on the exact state, and is
// absent under prefers-reduced-motion; the illustrations repaint per theme and never push a form below the fold.

const FIRST = 'Rp1.264.000';
const SECOND = 'Rp987.500,50';
/** The hero figure as shown: the raised symbol and the digits, without spaces. */
const heroText = (page: Page) =>
	page
		.locator('.hero .figure')
		.first()
		.evaluate((el) => (el.textContent ?? '').replace(/\s/g, ''));

async function kit(browser: Browser, reducedMotion: 'reduce' | 'no-preference') {
	const context = await browser.newContext({
		reducedMotion,
		viewport: { width: 360, height: 780 },
		storageState: STORAGE_STATE
	});
	const page = await open(context);
	await page.goto(`${APP_ORIGIN}/dev/ui`);
	await waitForHydration(page);
	return { context, page };
}

const animationOf = (page: Page, selector: string) =>
	page
		.locator(selector)
		.first()
		.evaluate((el) => {
			const s = getComputedStyle(el);
			return { name: s.animationName, delay: s.animationDelay };
		});

test.describe('motion', () => {
	// Each test opens its own contexts: the phone project runs them once.
	test.skip(({ isMobile }) => !isMobile, 'own contexts; one project is enough');

	test('reduced motion: the end state renders at once — hero, sheet, rows, charts, illustrations', async ({
		browser
	}) => {
		const { context, page } = await kit(browser, 'reduce');
		expect(await heroText(page)).toBe(FIRST);
		await page.getByRole('button', { name: 'Count up' }).click();
		// Read once, no retrying: the new figure is already on screen.
		expect(await heroText(page)).toBe(SECOND);

		await page.getByRole('button', { name: 'Dompet', exact: true }).click();
		const sheet = page.getByRole('dialog', { name: 'Dompet' });
		await expect(sheet).toBeVisible();
		expect(await sheet.evaluate((el) => el.getAnimations().length)).toBe(0);
		const dialog = (await sheet.elementHandle())!;
		await page.keyboard.press('Escape');
		expect(await dialog.evaluate((el) => getComputedStyle(el).display)).toBe('none');

		for (const selector of [
			'ul[aria-label="Stagger"] > li',
			'.bar',
			'polyline',
			// The blueprint illustrations (1c93349) have one moving part, the floating scene; no shadow.
			'.illustration .float'
		])
			expect((await animationOf(page, selector)).name, selector).toBe('none');
		await context.close();
	});

	test('a rising sheet takes no taps until it has settled (red team L1); then it works', async ({
		browser
	}) => {
		const { context, page } = await kit(browser, 'no-preference');
		await slowAnimations(page);
		await page.getByRole('button', { name: 'Dompet', exact: true }).click();
		const dialog = page.locator('dialog[open]');
		// Read at once, inside the 300 ms rise (3 s at the test's slowed speed): neither the sheet nor its scrim takes a tap.
		const during = await dialog.evaluate((el) => ({
			sheet: getComputedStyle(el).pointerEvents,
			scrim: getComputedStyle(el, '::backdrop').pointerEvents
		}));
		expect(during).toEqual({ sheet: 'none', scrim: 'none' });
		// A quick second tap — on an option, and on the scrim — changes nothing and does not close the sheet.
		const option = (await dialog.getByRole('radio', { name: /Tunai/ }).first().boundingBox())!;
		await page.mouse.click(option.x + option.width / 2, option.y + option.height / 2);
		await page.mouse.click(180, 40);
		await expect(dialog).toHaveCount(1);
		// Settled: it takes taps again (300 ms rise, slowed to 3 s; the poll only waits for that).
		await expect
			.poll(() => dialog.evaluate((el) => getComputedStyle(el).pointerEvents), { timeout: 10_000 })
			.toBe('auto');
		await dialog.getByRole('radio', { name: /Tunai/ }).first().click();
		await expect(page.locator('dialog[open]')).toHaveCount(0);
		await context.close();
	});

	test('with motion: the hero counts to the exact figure in ≤ 300 ms; the sheet sinks out; 8 rows stagger', async ({
		browser
	}) => {
		const { context, page } = await kit(browser, 'no-preference');
		// Sample the figure every frame while it counts.
		const samples = page.evaluate(
			() =>
				new Promise<string[]>((resolve) => {
					const el = document.querySelector('.hero .figure')!;
					const seen: string[] = [];
					const start = performance.now();
					const tick = () => {
						seen.push((el.textContent ?? '').replace(/\s/g, ''));
						if (performance.now() - start < 700) requestAnimationFrame(tick);
						else resolve(seen);
					};
					requestAnimationFrame(tick);
				})
		);
		await page.getByRole('button', { name: 'Count up' }).click();
		const seen = await samples;
		const distinct = [...new Set(seen)];
		expect(distinct.length).toBeGreaterThan(3); // it counted through amounts in between
		expect(seen.at(-1)).toBe(SECOND); // and settled on the exact figure
		// Every frame shows a whole rupiah-and-sen amount between the two figures, never a fraction.
		const minor = (s: string) => Number(s.replace('Rp', '').replace(/\./g, '').replace(',', ''));
		for (const s of distinct) {
			const value = minor(s.includes(',') ? s : `${s},00`);
			expect(value, s).toBeGreaterThanOrEqual(98_750_050);
			expect(value, s).toBeLessThanOrEqual(126_400_000);
		}

		const rows = page.locator('ul[aria-label="Stagger"] > li');
		const row = (n: number) =>
			rows.nth(n - 1).evaluate((el) => {
				const s = getComputedStyle(el);
				return { name: s.animationName, delay: s.animationDelay };
			});
		expect((await row(1)).name).not.toBe('none');
		expect((await row(8)).delay).toBe('0.21s');
		expect(await row(9)).toEqual({ name: 'none', delay: '0s' });
		expect((await row(12)).name).toBe('none');
		expect((await animationOf(page, '.illustration .float')).name).not.toBe('none');

		await page.getByRole('button', { name: 'Dompet', exact: true }).click();
		const sheet = page.getByRole('dialog', { name: 'Dompet' });
		await expect(sheet).toBeVisible();
		const dialog = (await sheet.elementHandle())!;
		await page.keyboard.press('Escape');
		// Still drawn for the close transition, then gone; focus is back on the opener.
		expect(await dialog.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
		await expect(sheet).toBeHidden();
		await expect(page.getByRole('button', { name: 'Dompet', exact: true })).toBeFocused();
		await context.close();
	});

	test('rows take a real tap while they are still fading in, with and without JavaScript', async ({
		browser
	}) => {
		for (const javaScriptEnabled of [true, false]) {
			const context = await browser.newContext({
				javaScriptEnabled,
				reducedMotion: 'no-preference',
				viewport: { width: 360, height: 780 },
				storageState: STORAGE_STATE
			});
			const page = await open(context);
			await slowAnimations(page);
			await page.goto(`${APP_ORIGIN}/pengaturan`);
			const row = page.locator('main ul.group > li:nth-child(2) a').first();
			const href = await row.getAttribute('href');
			// Measured and tapped at once (no actionability wait): the row's fade-in is still running.
			const running = await row.evaluate((el) =>
				el.parentElement!.getAnimations().some((a) => a.playState === 'running')
			);
			const box = (await row.boundingBox())!;
			await page.mouse.click(box.x + 40, box.y + box.height / 2);
			await expect(page).toHaveURL(`${APP_ORIGIN}${href}`);
			expect(running, `js=${javaScriptEnabled}`).toBe(true);
			await context.close();
		}
	});

	test('page fade-in: the next page fades in and takes a tap at once; nothing under reduced motion', async ({
		browser
	}) => {
		for (const reducedMotion of ['no-preference', 'reduce'] as const) {
			const context = await browser.newContext({
				reducedMotion,
				viewport: { width: 360, height: 780 },
				storageState: STORAGE_STATE
			});
			const page = await open(context);
			await page.goto(`${APP_ORIGIN}/`);
			await waitForHydration(page);
			const tab = (name: string) =>
				page.getByRole('link', { name, exact: true }).filter({ visible: true }).first();
			const laporan = (await tab('Laporan').boundingBox())!;
			await tab('Riwayat').click();
			await page.waitForURL(`${APP_ORIGIN}/riwayat`);
			// FN-51: the running animation moves transform and opacity only (no pointer-events change).
			const entering = await page.evaluate(() => {
				const running = document
					.querySelector('main')!
					.getAnimations()
					.filter((a) => a.playState === 'running');
				const frames = running.flatMap((a) =>
					(a.effect as KeyframeEffect)
						.getKeyframes()
						.flatMap((k) =>
							Object.keys(k).filter(
								(key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)
							)
						)
				);
				return { running: running.length > 0, props: [...new Set(frames)].sort() };
			});
			expect(entering.running).toBe(reducedMotion === 'no-preference');
			if (reducedMotion === 'no-preference')
				expect(entering.props).toEqual(['opacity', 'transform']);
			// A real tap while the page is still fading in reaches its target (a view transition would drop it).
			await page.mouse.click(laporan.x + laporan.width / 2, laporan.y + laporan.height / 2);
			await expect(page).toHaveURL(`${APP_ORIGIN}/laporan`);
			// Fill mode none: once the 200 ms rise is over, no transform is left on <main>.
			await expect
				.poll(
					() => page.evaluate(() => getComputedStyle(document.querySelector('main')!).transform),
					{
						timeout: 2000
					}
				)
				.toBe('none');
			await context.close();
		}
	});

	// FN-51 (`docs/features/fn-51-motion/PRD.md`): the new placements in a real browser.

	const CHART_SELECTORS = ['.slices', '.seg', 'polyline.current', '.line', '.allocation rect'];
	const geometry = (page: Page) =>
		page.evaluate(() => ({
			dash: [...document.querySelectorAll('.donut .slice')].map((el) =>
				el.getAttribute('stroke-dasharray')
			),
			bars: [...document.querySelectorAll('.stacked .seg')].map((el) => el.getAttribute('height')),
			line: document.querySelector('.trend .line')?.getAttribute('points') ?? '',
			fill: document.querySelector('.progress .fill')?.getAttribute('width') ?? ''
		}));

	test('FN-51 charts: draw in on mount within 300 ms with motion, none under reduce, same final geometry', async ({
		browser
	}) => {
		const seen: Record<string, Awaited<ReturnType<typeof geometry>>> = {};
		for (const reducedMotion of ['no-preference', 'reduce'] as const) {
			const context = await browser.newContext({
				reducedMotion,
				viewport: { width: 360, height: 780 },
				storageState: STORAGE_STATE
			});
			const page = await open(context);
			await page.goto(`${APP_ORIGIN}/dev/ui/charts`);
			for (const selector of CHART_SELECTORS) {
				const running = await page
					.locator(selector)
					.first()
					.evaluate((el) => {
						const s = getComputedStyle(el);
						return { name: s.animationName, duration: s.animationDuration };
					});
				if (reducedMotion === 'reduce') expect(running.name, selector).toBe('none');
				else {
					expect(running.name, selector).not.toBe('none');
					// Every declared duration is ≤ 300 ms (0.2s / 0.3s).
					for (const d of running.duration.split(','))
						expect(Number.parseFloat(d), selector).toBeLessThanOrEqual(0.3);
				}
			}
			seen[reducedMotion] = await geometry(page);
			// /dev/ui: the budget bar and the skeleton band.
			await page.goto(`${APP_ORIGIN}/dev/ui`);
			const fill = await animationOf(page, '.progress .fill');
			const bars = page.locator('.skeleton .bar');
			await expect(bars).toHaveCount(8); // rows={20} is capped
			const band = await bars
				.first()
				.evaluate((el) => getComputedStyle(el, '::after').animationName);
			const valuenow = await page.locator('.progress').first().getAttribute('aria-valuenow');
			expect(valuenow).toBe('62');
			if (reducedMotion === 'reduce') {
				expect(fill.name).toBe('none');
				expect(band).toBe('none');
			} else {
				expect(fill.name).not.toBe('none');
				expect(band).not.toBe('none');
			}
			seen[reducedMotion] = { ...seen[reducedMotion]!, fill: (await geometry(page)).fill };
			await context.close();
		}
		// The animated render ends on exactly the geometry the reduced-motion render shows.
		expect(seen['no-preference']).toEqual(seen['reduce']);
		expect(seen['reduce']!.dash.length).toBeGreaterThan(0);
		expect(seen['reduce']!.bars.length).toBeGreaterThan(0);
	});

	test('FN-51 desktop: the dialog scales in and takes no taps until settled; nothing under reduce', async ({
		browser
	}) => {
		for (const reducedMotion of ['no-preference', 'reduce'] as const) {
			const context = await browser.newContext({
				reducedMotion,
				viewport: { width: 1280, height: 800 },
				storageState: STORAGE_STATE
			});
			const page = await open(context);
			await slowAnimations(page);
			await page.goto(`${APP_ORIGIN}/dev/ui`);
			await waitForHydration(page);
			await page.getByRole('button', { name: 'Dompet', exact: true }).click();
			const dialog = page.locator('dialog[open]');
			await expect(dialog).toHaveCount(1);
			const during = await dialog.evaluate((el) => ({
				animations: el.getAnimations().length,
				pointer: getComputedStyle(el).pointerEvents
			}));
			if (reducedMotion === 'reduce') {
				expect(during).toEqual({ animations: 0, pointer: 'auto' });
			} else {
				expect(during.animations).toBeGreaterThan(0);
				expect(during.pointer).toBe('none');
				await expect
					.poll(() => dialog.evaluate((el) => getComputedStyle(el).pointerEvents), {
						timeout: 10_000
					})
					.toBe('auto');
			}
			await dialog.getByRole('radio', { name: /Tunai/ }).first().click();
			await expect(page.locator('dialog[open]')).toHaveCount(0);
			await context.close();
		}
	});

	test('FN-51 phone: the Tambah button says the sheet is open and turns its "+"', async ({
		browser
	}) => {
		const context = await browser.newContext({
			reducedMotion: 'no-preference',
			viewport: { width: 360, height: 780 },
			storageState: STORAGE_STATE
		});
		const page = await open(context);
		await page.goto(`${APP_ORIGIN}/`);
		await waitForHydration(page);
		const fab = page.getByRole('button', { name: 'Tambah' }).filter({ visible: true });
		await expect(fab).toHaveAttribute('aria-expanded', 'false');
		await fab.click();
		await expect(page.getByRole('dialog', { name: 'Tambah transaksi' })).toBeVisible();
		await expect(fab).toHaveAttribute('aria-expanded', 'true');
		await expect
			.poll(() => fab.locator('.plus').evaluate((el) => getComputedStyle(el).transform), {
				timeout: 2000
			})
			.not.toBe('none');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Tambah transaksi' })).toBeHidden();
		await expect(fab).toHaveAttribute('aria-expanded', 'false');
		await expect
			.poll(() => fab.locator('.plus').evaluate((el) => getComputedStyle(el).transform), {
				timeout: 2000
			})
			.toBe('none');
		await context.close();
	});

	/** Synthetic touches on window (what the pull listens to); `hasTouch` makes the constructors available. */
	const touch = (page: Page, type: 'touchstart' | 'touchmove' | 'touchend', y: number) =>
		page.evaluate(
			([type, y]) => {
				const t = new Touch({ identifier: 1, target: document.body, clientX: 180, clientY: y });
				window.dispatchEvent(
					new TouchEvent(type, {
						touches: type === 'touchend' ? [] : [t],
						changedTouches: [t],
						bubbles: true,
						cancelable: true
					})
				);
			},
			[type, y] as const
		);

	test('FN-51 pull-to-refresh: installed app only, a pull from the top reloads; a scroll-up does nothing', async ({
		browser
	}) => {
		for (const standalone of [true, false]) {
			const context = await browser.newContext({
				reducedMotion: 'no-preference',
				hasTouch: true,
				isMobile: true,
				viewport: { width: 360, height: 780 },
				storageState: STORAGE_STATE
			});
			if (standalone)
				await context.addInitScript(() => {
					Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
				});
			const page = await open(context);
			await page.goto(`${APP_ORIGIN}/riwayat`);
			await waitForHydration(page);
			const pill = page.locator('[data-pull-to-refresh]');
			await expect(pill).toHaveCount(standalone ? 1 : 0);
			let loads = 0;
			page.on('request', (r) => {
				if (r.url().includes('__data.json')) loads++;
			});
			// A finger moving up (scrolling the list) never pulls.
			await touch(page, 'touchstart', 300);
			await touch(page, 'touchmove', 200);
			if (standalone) expect(await pill.evaluate((el) => el.getAnimations().length)).toBe(0);
			await touch(page, 'touchend', 200);
			// Proves a negative: an upward drag never reloads, so there is no event to await.
			await page.waitForTimeout(150);
			expect(loads).toBe(0);
			// A drag down from the top: the indicator follows the finger (a paused Web Animation), then reloads.
			await touch(page, 'touchstart', 100);
			await touch(page, 'touchmove', 140);
			if (standalone) {
				const mid = await pill.evaluate((el) => {
					const a = el.getAnimations()[0];
					return a ? { state: a.playState, time: Number(a.currentTime) } : null;
				});
				expect(mid?.state).toBe('paused');
				expect(mid?.time).toBeGreaterThan(0);
				expect(mid?.time).toBeLessThan(1000);
			}
			await touch(page, 'touchmove', 200);
			const reload = standalone
				? page.waitForResponse((r) => r.url().includes('__data.json'), { timeout: 5000 })
				: null;
			await touch(page, 'touchend', 200);
			if (standalone) {
				await expect(pill).toHaveAttribute('aria-busy', 'true');
				await reload;
				await expect(pill).not.toHaveAttribute('aria-busy', 'true');
				expect(loads).toBeGreaterThan(0);
			} else {
				// Proves a negative: outside the installed app a drag never reloads.
				await page.waitForTimeout(300);
				expect(loads).toBe(0);
			}
			await context.close();
		}
	});
});

test.describe('FN-51 lists', () => {
	test.skip(({ isMobile }) => !isMobile, 'own contexts; one project is enough');

	test('Riwayat "Muat lebih banyak": the new day header and first row fade in, a tap mid-fade navigates', async ({
		browser
	}, testInfo) => {
		test.setTimeout(150_000);
		const { context, page } = await freshLedgerUser(browser, testInfo, 'fn51');
		await addWallet(page, 'BCA', '10.000.000');
		const { wallet, category } = await ids(page);
		const walletId = await wallet('BCA');
		const categoryId = await category('Kopi');
		// 50 rows on one day fill the first page; the next page holds 10 rows from the day before, so it adds a new
		// day section (a page that continues the same day would only grow the section already shown). Both days are
		// in last month, so the pair never straddles a month boundary.
		const start = new Date(`${today().slice(0, 7)}-01T00:00:00Z`);
		start.setUTCMonth(start.getUTCMonth() - 1);
		const month = start.toISOString().slice(0, 7);
		for (let i = 1; i <= 60; i++)
			await postExpense(page, {
				walletId,
				categoryId,
				amount: '1.000',
				title: `Baris ${i}`,
				occurredOn: `${month}-${i <= 10 ? '01' : '02'}`
			});
		const motion = await browser.newContext({
			reducedMotion: 'no-preference',
			viewport: { width: 360, height: 780 },
			storageState: await context.storageState()
		});
		const view = await open(motion);
		await view.goto(`${APP_ORIGIN}/riwayat?month=${month}`);
		await waitForHydration(view);
		const rows = view.locator('main a[href$="/edit"]');
		await expect(rows).toHaveCount(50);
		// Every element whose animation starts from the tap on: a slow runner may finish the fade before the
		// list is read, so the start events are recorded rather than sampled while running.
		await view.evaluate(() => {
			const started = new Set<Element>();
			(window as unknown as { started: Set<Element> }).started = started;
			document.addEventListener('animationstart', (e) => started.add(e.target as Element), true);
		});
		await view.getByRole('link', { name: 'Muat lebih banyak' }).click();
		await expect(rows).toHaveCount(60);
		// The appended page is a new day section: its header and its first row fade in; the 9th row does not.
		const sections = view.locator('main section.day');
		const last = sections.last();
		const animated = () =>
			last.evaluate((section) => {
				const { started } = window as unknown as { started: Set<Element> };
				const header = section.querySelector('.day');
				const first = section.querySelector('ul.group > li');
				const ninth = section.querySelector('ul.group > li:nth-child(9)');
				return {
					header: !!header && started.has(header),
					first: !!first && started.has(first),
					ninth: !!ninth && started.has(ninth)
				};
			});
		// The start events arrive on the frame after the rows are inserted.
		await expect.poll(animated).toMatchObject({ header: true, first: true });
		expect((await animated()).ninth).toBe(false);
		const firstRow = last.locator('ul.group > li a').first();
		const href = await firstRow.getAttribute('href');
		await firstRow.scrollIntoViewIfNeeded();
		const box = (await firstRow.boundingBox())!;
		await view.mouse.click(box.x + 40, box.y + box.height / 2);
		await expect(view).toHaveURL(`${APP_ORIGIN}${href}`);
		await motion.close();
		await context.close();
	});

	test('Kotak masuk: a discarded draft fades out with motion on; no CSP violation', async ({
		browser
	}, testInfo) => {
		const context = await browser.newContext({
			storageState: SIGNED_OUT,
			reducedMotion: 'no-preference',
			viewport: { width: 360, height: 780 },
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo, 2) }
		});
		const page = await open(context);
		await page.goto(`${APP_ORIGIN}/daftar`);
		await waitForHydration(page);
		await page.getByLabel('Nama').fill('Peninjau');
		await page
			.getByLabel('E-mail')
			.fill(`fn51-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
		await page.getByLabel('Kata sandi').fill('terang-benderang-8');
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await page.waitForURL(`${APP_ORIGIN}/`);
		await page.goto(`${APP_ORIGIN}/kotak-masuk`);
		await waitForHydration(page);
		await page.getByRole('button', { name: 'Tambah draf contoh' }).click();
		await expect(page.getByText('4 draf menunggu')).toBeVisible();
		const row = page.getByRole('listitem').filter({ hasText: 'Toko Serba Ada' });
		await row.getByText('Abaikan', { exact: true }).click();
		await row.getByRole('button', { name: 'Ya, abaikan' }).click();
		await expect(page.getByText('Draf diabaikan.')).toBeVisible();
		await expect(page.getByText('Toko Serba Ada')).toHaveCount(0);
		await expect(page.getByText('3 draf menunggu')).toBeVisible();
		await page.getByRole('button', { name: 'Kosongkan draf contoh' }).click();
		await expect(page.getByText('Tidak ada draf yang menunggu.')).toBeVisible();
		await context.close();
	});
});

test.describe('illustrations', () => {
	// Each test opens its own contexts: the phone project runs them once.
	test.skip(({ isMobile }) => !isMobile, 'own contexts; one project is enough');

	test('repaint from the theme tokens in light, dark, mono-light and mono-dark', async ({
		browser
	}) => {
		const fills: Record<string, string> = {};
		for (const [theme, colorScheme] of [
			['light', 'light'],
			['dark', 'dark'],
			['mono', 'light'],
			['mono', 'dark']
		] as const) {
			const context = await browser.newContext({ colorScheme, storageState: STORAGE_STATE });
			await context.addCookies([{ name: 'theme', value: theme, url: APP_ORIGIN }]);
			const page = await open(context);
			await page.goto(`${APP_ORIGIN}/dev/ui`);
			const scene = page.locator('[data-scene="wallet"] svg');
			await expect(scene).toHaveAttribute('aria-hidden', 'true');
			const fill = (cls: string) =>
				scene
					.locator(`.${cls}`)
					.first()
					.evaluate((el) => getComputedStyle(el).fill);
			const key = `${theme}-${colorScheme}`;
			fills[key] = await fill('a-r');
			const coin = await fill('g-t');
			for (const value of [fills[key], coin]) {
				expect(value, key).toMatch(/^(rgb|color)\(/);
				expect(value, key).not.toBe('rgb(0, 0, 0)'); // a class that resolved to nothing paints black
			}
			if (theme === 'mono') {
				// Achromatic like the rest of mono: r = g = b.
				for (const value of [fills[key], coin]) {
					const [r, g, b] = (value.match(/[\d.]+/g) ?? []).slice(-3).map(Number);
					expect(r, `${key} ${value}`).toBeCloseTo(g!, 0);
					expect(g, `${key} ${value}`).toBeCloseTo(b!, 0);
				}
			}
			await context.close();
		}
		expect(new Set(Object.values(fills)).size).toBe(4);
	});

	test('360 px: sign-in and sign-up keep the form at the top; the wide screen shows the scene', async ({
		browser
	}) => {
		for (const path of ['/masuk', '/daftar']) {
			const phone = await browser.newContext({
				storageState: SIGNED_OUT,
				viewport: { width: 360, height: 640 }
			});
			const page = await open(phone);
			await page.goto(`${APP_ORIGIN}${path}`);
			await expect(page.locator('.hero-art')).toBeHidden();
			const field = await page.getByLabel('E-mail').boundingBox();
			expect(field!.y + field!.height).toBeLessThanOrEqual(640);
			await expectNoHorizontalScroll(page);
			await phone.close();

			const wide = await browser.newContext({
				storageState: SIGNED_OUT,
				viewport: { width: 1280, height: 800 }
			});
			const desk = await open(wide);
			await desk.goto(`${APP_ORIGIN}${path}`);
			// FN-44: Koko waves in the hero.
			await expect(desk.locator('.hero-art svg.mascot.pose-wave')).toBeVisible();
			await expect(desk.locator('.hero-art svg')).toHaveAttribute('aria-hidden', 'true');
			await wide.close();
		}
	});

	// FN-56: the decorative ASCII field. A band above the form below 1024 px, a 360 x 560 card left of the form (and of
	// Koko, who stays) from 1024 px; a still frame under reduced motion; script frames only while visible.
	test('sign-in and sign-up: the ASCII field never moves, covers or takes focus from the form', async ({
		browser
	}) => {
		const fieldText = (page: Page, grid: 'phone' | 'desktop') =>
			page.locator(`[data-testid="ascii-field"] .${grid}`).evaluate((el) => el.textContent);
		for (const path of ['/masuk', '/daftar']) {
			// Phone, reduced motion: the still frame, above the form, nothing focusable, no shift.
			const still = await browser.newContext({
				storageState: SIGNED_OUT,
				viewport: { width: 360, height: 640 },
				reducedMotion: 'reduce'
			});
			const page = await open(still);
			await page.goto(`${APP_ORIGIN}${path}`);
			await waitForHydration(page);
			const field = page.getByTestId('ascii-field');
			await expect(field).toHaveAttribute('aria-hidden', 'true');
			const band = (await field.boundingBox())!;
			expect(band.height).toBeGreaterThanOrEqual(120);
			expect(band.height).toBeLessThanOrEqual(160);
			const heading = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
			expect(band.y + band.height).toBeLessThanOrEqual(heading.y);
			const email = (await page.getByLabel('E-mail').boundingBox())!;
			expect(email.y + email.height).toBeLessThanOrEqual(640);
			const before = await fieldText(page, 'phone');
			// Proves a negative: under reduced motion the field text stays still, so wait past a rotation tick.
			await page.waitForTimeout(1000);
			expect(await fieldText(page, 'phone')).toBe(before);
			await expectNoHorizontalScroll(page);
			// Focus: the wordmark first, then the form; Shift+Tab from the first field goes back to the wordmark.
			await page.keyboard.press('Tab');
			await expect(page.locator('a.brand')).toBeFocused();
			await page.keyboard.press('Tab');
			expect(
				await page.evaluate(() => !!document.activeElement?.closest('[data-testid="ascii-field"]'))
			).toBe(false);
			expect(await page.evaluate(() => document.activeElement?.closest('main') !== null)).toBe(
				true
			);
			await page.keyboard.press('Shift+Tab');
			await expect(page.locator('a.brand')).toBeFocused();
			expect(await page.locator('body').ariaSnapshot()).not.toContain('MONTRA0');
			await still.close();

			// Phone, motion on: the text changes, the box does not; a hidden tab stops it.
			const moving = await browser.newContext({
				storageState: SIGNED_OUT,
				viewport: { width: 360, height: 640 },
				reducedMotion: 'no-preference'
			});
			const live = await open(moving);
			await live.goto(`${APP_ORIGIN}${path}`);
			await waitForHydration(live);
			const liveField = live.getByTestId('ascii-field');
			const box = await liveField.boundingBox();
			const formTop = (await live.locator('main').boundingBox())!.y;
			const first = await fieldText(live, 'phone');
			await expect.poll(() => fieldText(live, 'phone'), { timeout: 1000 }).not.toBe(first);
			expect(await liveField.boundingBox()).toEqual(box);
			expect((await live.locator('main').boundingBox())!.y).toBe(formTop);
			await live.evaluate(() => {
				Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
				document.dispatchEvent(new Event('visibilitychange'));
			});
			const paused = await fieldText(live, 'phone');
			// Proves a negative: a hidden tab stops rotating, so wait past a tick and compare.
			await live.waitForTimeout(500);
			expect(await fieldText(live, 'phone')).toBe(paused);
			await moving.close();

			// Desktop: the card left of the 400 px form column, beside Koko, no overlap and no horizontal scroll.
			for (const viewport of [
				{ width: 1024, height: 768 },
				{ width: 1280, height: 800 },
				{ width: 1440, height: 900 }
			]) {
				const wide = await browser.newContext({
					storageState: SIGNED_OUT,
					viewport,
					reducedMotion: 'no-preference'
				});
				const desk = await open(wide);
				await desk.goto(`${APP_ORIGIN}${path}`);
				await waitForHydration(desk);
				const card = (await desk.getByTestId('ascii-field').boundingBox())!;
				expect([card.width, card.height]).toEqual([360, 560]);
				const main = (await desk.locator('main').boundingBox())!;
				const brand = (await desk.locator('.top').boundingBox())!;
				expect(main.width).toBe(400);
				expect(brand.x).toBe(main.x);
				expect(brand.y + brand.height).toBeLessThanOrEqual(main.y);
				expect(card.x + card.width).toBeLessThan(main.x);
				await expect(desk.locator('.hero-art svg.mascot.pose-wave')).toBeVisible();
				const koko = (await desk.locator('.hero-art').boundingBox())!;
				expect(koko.x).toBeGreaterThanOrEqual(main.x);
				const top = main.y;
				const text = await fieldText(desk, 'desktop');
				await expect.poll(() => fieldText(desk, 'desktop'), { timeout: 1000 }).not.toBe(text);
				expect((await desk.locator('main').boundingBox())!.y).toBe(top);
				await expectNoHorizontalScroll(desk);
				await wide.close();
			}
		}
	});

	test('Beranda with no wallet: the first-wallet card and its action fit the first screen at 360 px', async ({
		browser
	}, testInfo) => {
		const context = await browser.newContext({
			storageState: SIGNED_OUT,
			viewport: { width: 360, height: 780 },
			extraHTTPHeaders: { 'cf-connecting-ip': simulatedClientIp(testInfo) }
		});
		const page = await open(context);
		await page.goto(`${APP_ORIGIN}/daftar`);
		await waitForHydration(page);
		await page.getByLabel('Nama').fill('Tanpa Dompet');
		await page.getByLabel('E-mail').fill(`e2e-nowallet-${Date.now()}@example.test`);
		await page.getByLabel('Kata sandi').fill('terang-benderang-8');
		await tickSignUpBoxes(page);
		await page.getByRole('button', { name: 'Daftar' }).click();
		await expect(page).toHaveURL(`${APP_ORIGIN}/`);
		const card = page.getByRole('region', { name: 'Belum ada dompet' });
		await expect(card).toBeVisible();
		// FN-44: Koko waves here now (the scene is gone).
		await expect(card.locator('svg.mascot.pose-wave')).toHaveAttribute('aria-hidden', 'true');
		const action = card.getByRole('link', { name: 'Tambah dompet' });
		await expect(action).toHaveAttribute('href', '/dompet?tambah=1');
		const box = await action.boundingBox();
		expect(box!.y + box!.height).toBeLessThanOrEqual(780);
		expect(box!.height).toBeGreaterThanOrEqual(44);
		await expectNoHorizontalScroll(page);
		await page.screenshot({
			path: 'docs/features/fn-40-visual-refresh/shots/p23-beranda-first-wallet-360.png'
		});
		await context.close();
	});
});
