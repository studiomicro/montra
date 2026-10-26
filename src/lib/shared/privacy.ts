import { msg } from './i18n.ts';

/**
 * Privacy vocabulary (FN-31), shared by the sign-up form, the settings page and the server.
 *
 * Consent: what a person agrees to at sign-up. `version` is the date the shown (draft) text last changed —
 * the id of that text, not a semantic version. Changing a text means a new date here; existing rows keep the
 * version they accepted (no re-consent flow yet: PRD FN-31 owner decision 2).
 */
export const CONSENT_KINDS = ['terms', 'privacy_policy', 'cross_border_notice'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export const CONSENT_VERSIONS: Readonly<Record<ConsentKind, string>> = {
	terms: '2026-10-08',
	privacy_policy: '2026-10-08',
	cross_border_notice: '2026-10-08'
};

export const CONSENT_LABELS: Readonly<Record<ConsentKind, string>> = {
	terms: msg('Ketentuan layanan'),
	privacy_policy: msg('Kebijakan privasi'),
	cross_border_notice: msg('Pemberitahuan pemrosesan di luar Indonesia')
};

/**
 * Usage statistics: the closed vocabulary of what may be counted. A screen or action outside these lists is
 * refused before anything is written, so no client can put typed text into a statistic.
 */
export const STAT_SCREENS = [
	'beranda',
	'riwayat',
	'laporan',
	'kekayaan',
	'dompet',
	'anggaran',
	'tambah',
	'masuk',
	'daftar',
	'privasi'
] as const;
export type StatScreen = (typeof STAT_SCREENS)[number];

const STAT_ACTIONS = ['view', 'open', 'sign_in', 'sign_up', 'export_account'] as const;
export type StatAction = (typeof STAT_ACTIONS)[number];

/** One counted event: a screen and what happened there. Nothing else can be counted. */
export interface StatEvent {
	screen: StatScreen;
	action: StatAction;
}

export const isStatScreen = (v: unknown): v is StatScreen =>
	typeof v === 'string' && (STAT_SCREENS as readonly string[]).includes(v);
export const isStatAction = (v: unknown): v is StatAction =>
	typeof v === 'string' && (STAT_ACTIONS as readonly string[]).includes(v);

/** The screen a navigation to `pathname` counts as; null for every page outside the vocabulary. */
export function statScreenForPath(pathname: string): StatScreen | null {
	switch (pathname) {
		case '/':
			return 'beranda';
		case '/riwayat':
			return 'riwayat';
		case '/laporan':
			return 'laporan';
		case '/kekayaan':
			return 'kekayaan';
		case '/dompet':
			return 'dompet';
		case '/anggaran':
			return 'anggaran';
		case '/pengaturan/privasi':
			return 'privasi';
		default:
			return null;
	}
}

/**
 * Why the account export was refused: the `?ekspor=` code it redirects back with (also without JavaScript)
 * and the message the page shows for it.
 */
export const EXPORT_REFUSALS = {
	'terlalu-sering': msg(
		'Ekspor sudah diminta beberapa kali barusan. Tunggu 10 menit, lalu coba lagi.'
	),
	'terlalu-besar': msg(
		'Datamu terlalu besar untuk satu ekspor. Ekspor transaksi per tahun dari halaman Impor.'
	),
	'foto-terlalu-besar': msg(
		'Foto barang dan koleksimu lebih dari 500 MB, terlalu besar untuk satu ekspor. Hapus atau ganti beberapa foto, lalu coba lagi.'
	)
} as const;
export type ExportRefusal = keyof typeof EXPORT_REFUSALS;

export const isExportRefusal = (v: string | null): v is ExportRefusal =>
	v === 'terlalu-sering' || v === 'terlalu-besar' || v === 'foto-terlalu-besar';
