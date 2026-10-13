import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ScreenTitle from './ScreenTitle.svelte';

describe('ScreenTitle back link', () => {
	it('renders a chevron link named by the label when `back` is set', () => {
		const html = render(ScreenTitle, {
			props: {
				title: 'Akun',
				back: { href: '/pengaturan', label: 'Kembali ke Pengaturan' }
			}
		}).body;
		const link = html.match(/<a[^>]*class="back[^"]*"[^>]*>/)?.[0] ?? '';
		expect(link).toContain('href="/pengaturan"');
		expect(link).toContain('aria-label="Kembali ke Pengaturan"');
		expect(html).toMatch(/<h1[^>]*>Akun<\/h1>/);
	});

	it('renders no back link without `back` (top-level pages are unchanged)', () => {
		const html = render(ScreenTitle, { props: { title: 'Riwayat' } }).body;
		expect(html).not.toContain('class="back');
	});
});
