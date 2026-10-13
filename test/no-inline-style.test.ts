import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INLINE_STYLE = /<[a-zA-Z][^>]*\s(style=|style:)/;

describe('CSP: no inline styles in markup', () => {
	it('detects a style attribute and a style directive', () => {
		expect(INLINE_STYLE.test('<div style="color:red">')).toBe(true);
		expect(INLINE_STYLE.test('<div style:color={c}>')).toBe(true);
		expect(INLINE_STYLE.test('<div class="x">')).toBe(false);
	});

	it('no .svelte file uses style= or style:', () => {
		const offenders = readdirSync('src', { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith('.svelte'))
			.map((d) => join(d.parentPath, d.name))
			.filter((f) => {
				const markup = readFileSync(f, 'utf8').replace(/<style[\s\S]*?<\/style>/g, '');
				return INLINE_STYLE.test(markup);
			});
		expect(offenders).toEqual([]);
	});
});
