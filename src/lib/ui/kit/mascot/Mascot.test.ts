import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import EmptyState from '../../shell/EmptyState.svelte';
import Mascot from '../Mascot.svelte';
import type { Component } from 'svelte';
import ProLookHarness from '../../../../../test/helpers/ProLookHarness.svelte';
import { bounds, crown, GRID, MASCOT_POSES, POSES, runs, type MascotPose } from './poses';

/** The colour classes Mascot.svelte styles, and the token each must resolve to. */
const TOKEN: Record<string, string> = {
	'k-ink': '--ink',
	'k-body': '--accent',
	'k-cut': '--k-light',
	'k-shade': '--ink-2',
	'k-eye': '--k-eye',
	'k-glint': '--k-glint'
};
/** Classes mixed from tokens (color-mix of a theme token and Koko's light). */
const MIXED: Record<string, string> = { 'k-lit': '--accent', 'k-cheek': '--cat-hadiah' };

const svgOf = (pose: MascotPose, alt?: string) =>
	render(Mascot, { props: { pose, alt, size: 40 } }).body;

const cssOf = (file: string) =>
	compile(readFileSync(file, 'utf8'), { filename: file, css: 'external' }).css?.code ?? '';

describe('Koko pixel data', () => {
	it.each(MASCOT_POSES)('%s: every frame is a 24×24 grid of known pixel letters', (pose) => {
		const frames = POSES[pose];
		expect(frames.length).toBeGreaterThanOrEqual(1);
		for (const frame of frames) {
			expect(frame).toHaveLength(GRID);
			for (const row of frame) expect(row).toMatch(/^[.oblcsegp]{24}$/);
			// A whole coin with an outline and a body: never an empty or a one-colour frame.
			const drawn = frame.join('');
			expect(drawn).toContain('o');
			expect(drawn).toContain('b');
		}
	});

	it.each(MASCOT_POSES)(
		'%s: the resting frame (0) is the whole coin standing, eyes visible',
		(pose) => {
			const rest = POSES[pose][0]!;
			const box = bounds(rest);
			expect(box.w).toBeGreaterThanOrEqual(20);
			expect(box.h).toBeGreaterThanOrEqual(20);
			// Two eyes on the face, whatever the pose, and pink cheeks.
			expect(rest.slice(10, 14).join('')).toMatch(/e/);
			expect(rest[14]!.match(/p/g)).toHaveLength(4);
		}
	);

	it('the poses differ where they should: a blink shuts the eyes, sleep keeps them shut, a spin narrows', () => {
		const [open, shut] = POSES.idle;
		expect(open).not.toEqual(shut);
		// Open eyes are three rows high with a glint; shut ones are a curve on rows 12–13, never on row 11.
		expect(open![11]).toContain('e');
		expect(open!.slice(10, 14).join('')).toContain('g');
		expect(shut![11]).not.toMatch(/[eg]/);
		for (const frame of POSES.sleep) expect(frame[11]).not.toMatch(/[eg]/);
		const widths = POSES.celebrate.map((f) => bounds(f.slice(0, 22)).w);
		expect(widths[1]).toBeGreaterThan(widths[2]!);
		expect(widths[2]).toBeGreaterThan(widths[3]!);
		// In the air, the hop's frame sits higher than the standing one.
		expect(bounds(POSES.hop[2]!).y).toBeLessThan(bounds(POSES.hop[0]!).y);
	});

	it('runs cover exactly the drawn pixels of a frame', () => {
		for (const pose of MASCOT_POSES)
			for (const frame of POSES[pose]) {
				const rebuilt = Array.from({ length: GRID }, () => Array<string>(GRID).fill('.'));
				for (const r of runs(frame))
					for (let x = r.x; x < r.x + r.w; x++) rebuilt[r.y]![x] = r.pixel;
				expect(rebuilt.map((row) => row.join(''))).toEqual([...frame]);
			}
	});
});

describe('<Mascot>', () => {
	it.each(MASCOT_POSES)(
		'%s: decorative by default — hidden from assistive technology, never a role="img"',
		(pose) => {
			const svg = svgOf(pose);
			expect(svg).toMatch(/<svg[^>]*aria-hidden="true"/);
			expect(svg).not.toMatch(/role="img"/);
			expect(svg).not.toMatch(/aria-label=/);
		}
	);

	it('with alt text it is one labelled image', () => {
		const svg = svgOf('idle', 'Koko');
		expect(svg).toMatch(/<svg[^>]*role="img"/);
		expect(svg).toMatch(/aria-label="Koko"/);
		expect(svg).not.toMatch(/aria-hidden/);
	});

	it.each(MASCOT_POSES)(
		'%s: no colour in the markup — every pixel is coloured by a theme class',
		(pose) => {
			const svg = svgOf(pose);
			expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(svg).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/i);
			expect(svg).not.toMatch(/\s(?:fill|stroke|style)=/);
			const rects = [...svg.matchAll(/<rect\b[^>]*>/g)].map((m) => m[0]);
			expect(rects.length).toBeGreaterThan(20);
			for (const rect of rects) {
				const classes = rect
					.match(/class="([^"]*)"/)?.[1]
					?.split(/\s+/)
					.filter((c) => !c.startsWith('svelte-'));
				expect(classes, rect).toHaveLength(1);
				expect([...Object.keys(TOKEN), ...Object.keys(MIXED)], rect).toContain(classes![0]);
			}
		}
	);

	it.each(MASCOT_POSES)('%s: draws inline only — no image, link or external reference', (pose) => {
		const svg = svgOf(pose);
		expect(svg).not.toMatch(/<(image|use|foreignObject|script|a)\b/);
		expect(svg).not.toMatch(/href=|url\(/);
	});

	it('square at the asked size, a 24×24 grid with crisp pixels', () => {
		const svg = svgOf('idle');
		expect(svg).toMatch(/<svg[^>]*width="40"[^>]*height="40"/);
		expect(svg).toMatch(/viewBox="0 0 24 24"/);
		expect(cssOf('src/lib/ui/kit/Mascot.svelte')).toMatch(/shape-rendering:\s*crispEdges/);
	});

	it('its stylesheet maps every class to a theme token (no hard-coded colour; light, dark and mono repaint)', () => {
		const css = cssOf('src/lib/ui/kit/Mascot.svelte');
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(css).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/i);
		for (const [cls, token] of Object.entries(TOKEN))
			expect(css, cls).toMatch(new RegExp(`\\.${cls}[^{]*\\{\\s*fill:\\s*var\\(${token}\\);`));
		for (const [cls, token] of Object.entries(MIXED))
			expect(css, cls).toMatch(
				new RegExp(
					`\\.${cls}[^{]*\\{\\s*fill:\\s*color-mix\\(in srgb, var\\(${token}\\) \\d+%, var\\(--k-light\\)\\);`
				)
			);
		// Koko's own properties resolve to theme tokens only.
		for (const prop of ['--k-light', '--k-eye', '--k-glint'])
			expect(css, prop).toMatch(new RegExp(`${prop}:\\s*(?:light-dark\\()?var\\(--`));
	});

	it('frame cuts are steps(1) and only the loading pose has no motion of its own', () => {
		const css = cssOf('src/lib/ui/kit/Mascot.svelte');
		const animations = [...css.matchAll(/\.pose-(\w+)[^{]*\{\s*animation:\s*([^;]+);/g)];
		expect(animations.map((m) => m[1]).sort()).toEqual(
			MASCOT_POSES.filter((p) => p !== 'loading').sort()
		);
		for (const [, , value] of animations) expect(value).toMatch(/steps\(1\)/);
	});

	it.each(MASCOT_POSES)(
		'%s: pixels are stable (snapshot: a change to Koko is a reviewable diff)',
		(pose) => {
			expect(POSES[pose].map((frame) => frame.join('\n')).join('\n\n')).toMatchSnapshot();
		}
	);
});

describe('EmptyState and Koko (FN-44 Part 2)', () => {
	const text = 'Belum ada token';
	const count = (body: string) => ({
		mascot: (body.match(/class="mascot\b/g) ?? []).length,
		scene: (body.match(/class="illustration\b/g) ?? []).length
	});

	it('without `illustration` Koko sleeps above the text, decorative; the text stays the whole message', () => {
		const body = render(EmptyState, { props: { text } }).body;
		expect(count(body)).toEqual({ mascot: 1, scene: 0 });
		expect(body).toMatch(/<svg[^>]*class="mascot pose-sleep[^>]*aria-hidden="true"/);
		expect(body.indexOf('<svg')).toBeLessThan(body.indexOf(text));
	});

	it('an explicit pose shows that pose (the error pages: sad)', () => {
		const body = render(EmptyState, { props: { text, mascot: 'sad' } }).body;
		expect(body).toMatch(/class="mascot pose-sad/);
	});

	it('`mascot={false}` keeps the empty state text only', () => {
		const body = render(EmptyState, { props: { text, mascot: false } }).body;
		expect(body).not.toContain('<svg');
		expect(body).toContain(text);
	});

	it.each([
		'wallet',
		'budget',
		'calendar',
		'parcels',
		'growth',
		'goal',
		'people',
		'history',
		'inbox'
	] as const)(
		'with illustration="%s" the scene shows and Koko does not — never both',
		(illustration) => {
			expect(count(render(EmptyState, { props: { text, illustration } }).body)).toEqual({
				mascot: 0,
				scene: 1
			});
			expect(
				count(render(EmptyState, { props: { text, illustration, mascot: 'sad' } }).body)
			).toEqual({ mascot: 0, scene: 1 });
		}
	);
});

describe('the Pro crown (FN-46 Part 3)', () => {
	const crowned = (pose: MascotPose, pro?: boolean) =>
		render(Mascot, { props: { pose, size: 40, pro } }).body;
	const crownRects = (svg: string) => [...svg.matchAll(/<rect\b[^>]*class="k-crown[^>]*>/g)];
	const inLayout = (pro: boolean, props: Record<string, unknown>, component: unknown = Mascot) =>
		render(ProLookHarness, {
			props: {
				component: component as Component<Record<string, unknown>>,
				pro,
				props
			}
		}).body;

	it.each(MASCOT_POSES)(
		'%s: the crown sits on the head of every frame, right above the outline, centred',
		(pose) => {
			for (const frame of POSES[pose]) {
				const runs = crown(frame);
				const top = frame.findIndex((row) => row.includes('o'));
				expect(runs.length).toBeGreaterThan(0);
				for (const r of runs) {
					expect(r.y).toBeLessThan(top);
					expect(r.y).toBeGreaterThanOrEqual(Math.max(0, top - 3));
					// Never over a drawn pixel of the pose (sparkles, the sleeping z's).
					expect(frame[r.y]!.slice(r.x, r.x + r.w)).toMatch(/^\.+$/);
				}
				expect(Math.max(...runs.map((r) => r.y))).toBe(top - 1);
			}
		}
	);

	it.each(MASCOT_POSES)(
		'%s with pro: crown pixels drawn, coloured only by the k-crown class (no colour in the markup)',
		(pose) => {
			const svg = crowned(pose, true);
			const rects = crownRects(svg);
			expect(rects.length).toBe(POSES[pose].map(crown).flat().length);
			expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(svg).not.toMatch(/\s(?:fill|stroke|style)=/);
		}
	);

	it.each(MASCOT_POSES)('%s without pro (false or omitted): no crown at all', (pose) => {
		expect(crownRects(crowned(pose, false))).toEqual([]);
		expect(crownRects(crowned(pose))).toEqual([]);
		expect(crowned(pose)).toBe(svgOf(pose));
	});

	it('the crown class maps to the --pro token', () => {
		expect(cssOf('src/lib/ui/kit/Mascot.svelte')).toMatch(
			/\.k-crown[^{]*\{\s*fill:\s*var\(--pro\);/
		);
	});

	it('omitted, it follows the (app) layout’s plan; an explicit value wins', () => {
		expect(crownRects(inLayout(true, { pose: 'idle' })).length).toBeGreaterThan(0);
		expect(crownRects(inLayout(false, { pose: 'idle' }))).toEqual([]);
		expect(crownRects(inLayout(true, { pose: 'idle', pro: false }))).toEqual([]);
	});

	it('EmptyState’s sleeping Koko wears it only when the layout’s plan has the Pro look', () => {
		expect(crownRects(inLayout(true, { text: 'Kosong' }, EmptyState)).length).toBeGreaterThan(0);
		expect(crownRects(inLayout(false, { text: 'Kosong' }, EmptyState))).toEqual([]);
	});
});
