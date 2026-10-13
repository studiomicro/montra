import { msg } from '#lib/shared/i18n';

/** Server answers of the /pengaturan/kategori actions (translated by the page with tr()). */
export const CATEGORY_NAME_REQUIRED = msg('Isi nama kategori.');
export const CATEGORY_TILE_INVALID = msg('Pilih ikon dari daftar.');
export const CATEGORY_KIND_INVALID = msg('Pilih jenis kategori.');
/** One answer for a category id that is missing or belongs to another space (no oracle). */
export const CATEGORY_NOT_FOUND = msg('Kategori tidak ditemukan.');
export const CATEGORY_LIMIT = msg('Ruang ini sudah punya 100 kategori, batas terbanyak.');
export const CATEGORIES_LOAD_FAILED = msg('Kategori tidak bisa dimuat. Coba lagi sebentar lagi.');

// FN-48 "Rapikan kategori".
export const CLEANUP_LOAD_FAILED = msg('Daftar transaksi untuk dirapikan tidak bisa dimuat.');
export const CLEANUP_NONE_SELECTED = msg('Pilih minimal satu transaksi.');
export const CLEANUP_NOTHING = msg('Transaksi yang dipilih tidak perlu dirapikan lagi.');
export const CLEANUP_NOT_FOUND = msg('Perapian ini tidak ditemukan.');
export const CLEANUP_ALREADY_APPLIED = msg('Perapian ini sudah diterapkan.');
export const CLEANUP_ALREADY_UNDONE = msg('Perapian ini sudah diurungkan.');
