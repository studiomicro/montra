import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, comparisonKind, hasComparison } from './category';

describe('CATEGORIES', () => {
	it('has the 23 tiles (15 from the design system, 2 from FN-39, 6 from FN-48)', () => {
		expect(Object.keys(CATEGORIES)).toHaveLength(23);
	});
	it('every category colour exists as a token, each a different hue', () => {
		const css = readFileSync('docs/design/tokens.css', 'utf8');
		const hues = Object.values(CATEGORIES).map((c) => {
			const value = css.match(new RegExp(`${c.cssVar}:\\s*(#[0-9a-f]{6});`))?.[1];
			expect(value, c.cssVar).toBeDefined();
			return value;
		});
		expect(new Set(hues).size).toBe(hues.length);
	});
	it('every tile, chart bar and chart series has a colour class for each category', () => {
		const files = {
			'src/lib/ui/kit/CategoryTile.svelte': (k: string) => `.c-${k} {`,
			'src/lib/ui/kit/CategoryBar.svelte': (k: string) => `.c-${k} {`,
			'src/lib/ui/charts/series.css': (k: string) => `.series-${k} {`
		};
		for (const [file, rule] of Object.entries(files)) {
			const css = readFileSync(file, 'utf8');
			for (const key of Object.keys(CATEGORIES)) expect(css, file).toContain(rule(key));
		}
	});
});

describe('comparisonKind', () => {
	it('more / less / same around a threshold', () => {
		expect(comparisonKind(12_000_000, 5_000_000)).toBe('more');
		expect(comparisonKind(-8_000_000, 5_000_000)).toBe('less');
		expect(comparisonKind(4_999_999, 5_000_000)).toBe('same');
		expect(comparisonKind(-5_000_000, 5_000_000)).toBe('same');
	});
});

describe('hasComparison', () => {
	it('hides the line when nothing was spent in either period', () => {
		expect(hasComparison(0, 0)).toBe(false);
	});
	it('compares when either period has money, or the current total is too large to show', () => {
		expect(hasComparison(0, -2_500_000)).toBe(true);
		expect(hasComparison(2_500_000, 2_500_000)).toBe(true);
		expect(hasComparison(2_500_000, 0)).toBe(true);
		expect(hasComparison(null, 0)).toBe(true);
	});
});
