import type { Module } from '#lib/shared/feature-flags';
import { msg } from '#lib/shared/i18n';
import type { IconName } from '#lib/ui/icons';

export interface NavItem {
	href: string;
	label: string;
	icon: IconName;
	/** Other paths this entry stands for (Dompet also holds the goal pages under /kekayaan/tabungan). */
	match?: readonly string[];
	/** With JavaScript the entry opens this sheet instead of following `href` (the no-JavaScript path). */
	sheet?: 'fitur';
}

export interface NavSection {
	/** Small grey label above the group. */
	title: string;
	items: readonly NavItem[];
}

export interface AddPath {
	id: 'otomatis' | 'suara' | 'struk' | 'mutasi' | 'manual';
	label: string;
	hint: string;
	icon: IconName;
	/** Set once the path works; the others show "Segera hadir". */
	href?: string;
	/** Why a built path is unavailable on this server (shown instead of "Segera hadir"). */
	unavailable?: string;
}

const DOMPET: NavItem = {
	href: '/dompet',
	label: msg('Dompet'),
	icon: 'wallet',
	match: ['/kekayaan/tabungan']
};

/** Phone tab bar (APP_PARITY § 1), then Tambah. No tab belongs to a hideable module. */
export const TABS: readonly NavItem[] = [
	{ href: '/', label: msg('Beranda'), icon: 'home' },
	{ href: '/riwayat', label: msg('Riwayat'), icon: 'list' },
	{ href: '/laporan', label: msg('Laporan'), icon: 'chart' },
	DOMPET
];

/** Desktop sidebar sections (APP_PARITY § 1). */
export const SIDEBAR_SECTIONS: readonly NavSection[] = [
	{
		title: msg('Uang'),
		items: [
			{ href: '/', label: msg('Ringkasan'), icon: 'home' },
			{ href: '/riwayat', label: msg('Transaksi'), icon: 'list' },
			{ href: '/laporan', label: msg('Laporan'), icon: 'chart' },
			{ href: '/anggaran', label: msg('Anggaran'), icon: 'gauge' },
			DOMPET
		]
	},
	{
		title: msg('Fitur'),
		items: [
			{ href: '/pengaturan/fitur', label: msg('Jelajahi fitur'), icon: 'grid', sheet: 'fitur' },
			// FN-35: a page for everyone, not a hideable module (owner decision B).
			{ href: '/alur-uang', label: msg('Alur uang'), icon: 'flow' },
			{ href: '/kekayaan', label: msg('Kekayaan bersih'), icon: 'star' },
			{ href: '/langganan', label: msg('Langganan'), icon: 'repeat' },
			{ href: '/barang', label: msg('Barang'), icon: 'box' },
			{ href: '/koleksi', label: msg('Koleksi'), icon: 'sparkle' },
			// FN-49: split bills with friends (a hideable module).
			{ href: '/patungan', label: msg('Patungan'), icon: 'people' },
			// FN-23: a plan feature, not a hideable module; shown to everyone (the locked page explains the plan).
			{ href: '/agen', label: msg('Agen'), icon: 'bolt' }
		]
	},
	{
		title: msg('Catat'),
		items: [
			{ href: '/impor', label: msg('Impor'), icon: 'file' },
			{ href: '/kotak-masuk', label: msg('Kotak masuk'), icon: 'inbox' },
			{ href: '/pengaturan/aplikasi', label: msg('Aplikasi terhubung'), icon: 'link' }
		]
	}
];

/**
 * The sidebar entry each hideable module removes (FN-12): Kekayaan bersih, Langganan (FN-26), Barang (FN-27),
 * Koleksi (FN-28) and Patungan (FN-49). Hiding never changes a figure or blocks the route. Ruang bersama has no nav entry yet, and
 * its settings row says so.
 */
export const MODULE_NAV: Readonly<Partial<Record<Module, string>>> = {
	kekayaan: '/kekayaan',
	langganan: '/langganan',
	barang: '/barang',
	koleksi: '/koleksi',
	patungan: '/patungan'
};

/** SIDEBAR_SECTIONS without the entries of hidden modules, in their fixed order (never reordered). */
export function visibleSections(hidden: readonly Module[]): NavSection[] {
	const gone = new Set(hidden.map((m) => MODULE_NAV[m]));
	return SIDEBAR_SECTIONS.map((section) => ({
		...section,
		items: section.items.filter((item) => !gone.has(item.href))
	}));
}

export const ADD_PATHS: readonly AddPath[] = [
	{
		id: 'otomatis',
		label: msg('Otomatis'),
		hint: msg('Teruskan e-mail bank dan QRIS'),
		icon: 'mail',
		// FN-19 forwarding: live only when INBOUND_EMAIL_DOMAIN is configured (`addPaths`).
		href: '/pengaturan/aplikasi/email'
	},
	{
		id: 'suara',
		label: msg('Suara'),
		hint: msg('Ucapkan transaksimu'),
		icon: 'mic',
		// FN-14: recording starts as soon as the page opens.
		href: '/riwayat/suara?mulai=1'
	},
	{
		id: 'struk',
		label: msg('Struk'),
		hint: msg('Foto struk belanja'),
		icon: 'receipt',
		// FN-15: live only when the AI Gateway is configured (`addPaths`).
		href: '/riwayat/struk'
	},
	{
		id: 'mutasi',
		label: msg('Mutasi'),
		hint: msg('PDF atau CSV dari bank'),
		icon: 'file',
		// FN-16a: the statement upload section of Impor.
		href: '/impor#mutasi'
	},
	{
		id: 'manual',
		label: msg('Ketik manual'),
		hint: msg('Isi sendiri'),
		icon: 'keyboard',
		href: '/riwayat/baru'
	}
];

/** Why "Struk" is unavailable when the AI Gateway is not configured (FN-15). */
export const RECEIPT_UNAVAILABLE = msg('Pembacaan struk dengan AI belum dikonfigurasi.');

/** Why "Otomatis" is unavailable when no forwarding domain is configured (FN-19). */
export const FORWARDING_UNAVAILABLE = msg('Alamat penerusan e-mail belum dikonfigurasi.');

/**
 * The Tambah sheet's paths for this server: "Struk" (FN-15) keeps its link only when the AI Gateway is
 * configured, "Otomatis" (FN-19) only when the forwarding domain is; otherwise each is shown disabled with its
 * reason (RECEIPT_UNAVAILABLE, FORWARDING_UNAVAILABLE).
 */
export function addPaths(receiptReady: boolean, forwardingReady: boolean): readonly AddPath[] {
	const unavailable: Partial<Record<AddPath['id'], string>> = {
		...(receiptReady ? {} : { struk: RECEIPT_UNAVAILABLE }),
		...(forwardingReady ? {} : { otomatis: FORWARDING_UNAVAILABLE })
	};
	return ADD_PATHS.map((path) => {
		const reason = unavailable[path.id];
		return reason
			? { id: path.id, label: path.label, hint: path.hint, icon: path.icon, unavailable: reason }
			: path;
	});
}

export function isActive(href: string, pathname: string): boolean {
	if (href === '/') return pathname === '/';
	return pathname === href || pathname.startsWith(href + '/');
}

/**
 * The one entry of `items` marked current for `pathname`: the longest matching path (its own or a `match`
 * alias) wins, the first entry on a tie, so two links never both claim the page.
 */
export function activeHref(items: readonly NavItem[], pathname: string): string | null {
	let best: { href: string; length: number } | null = null;
	for (const item of items) {
		for (const path of [item.href, ...(item.match ?? [])]) {
			if (isActive(path, pathname) && (!best || path.length > best.length))
				best = { href: item.href, length: path.length };
		}
	}
	return best?.href ?? null;
}
