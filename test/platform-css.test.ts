import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments as stripHtmlComments, stripCssComments } from './helpers/html';

// FN-13b criterion 23: three source rules that keep the app usable on a notched phone, and keep iOS from zooming.
//   1. no `100vh` (it is taller than the visible screen under mobile browser chrome; use `dvh`);
//   2. `env(safe-area-inset-*)` is read once, in app.css's `--sai-*` variables; components use the variables, so a
//      test can emulate a notch by overriding them;
//   3. the viewport never disables zoom (`maximum-scale`, `user-scalable`).
// Each scanner is shown to catch a planted violation first, then runs over src/.

const stripComments = (text: string) => stripHtmlComments(stripCssComments(text));

/** `--sai-*` definitions in app.css: the only place the raw env() may appear. */
const SAI_DEFINITION = /--sai-(top|right|bottom|left):\s*env\(safe-area-inset-\1,\s*0px\);/g;

export const scanners = {
	viewportHeight: (text: string) => stripComments(text).match(/\b100vh\b/g) ?? [],
	rawSafeArea: (text: string) =>
		stripComments(text)
			.replace(SAI_DEFINITION, '')
			.match(/env\(\s*safe-area-inset-/g) ?? [],
	zoomLock: (text: string) =>
		stripComments(text).match(/\b(?:user-scalable|maximum-scale)\b/g) ?? []
};

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(
			(d) => d.isFile() && /\.(svelte|ts|css|html)$/.test(d.name) && !/\.test\.ts$/.test(d.name)
		)
		.map((d) => join(d.parentPath, d.name));
}

const FILES = sourceFiles('src').map((file) => [file, readFileSync(file, 'utf8')] as const);

describe('scanners catch a planted violation', () => {
	it('100vh, also inside calc()', () => {
		expect(scanners.viewportHeight('.a { min-height: 100vh; }')).toHaveLength(1);
		expect(scanners.viewportHeight('.a { height: calc(100vh - 24px); }')).toHaveLength(1);
		expect(scanners.viewportHeight('.a { height: 100dvh; max-height: 40vh; }')).toHaveLength(0);
		expect(scanners.viewportHeight('/* never 100vh */ .a { height: 100dvh; }')).toHaveLength(0);
	});
	it('a raw env(safe-area-inset-*), but not the app.css definitions', () => {
		expect(
			scanners.rawSafeArea('.a { padding-bottom: env(safe-area-inset-bottom); }')
		).toHaveLength(1);
		expect(scanners.rawSafeArea('.a { top: calc(env( safe-area-inset-top) + 8px); }')).toHaveLength(
			1
		);
		expect(
			scanners.rawSafeArea(
				':root { --sai-top: env(safe-area-inset-top, 0px); }\n.a { top: var(--sai-top); }'
			)
		).toHaveLength(0);
		// A definition that points at another side is not the definition.
		expect(
			scanners.rawSafeArea(':root { --sai-top: env(safe-area-inset-bottom, 0px); }')
		).toHaveLength(1);
	});
	it('user-scalable and maximum-scale', () => {
		expect(
			scanners.zoomLock('<meta name="viewport" content="width=device-width, user-scalable=no" />')
		).toHaveLength(1);
		expect(scanners.zoomLock('content="initial-scale=1, maximum-scale=1"')).toHaveLength(1);
		expect(scanners.zoomLock('content="width=device-width, initial-scale=1"')).toHaveLength(0);
	});
});

describe('src/', () => {
	it('scans the app (guard against an empty scan)', () => {
		expect(FILES.length).toBeGreaterThan(200);
		expect(FILES.some(([file]) => file === join('src', 'app.css'))).toBe(true);
		expect(FILES.some(([file]) => file === join('src', 'app.html'))).toBe(true);
	});

	it('uses no 100vh', () => {
		expect(
			FILES.filter(([, text]) => scanners.viewportHeight(text).length > 0).map(([f]) => f)
		).toEqual([]);
	});

	it('reads env(safe-area-inset-*) only in the four --sai-* definitions of app.css', () => {
		expect(
			FILES.filter(([, text]) => scanners.rawSafeArea(text).length > 0).map(([f]) => f)
		).toEqual([]);
		const css = FILES.find(([file]) => file === join('src', 'app.css'))![1];
		expect([...css.matchAll(SAI_DEFINITION)].map((m) => m[1])).toEqual([
			'top',
			'right',
			'bottom',
			'left'
		]);
	});

	it('never disables zoom in the viewport meta or anywhere else', () => {
		expect(FILES.filter(([, text]) => scanners.zoomLock(text).length > 0).map(([f]) => f)).toEqual(
			[]
		);
		const html = readFileSync('src/app.html', 'utf8');
		expect(html).toMatch(
			/<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" \/>/
		);
	});

	it('app.css holds the 16 px input floor, unlayered, with file inputs left to their own components', () => {
		const css = stripComments(readFileSync('src/app.css', 'utf8'));
		const rule = css.match(/(input:not\([^)]*\),\s*select,\s*textarea)\s*\{([^}]*)\}/);
		expect(rule, 'the input floor rule').not.toBeNull();
		expect(rule![2]).toMatch(/font-size:\s*max\(16px,\s*1em\)/);
		for (const type of ['checkbox', 'radio', 'range', 'file', 'color'])
			expect(rule![1]).toContain(`[type='${type}']`);
		// Unlayered: at brace depth 0, not inside `@layer { }` or an at-rule.
		const before = css.slice(0, css.indexOf(rule![1]!));
		expect(before.split('{').length - before.split('}').length).toBe(0);
	});
});
