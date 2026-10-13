import { msg } from '#lib/shared/i18n';
import { WALLET_CHANGED, WALLET_NOT_FOUND } from '../wallets/messages';
import { CATEGORY_NOT_FOUND } from '../categories/messages';

/** Server answers of the /riwayat actions (translated by the pages with tr()). */
export const TYPE_INVALID = msg('Pilih jenis transaksi.');
export const AMOUNT_INVALID = msg('Isi jumlah lebih dari 0 dengan angka bulat, tanpa sen.');
/** FN-47: the same refusal for a currency with cents (every wallet currency but IDR and JPY). */
export const AMOUNT_INVALID_CENTS = msg(
	'Isi jumlah lebih dari 0, maksimal 2 angka di belakang koma.'
);
export const AMOUNT_TOO_LARGE = msg('Jumlah terlalu besar untuk satu transaksi.');
/** Most live transactions one space holds (keeps every total countable and the table bounded). */
export const TRANSACTION_LIMIT = msg('Ruang ini sudah punya 100.000 transaksi, batas terbanyak.');
/** Past the per-user budget of creating actions (create-limit.ts): nothing was written. */
export const TRANSACTION_RATE_LIMITED = msg(
	'Terlalu banyak transaksi baru dalam beberapa menit terakhir. Tunggu sebentar, lalu coba lagi.'
);
export const WALLET_REQUIRED = msg('Pilih dompet.');
export const TRANSFER_TO_REQUIRED = msg('Pilih dompet tujuan.');
export const TRANSFER_SAME_WALLET = msg('Pilih dompet tujuan yang berbeda dari dompet asal.');
export const TRANSFER_CURRENCY = msg('Transfer antar mata uang berbeda belum didukung.');
export const CATEGORY_REQUIRED = msg('Pilih kategori.');
/** A captured amount's currency differs from the chosen wallet's (amounts are never converted silently). */
export const CURRENCY_MISMATCH = msg(
	'Pilih dompet dengan mata uang yang sama dengan transaksinya.'
);
export const CATEGORY_KIND_MISMATCH = msg('Pilih kategori yang sesuai jenis transaksi.');
export const DATE_INVALID = msg('Pilih tanggal yang benar.');
export const TIME_INVALID = msg('Isi waktu dengan format jam:menit, misalnya 08:30.');
/** Same answers as the wallet and category screens: an id from another space reads as not found. */
export { WALLET_NOT_FOUND, CATEGORY_NOT_FOUND };
/** The wallet, category or membership changed between the form check and the write: nothing was written. */
export const REFS_GONE = msg('Dompet atau kategori sudah berubah. Muat ulang lalu coba lagi.');
/** One answer for a transaction id that is missing, deleted or in another space (no oracle). */
export const TRANSACTION_NOT_FOUND = msg('Transaksi tidak ditemukan.');
/** A stale form: FN-04's exact phrase, not a second key for the same meaning. */
export const TRANSACTION_CHANGED = WALLET_CHANGED;
/** FN-49: an edit would change the amount, currency or type of a split's bill: nothing was written. */
export const TRANSACTION_LINKED = msg(
	'Transaksi ini tertaut ke patungan. Lepas tautannya dulu untuk mengubah jumlah, mata uang atau jenisnya.'
);
export const TRANSACTIONS_LOAD_FAILED = msg(
	'Transaksi tidak bisa dimuat. Coba lagi sebentar lagi.'
);
/** FN-14 "Simpan N transaksi" with no rows (or a form without its submission key). */
export const VOICE_NOTHING = msg(
	'Tidak ada transaksi untuk disimpan. Ucapkan atau ketik kalimatnya dulu.'
);
/** One or more review rows were refused: nothing was saved, each row shows its own error. */
export const VOICE_ROWS_INVALID = msg('Belum ada yang disimpan. Periksa baris yang ditandai.');
/** The same review form (or "Catat lagi" tap) was sent again after it was saved: nothing new was written. */
export const VOICE_DUPLICATE = msg('Sudah disimpan sebelumnya. Tidak ada yang dicatat dua kali.');
/** FN-37: the stated balance equals the wallet's balance now; nothing is written (never a zero-amount row). */
export const ADJUSTMENT_SAME = msg('Saldo sudah sama, tidak ada perubahan.');
export const ADJUSTMENT_TOO_LARGE = msg('Selisih saldo terlalu besar untuk satu penyesuaian.');
export const BALANCE_INVALID = msg('Isi saldo baru dengan angka bulat, tanpa sen.');
/** FN-47: the same refusal for a currency with cents (every wallet currency but IDR and JPY). */
export const BALANCE_INVALID_CENTS = msg(
	'Isi saldo baru dengan maksimal 2 angka di belakang koma.'
);
/** The wallet's balance kept changing between reading it and writing the adjustment: nothing was written. */
export const ADJUSTMENT_CHANGED = msg(
	'Saldo dompet baru saja berubah. Periksa saldo sekarang lalu coba lagi.'
);
