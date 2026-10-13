import { msg } from '#lib/shared/i18n';

/** Server answers of the /impor/cocokkan-transfer actions (FN-48 Part C; translated by the page with tr()). */
export const TRANSFER_MATCH_LOAD_FAILED = msg('Daftar pasangan transfer tidak bisa dimuat.');
/** One answer for a pair or link that is missing, no longer eligible, or belongs to another space (no oracle). */
export const TRANSFER_PAIR_NOT_FOUND = msg('Pasangan transfer ini tidak ditemukan.');
export const TRANSFER_LINK_NOT_FOUND = msg('Pencocokan ini tidak ditemukan.');
export const TRANSFER_ALREADY_MERGED = msg('Pasangan ini sudah dicocokkan.');
export const TRANSFER_ALREADY_UNDONE = msg('Pencocokan ini sudah diurungkan.');
export const TRANSFER_PAIR_REQUIRED = msg('Pilih satu pasangan transfer.');
