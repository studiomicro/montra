import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODULES } from '#lib/shared/feature-flags';
import {
	activeHref,
	ADD_PATHS,
	addPaths,
	FORWARDING_UNAVAILABLE,
	RECEIPT_UNAVAILABLE,
	isActive,
	MODULE_NAV,
	SIDEBAR_SECTIONS,
	TABS,
	visibleSections
} from './nav';

const sectionHrefs = (sections: readonly { items: readonly { href: string }[] }[]) =>
	sections.map((s) => s.items.map((i) => i.href));
const allItems = SIDEBAR_SECTIONS.flatMap((s) => s.items);

describe('navigation tables', () => {
	it('phone tabs: Beranda, Riwayat, Laporan, Dompet (APP_PARITY § 1)', () => {
		expect(TABS.map((t) => t.label)).toEqual(['Beranda', 'Riwayat', 'Laporan', 'Dompet']);
		expect(TABS.map((t) => t.href)).toEqual(['/', '/riwayat', '/laporan', '/dompet']);
	});

	it('sidebar sections Uang, Fitur, Catat in the fixed order', () => {
		expect(SIDEBAR_SECTIONS.map((s) => s.title)).toEqual(['Uang', 'Fitur', 'Catat']);
		expect(sectionHrefs(SIDEBAR_SECTIONS)).toEqual([
			['/', '/riwayat', '/laporan', '/anggaran', '/dompet'],
			[
				'/pengaturan/fitur',
				'/alur-uang',
				'/kekayaan',
				'/langganan',
				'/barang',
				'/koleksi',
				'/patungan',
				'/agen'
			],
			['/impor', '/kotak-masuk', '/pengaturan/aplikasi']
		]);
		expect(SIDEBAR_SECTIONS[0]?.items.map((i) => i.label)).toEqual([
			'Ringkasan',
			'Transaksi',
			'Laporan',
			'Anggaran',
			'Dompet'
		]);
	});

	it('mirrors the reference capture paths, then manual', () => {
		expect(ADD_PATHS.map((p) => p.id)).toEqual(['otomatis', 'suara', 'struk', 'mutasi', 'manual']);
	});

	it('Otomatis (FN-19), Suara (FN-14), Struk (FN-15), Mutasi (FN-16a) and manual entry are real paths', () => {
		expect(Object.fromEntries(ADD_PATHS.map((p) => [p.id, p.href ?? null]))).toEqual({
			otomatis: '/pengaturan/aplikasi/email',
			suara: '/riwayat/suara?mulai=1',
			struk: '/riwayat/struk',
			mutasi: '/impor#mutasi',
			manual: '/riwayat/baru'
		});
	});

	it('Struk links only when the AI Gateway is configured, else says why (FN-15)', () => {
		expect(addPaths(true, true)).toEqual(ADD_PATHS);
		const off = addPaths(false, true);
		const struk = off.find((p) => p.id === 'struk')!;
		expect(struk.href).toBeUndefined();
		expect(struk.unavailable).toBe(RECEIPT_UNAVAILABLE);
		expect(RECEIPT_UNAVAILABLE).toBe('Pembacaan struk dengan AI belum dikonfigurasi.');
		expect(off.filter((p) => p.id !== 'struk')).toEqual(ADD_PATHS.filter((p) => p.id !== 'struk'));
	});

	it('Otomatis links to the forwarding setup only when a forwarding domain is configured, else says why (FN-19)', () => {
		const otomatis = ADD_PATHS.find((p) => p.id === 'otomatis')!;
		expect(otomatis.hint).toBe('Teruskan e-mail bank dan QRIS');
		const off = addPaths(true, false);
		const row = off.find((p) => p.id === 'otomatis')!;
		expect(row.href).toBeUndefined();
		expect(row.unavailable).toBe(FORWARDING_UNAVAILABLE);
		expect(FORWARDING_UNAVAILABLE).toBe('Alamat penerusan e-mail belum dikonfigurasi.');
		expect(off.filter((p) => p.id !== 'otomatis')).toEqual(
			ADD_PATHS.filter((p) => p.id !== 'otomatis')
		);
		// Both unavailable: each says its own reason; Mutasi alone keeps "Segera hadir" (no href, no reason).
		const both = addPaths(false, false);
		expect(both.filter((p) => p.unavailable).map((p) => p.id)).toEqual(['otomatis', 'struk']);
		expect(both.filter((p) => !p.href && !p.unavailable).map((p) => p.id)).toEqual([]);
	});

	it('Agen (FN-23) is in the Fitur group for everyone, never a tab or a hideable module, and highlights itself', () => {
		const fitur = SIDEBAR_SECTIONS[1]?.items.find((i) => i.href === '/agen');
		expect(fitur?.label).toBe('Agen');
		expect(TABS.map((t) => t.href)).not.toContain('/agen');
		expect(Object.values(MODULE_NAV)).not.toContain('/agen');
		expect(activeHref(allItems, '/agen')).toBe('/agen');
		expect(activeHref(allItems, '/agen/abc/unduh')).toBe('/agen');
		expect(isActive('/agen', '/agenda')).toBe(false);
	});

	it('Tanya is a real page (FN-22): the sidebar and Beranda link to it and it highlights itself', () => {
		expect(isActive('/tanya', '/tanya')).toBe(true);
		expect(isActive('/tanya', '/tanyaan')).toBe(false);
	});
});

describe('isActive', () => {
	it('matches Beranda only on /', () => {
		expect(isActive('/', '/')).toBe(true);
		expect(isActive('/', '/riwayat')).toBe(false);
	});
	it('matches a section and its children, not prefixes of other words', () => {
		expect(isActive('/riwayat', '/riwayat')).toBe(true);
		expect(isActive('/riwayat', '/riwayat/123')).toBe(true);
		expect(isActive('/riwayat', '/riwayatx')).toBe(false);
	});
});

describe('activeHref (one current entry per page)', () => {
	it('marks Dompet on its own page and on the goal pages it lists; /kekayaan is Kekayaan bersih', () => {
		expect(activeHref(TABS, '/dompet')).toBe('/dompet');
		expect(activeHref(TABS, '/kekayaan/tabungan/x')).toBe('/dompet');
		expect(activeHref(allItems, '/kekayaan/tabungan/x')).toBe('/dompet');
		// Kekayaan bersih is a feature page (wave C): no tab claims it, the sidebar's Fitur entry does.
		expect(activeHref(TABS, '/kekayaan')).toBeNull();
		expect(activeHref(allItems, '/kekayaan')).toBe('/kekayaan');
		expect(activeHref(allItems, '/anggaran')).toBe('/anggaran');
	});
	it('only Jelajahi fitur opens a sheet', () => {
		expect(allItems.filter((i) => i.sheet).map((i) => i.href)).toEqual(['/pengaturan/fitur']);
	});
	it('prefers the longest match: Jelajahi fitur over nothing, Riwayat children', () => {
		expect(activeHref(allItems, '/pengaturan/fitur')).toBe('/pengaturan/fitur');
		expect(activeHref(allItems, '/pengaturan/aplikasi')).toBe('/pengaturan/aplikasi');
		expect(activeHref(allItems, '/riwayat/baru')).toBe('/riwayat');
		expect(activeHref(allItems, '/')).toBe('/');
	});
	it('is null for pages outside the nav', () => {
		expect(activeHref(allItems, '/pengaturan')).toBeNull();
		expect(activeHref(TABS, '/impor')).toBeNull();
	});
});

describe('visibleSections (FN-12)', () => {
	it('shows every entry when nothing is hidden', () => {
		expect(visibleSections([])).toEqual(SIDEBAR_SECTIONS.map((s) => ({ ...s })));
	});

	it('drops Kekayaan bersih when Kekayaan is hidden; Dompet (wallets) stays', () => {
		const fitur = visibleSections(['kekayaan'])[1]?.items.map((i) => i.href);
		expect(fitur).toEqual([
			'/pengaturan/fitur',
			'/alur-uang',
			'/langganan',
			'/barang',
			'/koleksi',
			'/patungan',
			'/agen'
		]);
		expect(visibleSections(['kekayaan'])[0]?.items.map((i) => i.href)).toContain('/dompet');
	});

	it('drops Langganan, Barang and Koleksi each only when hidden, keeping the order', () => {
		for (const [module, href] of [
			['langganan', '/langganan'],
			['barang', '/barang'],
			['koleksi', '/koleksi']
		] as const) {
			const all = sectionHrefs(visibleSections([module])).flat();
			expect(all).not.toContain(href);
			expect(all).toEqual(
				sectionHrefs(SIDEBAR_SECTIONS)
					.flat()
					.filter((h) => h !== href)
			);
		}
		expect(visibleSections(['ruang'])).toEqual(visibleSections([]));
	});

	it('maps only known modules to existing sidebar entries, never to a tab', () => {
		const hrefs = allItems.map((t) => t.href);
		for (const [module, href] of Object.entries(MODULE_NAV)) {
			expect(MODULES).toContain(module);
			expect(hrefs).toContain(href);
			expect(TABS.map((t) => t.href)).not.toContain(href);
		}
	});

	it('TabBar is a compact pill sized by its items, never a fixed column count (phone layout v3)', () => {
		const css = readFileSync('src/lib/ui/shell/TabBar.svelte', 'utf8').match(
			/\.tabbar \{([^}]*)\}/
		)?.[1];
		expect(css).not.toMatch(/grid-template-columns/);
		expect(css).toMatch(/display:\s*flex/);
		// bottom-left, clear of the side insets, and no `right`: the round Tambah button owns the right corner.
		expect(css).toMatch(/left:\s*max\(16px,\s*var\(--sai-left\)\)/);
		expect(css).not.toMatch(/\bright:/);
	});

	it('TabBar holds the four tabs as icons named by aria-label, plus a separate Tambah button', () => {
		const svelte = readFileSync('src/lib/ui/shell/TabBar.svelte', 'utf8');
		const nav = /<nav[\s\S]*?<\/nav>/.exec(svelte)?.[0] ?? '';
		expect(nav).toMatch(/aria-label=\{tr\(tab\.label\)\}/);
		expect(nav).not.toMatch(/<span>/);
		expect(nav).not.toMatch(/<button/);
		expect(svelte).toMatch(/<button[^>]*class="fab"[^>]*aria-label=\{tr\('Tambah'\)\}/);
	});
});
