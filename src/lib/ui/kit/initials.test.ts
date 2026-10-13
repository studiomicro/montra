import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { contrastRatio, readTokens } from '#lib/shared/contrast';
import { SUBSCRIPTION_CATALOGUE } from '#lib/shared/subscriptions-catalogue';
import { CATEGORIES } from './category';
import { initials, initialsColour, INITIALS_PALETTE } from './initials';
import InitialsTile from './InitialsTile.svelte';

describe('initials', () => {
	it.each([
		['Netflix', 'NE'],
		['Disney+ Hotstar', 'DH'],
		['iCloud+', 'IC'],
		['YouTube Premium', 'YP'],
		['  spotify  ', 'SP'],
		['X', 'X'],
		['Microsoft 365', 'M3'],
		['+++', '?'],
		['', '?'],
		['Ésprit dé', 'ÉD']
	])('%j → %s', (name, expected) => {
		expect(initials(name)).toBe(expected);
	});
});

describe('initialsColour', () => {
	it('is stable, case-insensitive and always a palette token', () => {
		expect(initialsColour('Netflix')).toBe(initialsColour('netflix '));
		for (const { name } of SUBSCRIPTION_CATALOGUE)
			expect(INITIALS_PALETTE).toContain(initialsColour(name));
	});

	it('spreads the catalogue over several colours', () => {
		const used = new Set(SUBSCRIPTION_CATALOGUE.map((e) => initialsColour(e.name)));
		expect(used.size).toBeGreaterThanOrEqual(6);
	});

	it('only uses existing category tokens', () => {
		for (const key of INITIALS_PALETTE) expect(Object.keys(CATEGORIES)).toContain(key);
	});
});

describe('InitialsTile', () => {
	it('renders the initials as text, decorative, without any image', () => {
		const html = render(InitialsTile, { props: { name: 'Disney+ Hotstar' } }).body;
		expect(html).toContain('>DH</span>');
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain(`c-${initialsColour('Disney+ Hotstar')}`);
		expect(html).not.toMatch(/<img|<svg|url\(/);
	});
});

describe('AA contrast of tile text (ink on a 16 % tint of the tile colour)', () => {
	const css = readFileSync('docs/design/tokens.css', 'utf8');
	const light = readTokens(css, ':root {');
	const dark = { ...light, ...readTokens(css, ":root[data-theme='dark'] {") };
	const mix = (a: string, b: string, share: number) => {
		const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
		return (
			'#' +
			[0, 1, 2]
				.map((i) =>
					Math.round(ch(a, i) * share + ch(b, i) * (1 - share))
						.toString(16)
						.padStart(2, '0')
				)
				.join('')
		);
	};
	it.each([
		['light', light],
		['dark', dark]
	])('%s theme', (_name, tokens) => {
		for (const key of INITIALS_PALETTE) {
			const tile = mix(tokens[`--cat-${key}`] as string, tokens['--bg'] as string, 0.16);
			expect(contrastRatio(tokens['--ink'] as string, tile), key).toBeGreaterThanOrEqual(4.5);
		}
	});
});
