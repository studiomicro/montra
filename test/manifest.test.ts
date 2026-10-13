import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, pngSize } from '../scripts/png.ts';
import { SHOTS } from '../scripts/capture-store-screenshots.ts';
import {
	SPLASH_BUDGET_BYTES,
	SPLASH_DEVICES,
	splashFile
} from '../scripts/generate-splash-screens.ts';
import { assertLocalBaseUrl } from '../scripts/local-guard.ts';
import { manifestBody } from '#lib/server/pwa/manifest';
import { SPLASH_LINKS, splashMedia } from '#lib/shared/splash';
import { SPLASH_SCREENS } from '#lib/shared/splash-screens';

// FN-13b criteria 5-9 and 30, offline: the manifest file and the PNG headers, no server.

interface Icon {
	src: string;
	sizes?: string;
	type?: string;
	purpose?: string;
}
interface Manifest {
	[key: string]: unknown;
	description: string;
	icons: Icon[];
	shortcuts: {
		name: string;
		short_name: string;
		description: string;
		url: string;
		icons: Icon[];
	}[];
	screenshots: {
		src: string;
		sizes: string;
		type: string;
		form_factor: string;
		label: string;
	}[];
}

// FN-46: the manifest is served by src/routes/manifest.webmanifest/+server.ts from this file (no longer static/).
const MANIFEST_FILE = 'src/lib/server/pwa/manifest.webmanifest';
const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
const file = (src: string) => join('static', src);
const size = (png: { width: number; height: number }) => `${png.width}x${png.height}`;

describe('manifest: unchanged identity', () => {
	it('keeps id, start_url, scope, display and orientation, and has no share target', () => {
		expect(manifest).toMatchObject({
			id: '/',
			start_url: '/',
			scope: '/',
			display: 'standalone',
			orientation: 'portrait',
			background_color: '#ffffff',
			theme_color: '#ffffff'
		});
		expect(manifest).not.toHaveProperty('share_target');
	});

	it('has the store categories, the explicit prefer_related_applications and a short description', () => {
		expect(manifest.categories).toEqual(['finance', 'productivity']);
		expect(manifest.prefer_related_applications).toBe(false);
		expect(manifest.description.length).toBeLessThan(324);
	});
});

describe('manifest icons', () => {
	it('lists 192 and 512 any, 192 and 512 maskable and a 512 monochrome, each of its stated size', () => {
		expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
			'192x192 any',
			'512x512 any',
			'192x192 maskable',
			'512x512 maskable',
			'512x512 monochrome'
		]);
		for (const icon of manifest.icons) {
			expect(icon.type).toBe('image/png');
			expect(size(pngSize(readFileSync(file(icon.src)))), icon.src).toBe(icon.sizes);
		}
	});

	it('never declares "any maskable" together', () => {
		for (const icon of manifest.icons)
			expect(icon.purpose).not.toMatch(/any\s+maskable|maskable\s+any/);
	});

	it('the monochrome icon has transparent background pixels', () => {
		const png = decodePng(readFileSync('static/icons/icon-monochrome-512.png'));
		const alphas = new Set<number>();
		for (let i = 3; i < png.data.length; i += 4) alphas.add(png.data[i]!);
		expect(alphas.has(0)).toBe(true);
		expect(alphas.has(255)).toBe(true);
	});
});

describe('manifest per account (FN-46 Part 3)', () => {
	it('Gratis (and signed out, which hooks.server.ts treats as Gratis): byte-identical to the file', () => {
		expect(manifestBody('gratis')).toBe(readFileSync(MANIFEST_FILE, 'utf8'));
		expect(existsSync('static/manifest.webmanifest')).toBe(false);
	});

	it.each(['pro', 'agen'] as const)(
		'%s: the two "any" icons are the crowned Koko; sizes, purposes and everything else unchanged',
		(plan) => {
			const pro = JSON.parse(manifestBody(plan)) as Manifest;
			expect(pro.icons.map((i) => i.src)).toEqual([
				'/icons/icon-192-pro.png',
				'/icons/icon-512-pro.png',
				'/icons/icon-maskable-192.png',
				'/icons/icon-maskable-512.png',
				'/icons/icon-monochrome-512.png'
			]);
			expect(pro.icons.map((i) => [i.sizes, i.type, i.purpose])).toEqual(
				manifest.icons.map((i) => [i.sizes, i.type, i.purpose])
			);
			for (const icon of pro.icons)
				expect(size(pngSize(readFileSync(file(icon.src)))), icon.src).toBe(icon.sizes);
			expect({ ...pro, icons: [] }).toEqual({ ...manifest, icons: [] });
		}
	);

	it('Agen gets exactly the Pro manifest (one look for both paid plans)', () => {
		expect(manifestBody('agen')).toBe(manifestBody('pro'));
	});
});

describe('manifest shortcuts', () => {
	it('are Tambah transaksi, Suara, Struk, Tanya in that order, each a route that exists, with no query', () => {
		expect(manifest.shortcuts.map((s) => s.name)).toEqual([
			'Tambah transaksi',
			'Suara',
			'Struk',
			'Tanya'
		]);
		expect(manifest.shortcuts.map((s) => s.url)).toEqual([
			'/riwayat/baru',
			'/riwayat/suara',
			'/riwayat/struk',
			'/tanya'
		]);
		for (const s of manifest.shortcuts) {
			expect(s.short_name && s.description, s.name).toBeTruthy();
			expect(s.url.startsWith('/') && !s.url.includes('?'), s.url).toBe(true);
			expect(existsSync(join('src/routes/(app)', s.url, '+page.svelte')), s.url).toBe(true);
		}
	});

	it('each has one 96x96 PNG icon that exists', () => {
		for (const s of manifest.shortcuts) {
			expect(s.icons, s.name).toHaveLength(1);
			expect(s.icons[0]!.sizes).toBe('96x96');
			expect(size(pngSize(readFileSync(file(s.icons[0]!.src))))).toBe('96x96');
		}
	});
});

describe('manifest screenshots', () => {
	const shots = manifest.screenshots;

	it('every entry has src, sizes, PNG type, form_factor and label, and its file is exactly that size', () => {
		for (const s of shots) {
			expect(s.src && s.sizes && s.label, s.src).toBeTruthy();
			expect(s.type).toBe('image/png');
			expect(['narrow', 'wide']).toContain(s.form_factor);
			expect(size(pngSize(readFileSync(file(s.src)))), s.src).toBe(s.sizes);
		}
	});

	it('each side is 320-3840 px, the long side at most 2.3 times the short side', () => {
		for (const s of shots) {
			const [w, h] = s.sizes.split('x').map(Number) as [number, number];
			for (const side of [w, h]) expect(side >= 320 && side <= 3840, s.src).toBe(true);
			expect(Math.max(w, h) / Math.min(w, h), s.src).toBeLessThanOrEqual(2.3);
		}
	});

	it('one aspect ratio per form factor; at least one narrow and one wide; at most 8', () => {
		for (const factor of ['narrow', 'wide']) {
			const ratios = shots
				.filter((s) => s.form_factor === factor)
				.map((s) => {
					const [w, h] = s.sizes.split('x').map(Number) as [number, number];
					return w / h;
				});
			expect(ratios.length, factor).toBeGreaterThanOrEqual(1);
			expect(new Set(ratios).size, factor).toBe(1);
		}
		expect(shots.length).toBeLessThanOrEqual(8);
	});

	it('are the images the capture script writes, with its labels', () => {
		expect(shots.map((s) => [s.src, s.form_factor, s.label])).toEqual(
			SHOTS.map((s) => [`/${s.file}`, s.formFactor, s.label])
		);
		for (const [i, shot] of SHOTS.entries())
			expect(shots[i]!.sizes).toBe(`${shot.width * shot.scale}x${shot.height * shot.scale}`);
	});

	it('every image carries the "Data demo" ribbon: dark band pixels in the top-right corner', () => {
		for (const s of shots) {
			const png = decodePng(readFileSync(file(s.src)));
			// The ribbon is a #171717 diagonal band in the top-right corner; count its pixels there.
			const box = Math.round(Math.min(png.width, png.height) * 0.2);
			let ink = 0;
			for (let y = 0; y < box; y++)
				for (let x = png.width - box; x < png.width; x++) {
					const i = (y * png.width + x) * 4;
					if (png.data[i] === 0x17 && png.data[i + 1] === 0x17 && png.data[i + 2] === 0x17) ink++;
				}
			expect(ink / (box * box), s.src).toBeGreaterThan(0.05);
		}
	});

	it('the capture script refuses a non-localhost base URL', () => {
		expect(() => assertLocalBaseUrl('https://montra.example')).toThrow(/Refusing/);
		expect(() => assertLocalBaseUrl('http://localhost:8787')).not.toThrow();
	});
});

describe('splash images (FN-13b)', () => {
	const dirBytes = (dir: string) =>
		readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);

	it('the generated table is the script device list: one file per scheme, pixel size in the name', () => {
		expect(
			SPLASH_SCREENS.map(({ width, height, scale, light, dark }) => ({
				width,
				height,
				scale,
				light,
				dark
			}))
		).toEqual(
			SPLASH_DEVICES.map((d) => ({
				width: d.width,
				height: d.height,
				scale: d.scale,
				light: `/${splashFile(d, 'light')}`,
				dark: `/${splashFile(d, 'dark')}`
			}))
		);
		expect(SPLASH_SCREENS).toHaveLength(18);
	});

	it('every file exists as a PNG of exactly width*scale by height*scale', () => {
		for (const screen of SPLASH_SCREENS)
			for (const scheme of ['light', 'dark'] as const) {
				const png = pngSize(readFileSync(file(screen[scheme])));
				expect(size(png), screen[scheme]).toBe(
					`${screen.width * screen.scale}x${screen.height * screen.scale}`
				);
			}
		expect(readdirSync('static/splash')).toHaveLength(36);
	});

	it('every row is portrait, and no two rows share a size and scale (the media query would clash)', () => {
		for (const d of SPLASH_DEVICES) expect(d.height).toBeGreaterThan(d.width);
		const keys = SPLASH_DEVICES.map((d) => `${d.width}x${d.height}@${d.scale}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('static/splash stays within the 1.5 MB budget, static/screenshots within 1 MB', () => {
		expect(SPLASH_BUDGET_BYTES).toBe(1_500_000);
		expect(dirBytes('static/splash')).toBeLessThanOrEqual(1_500_000);
		expect(dirBytes('static/screenshots')).toBeLessThanOrEqual(1_000_000);
	});

	it('the head links name the device size, ratio, portrait and scheme; light before dark', () => {
		expect(SPLASH_LINKS).toHaveLength(36);
		expect(SPLASH_LINKS[0]).toEqual({
			href: '/splash/splash-1320x2868-light.png',
			media:
				'(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)'
		});
		expect(SPLASH_LINKS[1]!.media).toMatch(/prefers-color-scheme: dark\)$/);
		for (const link of SPLASH_LINKS)
			expect(link.media).toMatch(
				/^\(device-width: \d+px\) and \(device-height: \d+px\) and \(-webkit-device-pixel-ratio: [23]\) and \(orientation: portrait\) and \(prefers-color-scheme: (light|dark)\)$/
			);
		expect(splashMedia(SPLASH_SCREENS[17]!, 'dark')).toContain('(device-width: 810px)');
	});
});
