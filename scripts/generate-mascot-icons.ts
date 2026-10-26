import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ICONS as GLYPHS, type IconName } from '../src/lib/ui/icons.ts';
import { bounds, crown, GRID, POSES, runs, type Pixel } from '../src/lib/ui/kit/mascot/poses.ts';

/**
 * FN-44 Part 5: Koko's idle pose as the favicon and the home-screen icons. Run by hand (or in CI) only when Koko's
 * pixels change, then commit the outputs; never part of `npm run gates` or `npm run build`:
 *
 *   node scripts/generate-mascot-icons.ts
 *
 * The favicon is plain SVG text. The PNGs are screenshots of an SVG in Playwright's Chromium (the
 * `@playwright/test` devDependency; its browser and system libraries must be installed): integer pixel cells with
 * crisp edges and no timestamp or randomness, so the same pose gives the same bytes on the same Chromium.
 *
 * FN-13b adds a maskable 192, a monochrome 512 (Koko's silhouette, alpha only, for Android's themed icons) and four
 * 96 px shortcut icons (the app's own glyphs on the white tile) for the manifest's `shortcuts`.
 *
 * A favicon and an app icon cannot follow the page's theme, so they carry the light theme's colours
 * (docs/design/tokens.css) — the one place Koko's colours are written out.
 *
 * FN-46 adds the Pro look's three icons (`PRO_ICONS`): the same Koko wearing the crown (poses.ts `crown`) in the
 * light --pro gold (`PRO`). Served by the manifest route and the apple-touch-icon link only to a paid account.
 */

const LIGHT: Record<Pixel, string> = {
	o: '#171717', // --ink
	b: '#6c63f0', // --accent
	l: '#aea9f7', // color-mix(--accent 55%, --bg)
	c: '#ffffff', // --bg
	s: '#3a3a3c', // --ink-2
	e: '#171717', // --ink
	g: '#ffffff', // --bg
	p: '#f59ac7' // color-mix(--cat-hadiah 55%, --bg)
};

/** FN-46: the crown's colour in the Pro icons (the light theme's --pro). */
const PRO = { crown: '#a2760a' } as const;

const FRAME = POSES.idle[0]!;

export interface IconSpec {
	/** Path under static/. */
	file: string;
	size: number;
	/** Pixels per grid cell (an integer: every cell is whole device pixels). */
	cell: number;
	/**
	 * `rounded`: a white rounded square on transparency (purpose "any"). `full`: white to every edge (maskable,
	 * whose launcher crops it to a shape; apple-touch-icon, where iOS paints transparency black). `none`:
	 * transparent, and Koko as a single-colour silhouette (the monochrome icon: the launcher uses only the alpha).
	 */
	background: 'rounded' | 'full' | 'none';
	/** FN-46: Koko wears the Pro crown (the box to centre then includes it). */
	crown?: boolean;
}

/**
 * Maskable: Koko's box is 20×22 cells × 12 px = 240×264 px, so its corners lie 178 px from the centre — inside the
 * 204.8 px safe-zone circle (the centre 80 % of 512 px). test/icons.test.ts checks the generated pixels.
 */
export const ICONS: IconSpec[] = [
	{ file: 'icons/icon-192.png', size: 192, cell: 6, background: 'rounded' },
	{ file: 'icons/icon-512.png', size: 512, cell: 16, background: 'rounded' },
	{ file: 'icons/icon-maskable-512.png', size: 512, cell: 12, background: 'full' },
	// 192 × 0.4 = 76.8 px safe radius; Koko's corners lie 14.9 cells from the centre: 5 px cells give 74.3 px.
	{ file: 'icons/icon-maskable-192.png', size: 192, cell: 5, background: 'full' },
	{ file: 'icons/apple-touch-icon.png', size: 180, cell: 6, background: 'full' }
];

/**
 * FN-46 (owner decision 3): exactly these three Pro icons — no maskable or monochrome Pro set, whose launcher
 * masks and silhouettes would clip or flatten the crown. Same sizes and cells as their Gratis twins.
 */
export const PRO_ICONS: IconSpec[] = [
	{ file: 'icons/icon-192-pro.png', size: 192, cell: 6, background: 'rounded', crown: true },
	{ file: 'icons/icon-512-pro.png', size: 512, cell: 16, background: 'rounded', crown: true },
	{ file: 'icons/apple-touch-icon-pro.png', size: 180, cell: 6, background: 'full', crown: true }
];

/**
 * The monochrome icon (Android themed icons use only its alpha). Same safe-zone cell size as the 512 maskable
 * icon, because a launcher masks it to a shape too.
 */
const MONOCHROME_ICON: IconSpec = {
	file: 'icons/icon-monochrome-512.png',
	size: 512,
	cell: 12,
	background: 'none'
};

/** One manifest shortcut's icon: a 96 px white tile with one of the app's 24×24 stroke glyphs (src/lib/ui/icons.ts). */
interface ShortcutIconSpec {
	file: string;
	glyph: IconName;
}

const SHORTCUT_ICON_SIZE = 96;

const SHORTCUT_ICONS: ShortcutIconSpec[] = [
	{ file: 'icons/shortcut-tambah.png', glyph: 'plus' },
	{ file: 'icons/shortcut-suara.png', glyph: 'mic' },
	{ file: 'icons/shortcut-struk.png', glyph: 'receipt' },
	{ file: 'icons/shortcut-tanya.png', glyph: 'sparkle' }
];

/**
 * The idle frame as rects in grid units: filled with the light colours, or (silhouette) one colour without the
 * cut-outs; with `crowned`, the Pro crown on top.
 */
function koko(silhouette = false, crowned = false): string {
	const body = runs(FRAME)
		.filter((r) => !silhouette || r.pixel !== 'c')
		.map(
			(r) =>
				`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${silhouette ? '#000000' : LIGHT[r.pixel]}"/>`
		)
		.join('');
	if (!crowned) return body;
	return (
		body +
		crown(FRAME)
			.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${PRO.crown}"/>`)
			.join('')
	);
}

/** The box to centre: Koko's drawn pixels, and the crown's rows above them when it is worn. */
function iconBox(spec: IconSpec): { x: number; y: number; w: number; h: number } {
	const box = bounds(FRAME);
	if (!spec.crown) return box;
	const top = Math.min(...crown(FRAME).map((r) => r.y));
	return { ...box, y: top, h: box.h + (box.y - top) };
}

/** static/favicon.svg: the idle frame on its own grid, no background (it sits on the browser's tab strip). */
export function faviconSvg(): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges">${koko()}</svg>\n`;
}

/** One icon as an SVG of `size` px: the background, and Koko's drawn pixels centred on whole cells. */
export function iconSvg(spec: IconSpec): string {
	const box = iconBox(spec);
	const left = Math.floor((spec.size - box.w * spec.cell) / 2) - box.x * spec.cell;
	const top = Math.floor((spec.size - box.h * spec.cell) / 2) - box.y * spec.cell;
	const radius = spec.background === 'rounded' ? Math.round(spec.size * 0.22) : 0;
	const background =
		spec.background === 'none'
			? ''
			: `<rect width="${spec.size}" height="${spec.size}" rx="${radius}" fill="#ffffff"/>`;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${spec.size}" height="${spec.size}" viewBox="0 0 ${spec.size} ${spec.size}">` +
		background +
		`<g shape-rendering="crispEdges" transform="translate(${left} ${top}) scale(${spec.cell})">${koko(spec.background === 'none', spec.crown)}</g>` +
		`</svg>`
	);
}

/** A shortcut icon as an SVG: the rounded white tile (like the 'any' icons) and the glyph in ink, centred. */
function shortcutIconSvg(spec: ShortcutIconSpec): string {
	const size = SHORTCUT_ICON_SIZE;
	const glyph = 56;
	const offset = (size - glyph) / 2;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
		`<rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="#ffffff"/>` +
		`<g transform="translate(${offset} ${offset}) scale(${glyph / GRID})" fill="none" stroke="${LIGHT.o}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
		`<path d="${GLYPHS[spec.glyph]}"/></g></svg>`
	);
}

async function main(staticDir: string) {
	writeFileSync(join(staticDir, 'favicon.svg'), faviconSvg());
	const { chromium } = await import('@playwright/test');
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ deviceScaleFactor: 1 });
		const shoot = async (file: string, size: number, svg: string, transparent: boolean) => {
			await page.setViewportSize({ width: size, height: size });
			await page.setContent(
				`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`
			);
			const out = join(staticDir, file);
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(
				out,
				await page.screenshot({
					clip: { x: 0, y: 0, width: size, height: size },
					omitBackground: transparent
				})
			);
			console.log(`wrote static/${file}`);
		};
		for (const spec of [...ICONS, ...PRO_ICONS, MONOCHROME_ICON])
			await shoot(spec.file, spec.size, iconSvg(spec), spec.background !== 'full');
		for (const spec of SHORTCUT_ICONS)
			await shoot(spec.file, SHORTCUT_ICON_SIZE, shortcutIconSvg(spec), true);
	} finally {
		await browser.close();
	}
	console.log('wrote static/favicon.svg');
}

if (import.meta.main) await main(join(import.meta.dirname, '..', 'static'));
