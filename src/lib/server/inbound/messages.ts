import { msg } from '#lib/shared/i18n';

/** Server answers of /pengaturan/aplikasi/email (translated by the page with tr()). */
export const FORWARDING_LOAD_FAILED = msg(
	'Penerusan e-mail tidak bisa dimuat. Periksa koneksi lalu coba lagi.'
);
/** INBOUND_EMAIL_DOMAIN is unset or malformed: no address can be created. */
export const FORWARDING_NOT_CONFIGURED = msg('Belum dikonfigurasi');
export const ADDRESS_EXISTS = msg('Kamu sudah punya alamat penerusan. Muat ulang halaman.');
export const ADDRESS_NOT_FOUND = msg('Alamat penerusan tidak ditemukan. Muat ulang halaman.');
export const ADDRESS_CHANGED_MEANWHILE = msg(
	'Alamat penerusan berubah di tab lain. Muat ulang halaman lalu coba lagi.'
);
/** The chosen space is not one the user is a live member of (same answer for a missing one). */
export const SPACE_NOT_AVAILABLE = msg('Ruang itu tidak tersedia.');
export const ADDRESS_RATE_LIMITED = msg(
	'Terlalu banyak perubahan alamat. Coba lagi dalam beberapa menit.'
);
