import { msg } from '#lib/shared/i18n';
import { WALLET_CHANGED } from '../wallets/messages';

/** Server answers of the /riwayat/berulang actions (translated by the pages with tr()). */
export const TYPE_INVALID = msg('Pilih pengeluaran atau pemasukan.');
export const FREQUENCY_INVALID = msg('Pilih bulanan atau mingguan.');
export const DAY_INVALID = msg('Pilih tanggal 1 sampai 31.');
export const WEEKDAY_INVALID = msg('Pilih hari dalam seminggu.');
export const START_INVALID = msg('Pilih tanggal mulai yang benar.');
export const END_INVALID = msg('Pilih tanggal selesai yang benar, atau kosongkan.');
/** The end date comes before the first instance the series would create. */
export const END_BEFORE_FIRST = msg('Tanggal selesai lebih awal dari transaksi pertama seri ini.');
/** One answer for a series id that is missing, deleted or in another space (no oracle). */
export const SERIES_NOT_FOUND = msg('Transaksi berulang tidak ditemukan.');
/** A stale form: FN-04's exact phrase (same i18n key), not a re-keyed copy. */
export const SERIES_CHANGED = WALLET_CHANGED;
export const SERIES_LIMIT = msg('Ruang ini sudah punya 100 transaksi berulang, batas terbanyak.');
export const SERIES_LOAD_FAILED = msg(
	'Transaksi berulang tidak bisa dimuat. Coba lagi sebentar lagi.'
);
/** Resume or pause asked of a series that is stopped (or already in that state). */
export const SERIES_STOPPED = msg('Seri ini sudah dihentikan.');
