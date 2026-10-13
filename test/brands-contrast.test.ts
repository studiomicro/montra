import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRANDS } from '#lib/shared/brands';
import { contrastRatio, readTokens } from '#lib/shared/contrast';

/** FN-43: every brand badge in every theme (the same blocks test/contrast.test.ts reads). */
const css = readFileSync('docs/design/tokens.css', 'utf8');
const light = readTokens(css, ':root {');
const dark = { ...light, ...readTokens(css, ":root[data-theme='dark'] {") };
const monoLight = { ...light, ...readTokens(css, ":root[data-theme='mono'] {") };
const monoDark = {
	...light,
	...readTokens(css, ":root:not([data-theme='light']) {"),
	...readTokens(css, ":root[data-theme='mono'] {"),
	...readTokens(css, "@media (prefers-color-scheme: dark) {\n\t:root[data-theme='mono'] {")
};
/** FN-46 Pro themes: their light half over light, their dark half over the dark scheme and the light half. */
const proTheme = (name: string) => {
	const lo = readTokens(css, `:root[data-theme='${name}'] {`);
	return {
		light: { ...light, ...lo },
		dark: {
			...light,
			...readTokens(css, ":root:not([data-theme='light']) {"),
			...lo,
			...readTokens(css, `@media (prefers-color-scheme: dark) {\n\t:root[data-theme='${name}'] {`)
		}
	};
};
const gold = proTheme('gold');
const emerald = proTheme('emerald');

/** `share` of `a` over `b`, as `color-mix(in srgb, a share, b)`. */
function mix(a: string, b: string, share: number): string {
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
}

describe.each([
	['light', light],
	['dark', dark],
	['mono-light', monoLight],
	['mono-dark', monoDark],
	['gold', gold.light],
	['gold-dark', gold.dark],
	['emerald', emerald.light],
	['emerald-dark', emerald.dark]
])('brand badges (%s)', (_name, tokens) => {
	it.each(BRANDS.map((b) => b.id))(
		'%s: --ink on the 16 % tint ≥ 4.5, the bar on --bg ≥ 3',
		(id) => {
			const hue = tokens[`--badge-${id}`];
			expect(hue, id).toBeDefined();
			const tile = mix(hue as string, tokens['--bg'] as string, 0.16);
			expect(contrastRatio(tokens['--ink'] as string, tile)).toBeGreaterThanOrEqual(4.5);
			// The Alur uang wallet bar (WCAG 1.4.11).
			expect(contrastRatio(hue as string, tokens['--bg'] as string)).toBeGreaterThanOrEqual(3);
		}
	);
});
