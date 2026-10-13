import { msg } from '#lib/shared/i18n';

/**
 * Server answers of the collectibles actions (translated by the page with tr()). The purchase price, purchase
 * date, note and stale-form answers are FN-27's own phrases, imported from belongings/messages.ts.
 */
export const NAME_INVALID = msg('Isi nama koleksi, paling banyak 80 karakter.');
export const VALUE_INVALID = msg('Isi nilai sekarang dengan angka bulat, tanpa sen.');
/** One answer for an id that is missing, deleted, or belongs to another space (no oracle). */
export const COLLECTIBLE_NOT_FOUND = msg('Koleksi tidak ditemukan.');
export const COLLECTIBLE_LIMIT = msg('Ruang ini sudah punya 300 koleksi, batas terbanyak.');
export const COLLECTIBLES_LOAD_FAILED = msg(
	'Daftar koleksi tidak bisa dimuat. Coba lagi sebentar lagi.'
);
/** A `Data demo` row is read-only: never edited into (or deleted as if it were) a real item. */
export const COLLECTIBLE_DEMO_READONLY = msg('Data demo tidak bisa diubah.');
