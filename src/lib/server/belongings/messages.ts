import { msg } from '#lib/shared/i18n';

/** Server answers of the belongings actions (translated by the page with tr()). */
export const NAME_INVALID = msg('Isi nama barang, paling banyak 80 karakter.');
export const PRICE_INVALID = msg('Isi harga beli dengan angka bulat, tanpa sen.');
export const VALUE_INVALID = msg(
	'Isi nilai sekarang dengan angka bulat tanpa sen, atau kosongkan untuk memakai estimasi.'
);
export const PURCHASED_ON_INVALID = msg('Pilih tanggal beli yang benar, paling lambat hari ini.');
export const NOTE_INVALID = msg('Catatan paling banyak 300 karakter.');
/** One answer for an id that is missing, deleted, or belongs to another space (no oracle). */
export const BELONGING_NOT_FOUND = msg('Barang tidak ditemukan.');
/** A stale form: FN-04's exact phrase (same i18n key). */
export const BELONGING_CHANGED = msg('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.');
export const BELONGING_LIMIT = msg('Ruang ini sudah punya 300 barang, batas terbanyak.');
export const BELONGINGS_LOAD_FAILED = msg(
	'Daftar barang tidak bisa dimuat. Coba lagi sebentar lagi.'
);
