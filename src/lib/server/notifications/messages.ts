import { msg } from '#lib/shared/i18n';

/** Server answers of the notification list and settings (translated by the pages with tr()). */
export const NOTIFICATIONS_LOAD_FAILED = msg(
	'Notifikasi tidak bisa dimuat. Coba lagi sebentar lagi.'
);
export const NOTIFICATION_GONE = msg('Notifikasi ini sudah tidak ada. Muat ulang halaman.');
export const KIND_INVALID = msg('Jenis notifikasi tidak dikenal.');
export const PREFS_LOAD_FAILED = msg(
	'Pilihan notifikasi tidak bisa dimuat. Coba lagi sebentar lagi.'
);
/** FN-34b: a reminder hour outside 06–23 WIB or not a whole hour (refused, never clamped). */
export const HOUR_INVALID = msg('Pilih jam antara 06.00 dan 23.00 WIB.');
