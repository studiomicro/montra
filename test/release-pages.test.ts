import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Component } from 'svelte';

// FN-42b AC5: Tentang and Catatan rilis render one shared release card; the running version's says "Versi kamu".
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/') } }));

const Harness = (await import('./helpers/I18nHarness.svelte')).default;
const asPage = (m: { default: unknown }) => m.default as Component<Record<string, unknown>>;
const Tentang = asPage(await import('../src/routes/(app)/pengaturan/tentang/+page.svelte'));
const Changelog = asPage(
	await import('../src/routes/(app)/pengaturan/tentang/catatan-rilis/+page.svelte')
);
const WhatsNew = asPage(await import('../src/lib/ui/pwa/WhatsNew.svelte'));

const notes = ['0.6.0', '0.5.0', '0.4.0'].map((version) => ({
	version,
	date: '2026-10-09',
	html: `<ul><li>Hal baru ${version}.</li></ul>`
}));
const html = (
	component: Component<Record<string, unknown>>,
	props: Record<string, unknown>,
	locale: 'id' | 'en' = 'id'
) => render(Harness, { props: { component, locale, props } }).body;

describe('Tentang source link (AGPL-3.0 section 13)', () => {
	const data = { version: '0.5.0', releasedOn: null, notes: [] };
	it('links the configured source URL', () => {
		const body = html(Tentang, { data: { ...data, sourceUrl: 'https://git.example/montra' } });
		expect(body).toMatch(/href="https:\/\/git\.example\/montra"[\s\S]*?Kode sumber Montra/);
	});
	it('shows Belum dikonfigurasi without a URL', () => {
		const body = html(Tentang, { data: { ...data, sourceUrl: null } });
		expect(body).toMatch(/Kode sumber Montra[\s\S]*?Belum dikonfigurasi/);
	});
});

describe('one release card on both pages (FN-42b AC5)', () => {
	it('Tentang: H3 cards, "Versi kamu" on the running version only, "Semua catatan rilis" to the changelog', () => {
		const body = html(Tentang, { data: { version: '0.5.0', releasedOn: '2026-10-09', notes } });
		expect(body.match(/<article class="release/g)).toHaveLength(3);
		expect(body.match(/<h3 id="release-/g)).toHaveLength(3);
		expect(body.match(/Versi kamu/g)).toHaveLength(1);
		expect(body).toMatch(/<h3 id="release-0\.5\.0"[\s\S]*?Versi kamu[\s\S]*?<\/article>/);
		expect(body).toMatch(
			/href="\/pengaturan\/tentang\/catatan-rilis"[\s\S]*?>Semua catatan rilis</
		);
	});

	it('Catatan rilis: H1, the count, a back link, one H2 card per release', () => {
		const body = html(Changelog, { data: { version: '0.6.0', notes } });
		expect(body).toMatch(/<h1[^>]*>Catatan rilis<\/h1>/);
		expect(body).toContain('3 rilis');
		expect(body).toMatch(/href="\/pengaturan\/tentang"[\s\S]*?Tentang Montra/);
		expect(body.match(/<article class="release/g)).toHaveLength(3);
		expect(body.match(/<h2 id="release-/g)).toHaveLength(3);
		expect(body.match(/<h3/g)).toBeNull();
		expect(body.match(/Versi kamu/g)).toHaveLength(1);
		expect(body).toContain('Hal baru 0.4.0.');
		const en = html(Changelog, { data: { version: '0.6.0', notes } }, 'en');
		expect(en).toMatch(/<h1[^>]*>Release notes<\/h1>/);
		expect(en).toContain('Your version');
	});

	it('no notes: the existing empty phrase, no count', () => {
		const body = html(Changelog, { data: { version: '0.6.0', notes: [] } });
		expect(body).toContain('Belum ada catatan rilis.');
		expect(body).not.toContain(' rilis</p>');
		expect(body).not.toContain('<article');
	});

	it('neither page carries its own card markup: both use ReleaseNote', () => {
		for (const file of [
			'src/routes/(app)/pengaturan/tentang/+page.svelte',
			'src/routes/(app)/pengaturan/tentang/catatan-rilis/+page.svelte'
		]) {
			const source = readFileSync(file, 'utf8');
			expect(source, file).toContain("import ReleaseNote from '#lib/ui/pwa/ReleaseNote.svelte'");
			expect(source, file).not.toMatch(/<article|@html/);
		}
	});
});

describe('"Baru di Montra" is never server-rendered (FN-42b)', () => {
	it('renders nothing before hydration', () => {
		const body = html(WhatsNew, { version: '0.6.0', note: notes[0] });
		expect(body).not.toContain('Baru di Montra');
		expect(body).not.toContain('Hal baru');
	});
});
