import { msg } from '#lib/shared/i18n';

/** Server answers of the /ruang actions (translated by the page with tr()). */
export const SPACE_NAME_REQUIRED = msg('Isi nama ruang.');
/** One answer for an unknown, malformed, expired or revoked invite (no oracle). */
export const INVITE_INVALID = msg('Tautan tidak ditemukan atau sudah tidak berlaku.');
export const SPACE_FULL = msg('Ruang ini sudah penuh.');
/** A stale form: the invite or member it names changed in another tab or by someone else. */
export const CHANGED_MEANWHILE = msg('Data sudah berubah. Muat ulang halaman lalu coba lagi.');
export const OWNER_STAYS = msg('Pemilik tidak bisa keluar atau dikeluarkan dari ruang.');
