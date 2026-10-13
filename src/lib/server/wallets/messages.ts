import { msg } from '#lib/shared/i18n';

/** Server answers of the /dompet wallet actions (translated by the page with tr()). */
export const NAME_REQUIRED = msg('Isi nama dompet.');
export const TYPE_INVALID = msg('Pilih jenis dompet.');
export const CURRENCY_INVALID = msg('Pilih mata uang dari daftar.');
export const CURRENCY_LOCKED = msg('Mata uang tidak bisa diubah setelah dompet punya transaksi.');
export const BALANCE_INVALID = msg('Isi saldo awal dengan angka bulat, tanpa sen.');
/** FN-47: the same refusal for a currency with cents (every wallet currency but IDR and JPY). */
export const BALANCE_INVALID_CENTS = msg(
	'Isi saldo awal dengan maksimal 2 angka di belakang koma.'
);
export const LAST_FOUR_INVALID = msg('Isi tepat 4 angka terakhir saja, bukan nomor lengkap.');
/** One answer for a wallet id that is missing or belongs to another space (no oracle). */
export const WALLET_NOT_FOUND = msg('Dompet tidak ditemukan.');
/** A stale form: the wallet changed in another tab or by another member since the page loaded. */
export const WALLET_CHANGED = msg('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.');
export const WALLET_LIMIT = msg('Ruang ini sudah punya 50 dompet, batas terbanyak.');
export const LOAD_FAILED = msg('Dompet tidak bisa dimuat. Coba lagi sebentar lagi.');
