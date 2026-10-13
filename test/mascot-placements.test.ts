import { readFileSync } from 'node:fs';
import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

// FN-44 Part 2: where Koko replaced a scene, and where the FN-40 scenes stay.

const state = vi.hoisted(() => ({ status: 404 }));
vi.mock('$app/state', () => ({
	page: {
		get status() {
			return state.status;
		},
		url: new URL('http://localhost/riwayat?x=1')
	}
}));
vi.mock('#lib/ui/account-key/device', () => ({ dropDeviceKey: () => {} }));

const Harness = (await import('./helpers/I18nHarness.svelte')).default;
const pages = {
	root: (await import('../src/routes/+error.svelte')).default,
	app: (await import('../src/routes/(app)/+error.svelte')).default
} as unknown as Record<string, Component<Record<string, unknown>>>;

const html = (which: string, status: number) => {
	state.status = status;
	return render(Harness, { props: { component: pages[which]!, props: {} } }).body;
};
const read = (file: string) => readFileSync(file, 'utf8');

describe('error pages: Koko is sad, the text stays the only description', () => {
	it.each([
		['root', 404, 'Halaman tidak ditemukan.'],
		['root', 500, 'Terjadi kesalahan. Coba lagi.'],
		['app', 404, 'Halaman tidak ditemukan.'],
		['app', 500, 'Terjadi kesalahan. Coba lagi.']
	])('%s %i', (which, status, text) => {
		const body = html(which, status);
		expect(body).toMatch(/<svg[^>]*class="mascot pose-sad[^>]*aria-hidden="true"/);
		expect(body).not.toContain('class="illustration');
		expect(body).toContain(text);
		expect(body).not.toMatch(/aria-label=|role="img"/);
	});
});

describe('call sites', () => {
	it('sign-in and sign-up: Koko waves in the wide-screen hero, in place of the welcome scene', () => {
		for (const file of [
			'src/routes/(auth)/masuk/+page.svelte',
			'src/routes/(auth)/daftar/+page.svelte'
		]) {
			const src = read(file);
			expect(src, file).toContain('<div class="hero-art"><Mascot pose="wave" size={168} /></div>');
			expect(src, file).not.toContain('Illustration');
			// Still hidden on a phone (below 768 px wide), as before.
			expect(src, file).toMatch(/\.hero-art \{\s*display: none;/);
		}
	});

	it('Beranda: Koko waves on the first-wallet card only (it is inside the zero-wallet branch)', () => {
		const src = read('src/routes/(app)/+page.svelte');
		const branch = src.slice(src.indexOf('{#if s.walletCount === 0}'));
		const end = branch.indexOf('{/if}');
		expect(branch.slice(0, end)).toContain('<Mascot pose="wave" size={88} />');
		expect(src).not.toContain('<Illustration');
	});

	it.each([
		['src/routes/(app)/riwayat/baru/+page.svelte', 'wallet'],
		['src/routes/(app)/riwayat/suara/+page.svelte', 'wallet'],
		['src/routes/(app)/riwayat/berulang/baru/+page.svelte', 'wallet'],
		['src/routes/(app)/anggaran/+page.svelte', 'budget'],
		['src/routes/(app)/riwayat/berulang/+page.svelte', 'calendar'],
		['src/routes/(app)/langganan/+page.svelte', 'calendar'],
		['src/routes/(app)/barang/+page.svelte', 'parcels'],
		['src/routes/(app)/koleksi/+page.svelte', 'parcels'],
		['src/lib/ui/net-worth/NetWorthSection.svelte', 'growth'],
		['src/lib/ui/goals/GoalsSection.svelte', 'goal'],
		['src/routes/(app)/ruang/+page.svelte', 'people'],
		['src/routes/(app)/impor/+page.svelte', 'history'],
		['src/routes/(app)/kotak-masuk/+page.svelte', 'inbox'],
		['src/routes/(app)/kotak-masuk/notifikasi/+page.svelte', 'inbox']
	])('%s keeps its "%s" scene (EmptyState shows the scene, never Koko with it)', (file, name) => {
		expect(read(file)).toContain(`illustration="${name}"`);
	});
});
