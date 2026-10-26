import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import EmptyState from '../shell/EmptyState.svelte';
import Illustration from './Illustration.svelte';
import { SCENES, type IllustrationName } from './illustrations';
import { box, disc, pt } from './illustrations/iso';

const NAMES = Object.keys(SCENES) as IllustrationName[];
/** The colour classes Illustration.svelte styles: faces of the five tones, line details, the blueprint floor. */
const CLASSES = new Set([
	...['n', 'a', 'g', 'p', 'd'].flatMap((t) => [`${t}-t`, `${t}-l`, `${t}-r`]),
	'ink',
	'strong',
	'mark',
	'grid',
	'guide',
	'node',
	'illustration',
	'iso-art',
	'float'
]);

const svgOf = (name: IllustrationName, alt?: string) =>
	render(Illustration, { props: { name, alt } }).body;

describe('isometric geometry', () => {
	it('projects x right-down, y left-down and z straight up', () => {
		expect(pt(0, 0, 0)).toEqual([0, 0]);
		expect(pt(10, 0, 0)).toEqual([8.7, 5]);
		expect(pt(0, 10, 0)).toEqual([-8.7, 5]);
		expect(pt(0, 0, 10)).toEqual([0, -10]);
	});

	it('a box has three closed faces; a disc has a full top ellipse', () => {
		const b = box(0, 0, 0, 10, 10, 10);
		for (const face of [b.top, b.left, b.right]) expect(face).toMatch(/^M.*Z$/);
		const d = disc(0, 0, 0, 10, 4);
		expect(d.top.match(/A/g)).toHaveLength(2);
		expect(d.cy).toBe(-4);
	});
});

describe('<Illustration>', () => {
	it.each(NAMES)(
		'%s: decorative by default — hidden from assistive technology, never a role="img"',
		(name) => {
			const svg = svgOf(name);
			expect(svg).toMatch(/<svg[^>]*aria-hidden="true"/);
			expect(svg).not.toMatch(/role="img"/);
			expect(svg).not.toMatch(/aria-label=/);
		}
	);

	it('with alt text it is one labelled image', () => {
		const svg = svgOf('wallet', 'Dompet kosong');
		expect(svg).toMatch(/<svg[^>]*role="img"/);
		expect(svg).toMatch(/aria-label="Dompet kosong"/);
		expect(svg).not.toMatch(/aria-hidden/);
	});

	it.each(NAMES)(
		'%s: no colour in the markup — every shape is coloured by a theme class',
		(name) => {
			const svg = svgOf(name);
			expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(svg).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/i);
			expect(svg).not.toMatch(/\s(?:fill|stroke|style)=/);
			const shapes = [...svg.matchAll(/<(path|circle|ellipse)\b[^>]*>/g)].map((m) => m[0]);
			expect(shapes.length).toBeGreaterThan(5);
			for (const shape of shapes) {
				const classes = shape
					.match(/class="([^"]*)"/)?.[1]
					?.split(/\s+/)
					.filter((c) => !c.startsWith('svelte-'));
				expect(classes?.length, shape).toBeGreaterThan(0);
				for (const c of classes ?? []) expect(CLASSES.has(c), `${name}: ${c}`).toBe(true);
			}
		}
	);

	it.each(NAMES)('%s: draws inline only — no image, link or external reference', (name) => {
		const svg = svgOf(name);
		expect(svg).not.toMatch(/<(image|use|foreignObject|script|a)\b/);
		expect(svg).not.toMatch(/href=|url\(/);
	});

	it('its stylesheet maps every class to a theme token (no hard-coded colour; light, dark and mono repaint)', () => {
		const file = 'src/lib/ui/kit/Illustration.svelte';
		// FN-54: the tones live in a stylesheet Illustration shares with Beranda's HeroScene.
		const css =
			(compile(readFileSync(file, 'utf8'), { filename: file, css: 'external' }).css?.code ?? '') +
			readFileSync('src/lib/ui/kit/illustrations/tones.css', 'utf8');
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(css).not.toMatch(/\b(?:rgb|hsl)a?\(/i);
		for (const c of CLASSES) {
			if (['illustration', 'iso-art', 'float', 'strong'].includes(c)) continue;
			expect(css, c).toMatch(
				new RegExp(
					`\\.${c}[^{]*\\{[^}]*(?:fill|stroke):\\s*(?:var\\(--|currentColor|color-mix\\(in srgb, var\\(--)`
				)
			);
		}
		// Every tone colour is built from the theme tokens the four themes define.
		const tones = [...css.matchAll(/--[nagpd]-[tlr]:\s*([^;]+);/g)].map((m) => m[1] ?? '');
		expect(tones.length).toBeGreaterThanOrEqual(15);
		for (const value of tones)
			expect(value).toMatch(/var\(--(?:panel|ink|bg|accent|cat-belanja|panel-2)\)/);
	});
});

describe('EmptyState illustration (additive)', () => {
	const text = 'Belum ada dompet. Tambah satu untuk mulai mencatat.';
	// FN-44 owner decision 5 changed this default: without `illustration` Koko sleeps above the text (no scene);
	// `mascot={false}` is the text-only empty state FN-40 had.
	it('without `illustration` an empty state shows no scene: Koko asleep, or text only when opted out', () => {
		const body = render(EmptyState, { props: { text } }).body;
		expect(body).not.toContain('class="illustration');
		expect(body).toMatch(/<svg[^>]*class="mascot pose-sleep[^>]*aria-hidden="true"/);
		expect(body).toContain(text);
		const plain = render(EmptyState, { props: { text, mascot: false } }).body;
		expect(plain).not.toContain('<svg');
		expect(plain).toContain(text);
	});

	it('with one, the scene is aria-hidden and the text stays the only description', () => {
		const body = render(EmptyState, { props: { text, illustration: 'wallet' } }).body;
		expect(body).toMatch(/<svg[^>]*aria-hidden="true"/);
		expect(body.indexOf('<svg')).toBeLessThan(body.indexOf(text));
	});
});

describe('no Rive runtime yet (FN-40 owner decision 4)', () => {
	it('no source file imports @rive-app and package.json has no Rive dependency', () => {
		const files = readdirSync('src', { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && /\.(svelte|ts|js)$/.test(d.name))
			.map((d) => join(d.parentPath, d.name));
		const importing = files.filter((f) => /['"]@rive-app\//.test(readFileSync(f, 'utf8')));
		expect(importing).toEqual([]);
		expect(readFileSync('package.json', 'utf8')).not.toContain('@rive-app');
	});
});
