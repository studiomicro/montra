import { readFileSync } from 'node:fs';
import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import {
	ASCII_DESKTOP_GRID,
	ASCII_PHONE_GRID,
	ASCII_STATIC_T,
	asciiFrame
} from '#lib/shared/ascii-field';
import { cssOf, declarations } from './helpers/css';

/**
 * FN-56 AC 12 and 15: the (auth) layout server-renders the decorative ASCII field on /masuk and /daftar only, with
 * the still frame of both grids, and nothing in it can take focus, carry an inline style or break the CSP.
 */

const current = vi.hoisted(() => ({ url: new URL('http://localhost/masuk') }));
vi.mock('$app/state', () => ({ page: current }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }), deserialize: JSON.parse }));
vi.mock('$app/navigation', () => ({ goto: async () => {}, invalidateAll: async () => {} }));

const Layout = (await import('../src/routes/(auth)/+layout.svelte'))
	.default as unknown as Component<Record<string, unknown>>;
const FIELD = 'src/lib/ui/auth/AsciiField.svelte';

function layoutAt(path: string): string {
	current.url = new URL(`http://localhost${path}`);
	const children = createRawSnippet(() => ({ render: () => '<p>form</p>' }));
	return render(Layout, { props: { children } }).body;
}
/** The field's markup: from its opening tag to the form column. */
const fieldOf = (body: string) =>
	body.slice(body.indexOf('<div class="art'), body.indexOf('<main'));
const escape = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('the (auth) layout and the ASCII field', () => {
	it.each(['/masuk', '/daftar'])('%s: the field is aria-hidden with both still frames', (path) => {
		const body = layoutAt(path);
		const field = fieldOf(body);
		expect(field).toContain('aria-hidden="true"');
		expect(field).toContain('data-testid="ascii-field"');
		for (const grid of [ASCII_PHONE_GRID, ASCII_DESKTOP_GRID]) {
			const { tiers } = asciiFrame(ASCII_STATIC_T, grid.cols, grid.rows);
			for (const layer of tiers) expect(field).toContain(escape(layer.join('\n')));
		}
		expect(field).not.toMatch(/tabindex|role=|<canvas|style=|<style|<script/);
		// The field comes before the form column: above it in one column, on its left from 1024 px.
		expect(body.indexOf('data-testid="ascii-field"')).toBeLessThan(body.indexOf('<main'));
	});

	it('/akun-dihapus renders without the field', () => {
		const body = layoutAt('/akun-dihapus');
		expect(body).not.toContain('ascii-field');
		expect(body).not.toContain('with-art');
		expect(body).toContain('<p>form</p>');
	});

	it('the component declares no CSS motion, colours only from tokens, reads no storage (AC 15)', () => {
		const src = readFileSync(FIELD, 'utf8');
		const css = declarations(cssOf(FIELD));
		expect(css.filter((d) => /^(animation|transition)/.test(d.property))).toEqual([]);
		expect(src).not.toMatch(/infinite|@keyframes|\{@html|style=/);
		for (const d of css.filter((d) => /color|background/.test(d.property)))
			expect(d.value, d.property).toMatch(/^var\(--(brand-surface|on-brand-surface)\)$/);
		expect(src).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|color-mix|hsl\(/i);
		expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
	});
});
