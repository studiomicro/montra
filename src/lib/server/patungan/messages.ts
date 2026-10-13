import { msg } from '#lib/shared/i18n';
import { WALLET_CHANGED } from '../wallets/messages';

/** Server answers of the /patungan actions (translated by the pages with tr()). */
export const TITLE_REQUIRED = msg('Isi nama patungan.');
export const MODE_INVALID = msg('Pilih cara membagi.');
export const PEOPLE_COUNT = msg('Pilih minimal 1 orang lain, paling banyak 19.');
export const GUEST_NAME_INVALID = msg('Isi nama teman, paling banyak 80 huruf.');
export const MEMBER_NOT_FOUND = msg('Anggota ini sudah tidak ada di ruang.');
export const TOTAL_INVALID = msg('Isi total tagihan lebih dari 0.');
export const TOTAL_TOO_SMALL = msg('Total terlalu kecil untuk dibagi ke semua orang.');
export const SHARE_INVALID = msg('Isi bagian setiap orang lebih dari 0.');
/** `exact`: the typed shares do not add up to the total (the page shows the difference beside it). */
export const SUM_MISMATCH = msg('Jumlah semua bagian harus sama dengan totalnya.');
export const NOTE_TOO_LONG = msg('Catatan paling banyak 500 huruf.');
/** The chosen bill row cannot be linked: not a live expense of this space, already linked, or another amount. */
export const BILL_UNAVAILABLE = msg(
	'Transaksi ini tidak bisa ditautkan: harus pengeluaran yang belum tertaut ke patungan lain, dengan total yang sama persis.'
);
/** One answer for a split id that is missing, deleted or in another space (no oracle). */
export const SPLIT_NOT_FOUND = msg('Patungan tidak ditemukan.');
export const SPLIT_CHANGED = WALLET_CHANGED;
/** Only the payer (who created the split) may change, settle, link or delete it. */
export const PAYER_ONLY = msg('Hanya pembayar yang bisa mengubah patungan ini.');
/** Someone already paid: the people and their shares are fixed now (title, note and date stay editable). */
export const SPLIT_LOCKED = msg(
	'Sudah ada yang membayar, jadi orang dan bagiannya tidak bisa diubah lagi. Nama, tanggal dan catatan tetap bisa.'
);
export const SPLIT_LIMIT = msg('Ruang ini sudah punya 1.000 patungan, batas terbanyak.');
export const SPLITS_LOAD_FAILED = msg('Patungan tidak bisa dimuat. Coba lagi sebentar lagi.');
/** The split already has a linked transaction (unlink it first). */
export const ALREADY_LINKED = msg('Patungan ini sudah tertaut ke transaksi.');
