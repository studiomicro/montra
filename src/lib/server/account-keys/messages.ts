import { msg } from '#lib/shared/i18n';

/** Server answers of the account key and password-change actions (Indonesian keys; English in i18n-en.ts). */
export const KEY_INVALID = msg(
	'Kunci akun tidak bisa disimpan. Muat ulang halaman lalu coba lagi.'
);
export const KEY_UNSUPPORTED = msg(
	'Browser ini belum bisa membuat kunci akun. Gunakan browser terbaru dengan JavaScript aktif.'
);
export const KEY_STALE = msg(
	'Kunci akun tidak bisa dibuka dengan kata sandi barumu. Kunci ulang di bawah ini.'
);
export const CHANGED_MEANWHILE = msg(
	'Kata sandi atau kunci akun berubah sementara itu. Muat ulang halaman lalu coba lagi.'
);
export const PASSWORD_MISMATCH = msg('Konfirmasi kata sandi tidak sama.');
