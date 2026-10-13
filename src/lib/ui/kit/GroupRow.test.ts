import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import GroupRow from './GroupRow.svelte';

const children = createRawSnippet(() => ({ render: () => '<span>Kopi</span>' }));

describe('GroupRow', () => {
	it('renders no checkbox unless `selected` is set (every existing call site is unchanged)', () => {
		const plain = render(GroupRow, { props: { children } }).body;
		expect(plain).not.toContain('type="checkbox"');
		expect(plain).toContain('class="row');
		const link = render(GroupRow, { props: { children, href: '/riwayat' } }).body;
		expect(link).toContain('href="/riwayat"');
		expect(link).not.toContain('type="checkbox"');
	});

	it('with `selected`, the whole row is the label of a checkbox that posts name=value', () => {
		const on = render(GroupRow, {
			props: { children, selected: true, name: 'd', value: 'id-1:5' }
		}).body;
		expect(on).toMatch(/<label class="row selectable[^"]*">/);
		const input = on.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? '';
		expect(input).toContain('name="d"');
		expect(input).toContain('value="id-1:5"');
		expect(input).toMatch(/\schecked/);
		const off = render(GroupRow, {
			props: { children, selected: false, name: 'd', value: 'id-1:5' }
		}).body;
		expect(off.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toMatch(/\schecked/);
	});

	it('with `radio`, the row posts one choice of a group', () => {
		const on = render(GroupRow, {
			props: { children, selected: true, radio: true, name: 'theme', value: 'mono' }
		}).body;
		const input = on.match(/<input[^>]*>/)?.[0] ?? '';
		expect(input).toContain('type="radio"');
		expect(input).toContain('name="theme"');
		expect(input).toContain('value="mono"');
		expect(input).toMatch(/\schecked/);
	});
});
