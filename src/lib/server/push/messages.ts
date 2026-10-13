import { msg } from '#lib/shared/i18n';

/** Server answers of /pengaturan/notifikasi (translated by the page with tr()). */
export const PUSH_NOT_CONFIGURED = msg('Notifikasi belum dikonfigurasi di server ini.');
export const SUBSCRIPTION_INVALID = msg(
	'Browser ini mengirim data notifikasi yang tidak dikenal. Coba browser lain.'
);
export const SUBSCRIPTION_REFUSED = msg(
	'Notifikasi tidak bisa diaktifkan untuk perangkat ini. Matikan notifikasi di perangkat lain atau coba lagi nanti.'
);
export const NO_SUBSCRIPTIONS = msg('Belum ada perangkat dengan notifikasi aktif.');
export const PUSH_LOAD_FAILED = msg(
	'Pengaturan notifikasi tidak bisa dimuat. Coba lagi sebentar lagi.'
);
