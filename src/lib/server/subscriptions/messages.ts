import { msg } from '#lib/shared/i18n';
import { WALLET_CHANGED } from '../wallets/messages';

/** Server answers of the /langganan actions (translated by the page with tr()). */
export const NAME_INVALID = msg('Isi nama langganan, paling banyak 60 karakter.');
export const CATALOGUE_INVALID = msg('Pilih layanan dari daftar, atau Lainnya.');
export const CATEGORY_INVALID = msg('Pilih kategori langganan.');
export const AMOUNT_INVALID = msg('Isi biaya lebih dari 0 dengan angka bulat, tanpa sen.');
/** FN-47: the same refusal for a currency with cents (every wallet currency but IDR and JPY). */
export const AMOUNT_INVALID_CENTS = msg(
	'Isi biaya lebih dari 0, maksimal 2 angka di belakang koma.'
);
export const AMOUNT_TOO_LARGE = msg('Biaya terlalu besar untuk satu langganan.');
export const CURRENCY_INVALID = msg('Pilih mata uang dari daftar.');
export const CYCLE_INVALID = msg('Pilih siklus tagihan.');
export const DAY_INVALID = msg('Pilih tanggal tagihan yang benar.');
export const WEEKDAY_INVALID = msg('Pilih hari tagihan.');
export const MONTH_INVALID = msg('Pilih bulan tagihan.');
export const REMINDER_INVALID = msg('Pilih pengingat 0 sampai 14 hari sebelumnya.');
/** The chosen wallet is missing, archived, in another space or of another currency. */
export const WALLET_INVALID = msg('Pilih dompet dengan mata uang yang sama, atau tanpa dompet.');
/** One answer for a subscription id that is missing, deleted or in another space (no oracle). */
export const SUBSCRIPTION_NOT_FOUND = msg('Langganan tidak ditemukan.');
/** A stale form: FN-04's exact phrase (same i18n key), not a re-keyed copy. */
export const SUBSCRIPTION_CHANGED = WALLET_CHANGED;
export const SUBSCRIPTION_LIMIT = msg('Ruang ini sudah punya 100 langganan, batas terbanyak.');
export const SUBSCRIPTIONS_LOAD_FAILED = msg(
	'Langganan tidak bisa dimuat. Coba lagi sebentar lagi.'
);
/** A `Data demo` subscription is never turned into (or linked to) a real payment. */
export const DEMO_NOT_PAYABLE = msg('Langganan Data demo tidak bisa ditandai sudah dibayar.');
/** "Tandai sudah dibayar": no way chosen. */
export const PAY_MODE_INVALID = msg('Pilih catat transaksi baru atau hubungkan transaksi.');
/** The chosen existing transaction is missing, deleted, in another space or not this bill's currency. */
export const PAY_TRANSACTION_NOT_FOUND = msg(
	'Transaksi tidak ditemukan. Pilih pengeluaran dengan mata uang yang sama.'
);
/** FN-26b "Bukan langganan": the key is no longer a candidate here (added, its rows deleted, another space). */
export const CANDIDATE_NOT_FOUND = msg(
	'Kemungkinan langganan ini sudah tidak ada. Muat ulang halaman.'
);
