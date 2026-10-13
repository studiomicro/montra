import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import IconRow from './IconRow.svelte';
import PageAction from './PageAction.svelte';

const label = createRawSnippet(() => ({ render: () => '<span>Tambah langganan</span>' }));

describe('IconRow', () => {
	it('a link row has a chevron; a plain row has none', () => {
		const linked = render(IconRow, {
			props: { icon: 'user', title: 'Akun', hint: 'Nama dan kata sandi', href: '/pengaturan/akun' }
		}).body;
		expect(linked).toContain('href="/pengaturan/akun"');
		expect(linked).toContain('Nama dan kata sandi');
		expect(linked).toContain('class="chevron');
		const plain = render(IconRow, { props: { icon: 'user', title: 'Akun' } }).body;
		expect(plain).not.toContain('href=');
		expect(plain).not.toContain('class="chevron');
		expect(plain).not.toContain('class="hint');
	});
});

describe('PageAction', () => {
	it('header placement is a small pill, bottom placement a full-width large one', () => {
		const header = render(PageAction, {
			props: { at: 'header', href: '/langganan?tambah=1', children: label }
		}).body;
		expect(header).toMatch(/class="page-action header/);
		expect(header).toMatch(/class="btn primary sm/);
		expect(header).not.toMatch(/\sfull\b/);
		const bottom = render(PageAction, {
			props: { at: 'bottom', href: '/langganan?tambah=1', children: label }
		}).body;
		expect(bottom).toMatch(/class="page-action bottom/);
		expect(bottom).toMatch(/class="btn primary lg[^"]*full/);
		expect(bottom).toContain('href="/langganan?tambah=1"');
	});

	it('without href it is a real button that can submit its form', () => {
		const body = render(PageAction, {
			props: { at: 'bottom', type: 'submit', disabled: true, children: label }
		}).body;
		expect(body).toMatch(/<button[^>]*type="submit"/);
		expect(body).toMatch(/<button[^>]*disabled/);
	});
});
