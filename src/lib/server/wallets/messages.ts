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
/* FN-55a: credit-card wallets. */
export const CARD_BALANCE_INVALID = msg(
	'Isi tagihan dengan angka, maksimal 2 angka di belakang koma.'
);
export const CARD_LIMIT_INVALID = msg(
	'Isi limit kredit dengan jumlah lebih dari 0, maksimal 2 angka di belakang koma.'
);
export const CARD_DAY_INVALID = msg('Isi tanggal 1 sampai 31, atau kosongkan.');
export const CARD_FIELD_ONLY = msg(
	'Hanya untuk kartu kredit. Kosongkan kolom ini atau pilih jenis Kartu kredit.'
);
/** A card wallet with imported statements cannot become another type (the statements need a card). */
export const CARD_TYPE_LOCKED = msg(
	'Kartu ini punya tagihan yang diimpor. Urungkan impor tagihannya dulu untuk mengganti jenis dompet.'
);
/** FN-55 red team L2: a wallet with imported account statements cannot become a card (the sign would flip). */
export const BANK_STATEMENTS_TYPE_LOCKED = msg(
	'Dompet ini punya mutasi rekening yang diimpor. Urungkan atau pindahkan impor itu dulu untuk menjadikannya kartu kredit.'
);
/* FN-58 pass 1: e-money card wallets. */
export const EMONEY_ISSUER_REQUIRED = msg('Pilih penerbit kartu e-money.');
export const EMONEY_FIELD_ONLY = msg(
	'Hanya untuk kartu e-money. Kosongkan pilihan ini atau pilih jenis Kartu e-money.'
);
