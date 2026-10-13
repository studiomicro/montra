import { msg } from '#lib/shared/i18n';

/** Answers of the /pengaturan/api actions (FN-38), translated by the page with tr()/trf(). */
export const TOKEN_NAME_REQUIRED = msg('Beri nama token, misalnya nama skripnya.');
export const TOKEN_SCOPE_INVALID = msg('Pilih izin token.');
export const TOKEN_LIFETIME_INVALID = msg('Pilih masa berlaku token.');
export const TOKEN_SPACE_UNAVAILABLE = msg('Ruang itu tidak tersedia lagi. Pilih ruang lain.');
/** `{n}`: API_TOKEN_MAX_PER_USER. */
export const TOKEN_LIMIT = msg(
	'Sudah ada {n} token aktif, batas terbanyak. Cabut satu token dulu.'
);
export const TOKEN_NOT_FOUND = msg('Token tidak ditemukan atau sudah dicabut.');
export const TOKENS_LOAD_FAILED = msg('Token tidak bisa dimuat. Coba lagi sebentar lagi.');
