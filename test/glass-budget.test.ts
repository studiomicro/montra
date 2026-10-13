import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FN-40 Part 4 glass rules, checked statically (DESIGN_SYSTEM.md § Glass).
 *
 * Blur budget: at most 3 backdrop-filter layers on screen. Enforced by design, enumerated here:
 * - page chrome: the tab bar (phone) or the sidebar's sticky bottom (desktop) — never both — plus the sticky
 *   screen title: 2;
 * - in-page glass content (Banner, FloatingCard): counted per route, chrome + content ≤ 3;
 * - an open sheet: app.css drops the blur of every glass surface outside the open dialog (it sits under the
 *   scrim), so the chrome counts 0 and each open sheet 1.
 */
const MAX_BLUR_LAYERS = 3;
const read = (file: string) => readFileSync(file, 'utf8');
const styleOf = (file: string) => /<style>([\s\S]*)<\/style>/.exec(read(file))?.[1] ?? '';
const markupOf = (file: string) => read(file).replace(/<style>[\s\S]*<\/style>/, '');

function files(dir: string, ext: RegExp): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile() && ext.test(d.name))
		.map((d) => join(d.parentPath, d.name));
}

/** Every component that draws the glass material, and what layer it is. */
const GLASS: Record<string, 'chrome' | 'content' | 'sheet'> = {
	'src/lib/ui/shell/TabBar.svelte': 'chrome',
	'src/lib/ui/shell/Sidebar.svelte': 'chrome',
	'src/lib/ui/shell/ScreenTitle.svelte': 'chrome',
	'src/lib/ui/shell/Sheet.svelte': 'sheet',
	'src/lib/ui/kit/Banner.svelte': 'content',
	'src/lib/ui/kit/FloatingCard.svelte': 'content'
};
const appCss = read('src/app.css');

describe('glass material (FN-40)', () => {
	it('backdrop-filter is declared only by the shared .glass rules in app.css', () => {
		const offenders = files('src', /\.(svelte|css)$/)
			.filter((f) => f !== join('src', 'app.css'))
			.filter((f) => /backdrop-filter/.test(read(f)));
		expect(offenders).toEqual([]);
		expect(appCss).toMatch(/\.glass \{[^}]*backdrop-filter: var\(--glass-filter\)/);
	});

	it('the glass surfaces are exactly the enumerated ones', () => {
		const used = files('src', /\.svelte$/)
			.filter((f) => /class="[^"]*\bglass\b/.test(markupOf(f)))
			.sort();
		expect(used).toEqual(Object.keys(GLASS).sort());
	});

	it('the tab bar and the sidebar never show together', () => {
		expect(styleOf('src/lib/ui/shell/TabBar.svelte')).toMatch(
			/@media \(min-width: 1024px\) \{\s*\.tabbar,\s*\.fab \{\s*display: none;/
		);
		expect(styleOf('src/lib/ui/shell/Sidebar.svelte')).toMatch(
			/\.sidebar \{\s*display: none;\s*\}\s*@media \(min-width: 1024px\)/
		);
	});

	it('no app screen exceeds the budget without a sheet', () => {
		const chrome = 2; // nav (tab bar xor sidebar) + one sticky ScreenTitle
		const content = Object.entries(GLASS)
			.filter(([, layer]) => layer === 'content')
			.map(([file]) => file.split('/').pop()?.replace('.svelte', '') ?? '');
		const over = files('src/routes', /\+page\.svelte$/)
			// The /dev/ui component catalogue answers 404 in production (devRoutesEnabled).
			.filter((f) => !f.includes(join('dev', 'ui')))
			.map((f) => {
				const markup = markupOf(f);
				const titles = (markup.match(/<ScreenTitle\b/g) ?? []).length;
				expect(titles, f).toBeLessThanOrEqual(1);
				const layers = chrome + content.filter((c) => markup.includes(`<${c}`)).length;
				return { f, layers };
			})
			.filter(({ layers }) => layers > MAX_BLUR_LAYERS);
		expect(over).toEqual([]);
	});

	it('under an open sheet the page glass drops its blur', () => {
		expect(appCss).toMatch(
			/:root:has\(dialog\[open\]\) \.glass:not\(dialog\[open\], dialog\[open\] \*\) \{[^}]*backdrop-filter: none;/
		);
	});

	it('reduced transparency and no backdrop-filter both show the opaque fallback', () => {
		const fallback =
			/\.glass \{\s*background: var\(--glass-fallback\);\s*box-shadow: var\(--shadow-float\);/;
		const media = appCss.split('@media (prefers-reduced-transparency: reduce) {')[1] ?? '';
		const supports =
			appCss.split(
				'@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {'
			)[1] ?? '';
		expect(media).toMatch(fallback);
		expect(media).toMatch(/backdrop-filter: none;/);
		expect(supports).toMatch(fallback);
	});

	it.each(['src/lib/ui/kit/Chip.svelte', 'src/lib/ui/shell/TabBar.svelte'])(
		'%s: the press lift exists only without reduced motion',
		(file) => {
			const css = styleOf(file);
			const lift = /:active \{\s*box-shadow:[^;]*var\(--glass-shadow\)/;
			const [outside, inside] = css.split('@media (prefers-reduced-motion: no-preference) {');
			expect(inside).toMatch(lift);
			expect(outside).not.toMatch(lift);
		}
	);
});
