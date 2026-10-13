import { msg } from '#lib/shared/i18n';

/** Server answers of the net-worth actions (FN-25), translated by the page with tr(). */
export const NW_NAME_INVALID = msg('Isi nama aset, paling banyak 60 karakter.');
export const NW_KIND_INVALID = msg('Pilih jenis aset.');
export const NW_CURRENCY_INVALID = msg('Pilih mata uang dari daftar.');
export const NW_SOURCE_INVALID = msg('Sumber harga ini tidak tersedia untuk jenis aset tersebut.');
export const NW_SYMBOL_INVALID = msg('Isi kode koin seperti di Indodax, misalnya BTC.');
/** A coin code absent from the latest cached Indodax ticker (red team M2): never stored as a priced item. */
export const NW_SYMBOL_UNKNOWN = msg(
	'Kode koin ini tidak ada di Indodax. Periksa kodenya atau pilih nilai yang kamu isi sendiri.'
);
export const NW_QUANTITY_REQUIRED = msg('Isi jumlah yang kamu punya.');
export const NW_QUANTITY_INVALID = msg(
	'Jumlah harus angka lebih dari nol. Pakai koma untuk desimal, tanpa titik ribuan.'
);
export const NW_QUANTITY_PRECISION = msg('Jumlah punya terlalu banyak angka di belakang koma.');
export const NW_VALUE_REQUIRED = msg('Isi nilainya sekarang dengan angka bulat lebih dari nol.');
export const NW_VALUE_INVALID = msg('Nilai harus angka bulat lebih dari nol, tanpa sen.');
/** FN-47: the same refusal for a currency with cents (every wallet currency but IDR and JPY). */
export const NW_VALUE_INVALID_CENTS = msg(
	'Nilai harus lebih dari nol, maksimal 2 angka di belakang koma.'
);
export const NW_VALUE_TOO_LARGE = msg('Nilai terlalu besar.');
export const NW_DATE_INVALID = msg('Tanggal tidak valid.');
export const NW_NOTE_INVALID = msg('Catatan paling banyak 200 karakter.');
/** One answer for an item that is missing, deleted or in another space (no oracle). */
export const NW_NOT_FOUND = msg('Aset tidak ditemukan.');
/** A stale form: FN-04's exact phrase (same i18n key). */
export const NW_CHANGED = msg('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.');
export const NW_LIMIT = msg('Ruang ini sudah punya 200 aset, batas terbanyak.');
export const NW_LOAD_FAILED = msg('Kekayaan bersih tidak bisa dimuat. Coba lagi sebentar lagi.');
