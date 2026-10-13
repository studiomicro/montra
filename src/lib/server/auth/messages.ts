import { msg } from '#lib/shared/i18n';

/** The one answer for a wrong password, an unknown e-mail, a disabled or a locked account (no oracle). */
export const INVALID_CREDENTIALS = msg('E-mail atau kata sandi salah.');
export const TOO_MANY_ATTEMPTS = msg('Terlalu banyak percobaan. Coba lagi dalam beberapa menit.');
export const FIELDS_REQUIRED = msg('Isi e-mail dan kata sandi.');
export const DELETE_CONFIRM_REQUIRED = msg('Centang konfirmasi untuk menghapus akun.');

// FN-50: the bot check and passkeys. One fixed message per refusal path; never a credential id, challenge or token.
export const BOT_CHECK_FAILED = msg(
	'Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.'
);
export const PASSKEY_REGISTER_FAILED = msg('Pendaftaran passkey gagal. Coba lagi.');
export const PASSKEY_SIGN_IN_FAILED = msg('Masuk dengan passkey gagal. Coba lagi.');
/** `trf` template: `{n}` is PASSKEY_MAX_PER_USER. */
export const PASSKEY_LIMIT = msg('Batas {n} passkey tercapai. Hapus satu dulu.');
export const PASSKEY_HOST_UNAVAILABLE = msg('Passkey tidak tersedia di alamat ini.');
/** The one answer for a passkey id that is unknown or belongs to someone else (no oracle). */
export const PASSKEY_NOT_FOUND = msg('Passkey tidak ditemukan.');
