import { readFileSync } from 'node:fs';
import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { cssOf, declarations } from '../../../../test/helpers/css';
import Harness from '../../../../test/helpers/I18nHarness.svelte';
import { stripComments } from '../../../../test/helpers/html';
import MascotLoading from './MascotLoading.svelte';

const FILE = 'src/lib/ui/kit/MascotLoading.svelte';
const html = (active: boolean, locale: 'id' | 'en' = 'id') =>
	render(Harness, {
		props: {
			component: MascotLoading as unknown as Component<Record<string, unknown>>,
			locale,
			props: { active }
		}
	}).body;

const rules = declarations(cssOf(FILE));
const NO_PREFERENCE = /prefers-reduced-motion:\s*no-preference/;
const gated = (d: { context: string[] }) => d.context.some((c) => NO_PREFERENCE.test(c));
/** The declarations for the walking art and the text, outside any media query (the reduced-motion path). */
const ungated = (selector: string) =>
	rules.filter((d) => !gated(d) && d.context.at(-1)?.startsWith(selector));

describe('MascotLoading (FN-44 Part 4)', () => {
	it('idle page: renders nothing at all — no element, no svg, no animation', () => {
		const body = html(false);
		expect(body).not.toContain('nav-loading');
		expect(body).not.toContain('<svg');
		expect(stripComments(body).trim()).toBe('');
	});

	it('in flight: Koko (loading pose, decorative) and the text "Memuat…" / "Loading…"', () => {
		const body = html(true);
		expect(body).toMatch(/<svg[^>]*class="mascot pose-loading[^>]*aria-hidden="true"/);
		expect(body).toContain('Memuat…');
		expect(html(true, 'en')).toContain('Loading…');
	});

	it('the walk loops only while motion is allowed; nothing else in the file animates', () => {
		const animations = rules.filter((d) => d.property.startsWith('animation'));
		expect(animations.length).toBeGreaterThan(0);
		for (const d of animations) expect(gated(d), d.value).toBe(true);
		const walk = animations.find((d) => d.context.at(-1)?.includes('.strip'));
		expect(walk?.value).toMatch(/steps\(1\)\s+infinite/);
	});

	it('reduced motion (and no media support): the art is not displayed — plain text only, never a still mascot', () => {
		expect(ungated('.art').map((d) => `${d.property}: ${d.value}`)).toEqual(['display: none']);
		// The text is visible by default; it is only visually hidden while Koko walks.
		expect(ungated('.text')).toEqual([]);
		const shown = rules.filter((d) => gated(d) && d.context.at(-1)?.startsWith('.art'));
		expect(shown.map((d) => `${d.property}: ${d.value}`)).toContain('display: block');
		const hidden = rules.filter((d) => gated(d) && d.context.at(-1)?.startsWith('.text'));
		expect(hidden.map((d) => d.property)).toContain('clip-path');
	});

	it('the (app) layout shows it exactly while a client-side navigation is in flight', () => {
		const layout = readFileSync('src/routes/(app)/+layout.svelte', 'utf8');
		expect(layout).toMatch(/<MascotLoading active=\{navigating\.to !== null\} \/>/);
		expect(layout).toMatch(/import \{ navigating \} from '\$app\/state';/);
	});
});
