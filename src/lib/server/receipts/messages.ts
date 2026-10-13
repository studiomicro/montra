import { msg } from '#lib/shared/i18n';

/**
 * Answers of /riwayat/struk (FN-15), translated by the page with tr(). Provider outcomes that FN-41 already
 * names (invalid key, quota, network) reuse AI_KEY_TEST_LABELS instead of a second wording.
 */
/** AI_GATEWAY_ACCOUNT_ID / AI_GATEWAY_ID unset: no receipt can be read on this server. */
export const RECEIPT_NOT_CONFIGURED = msg('Pembacaan struk dengan AI belum dikonfigurasi.');
/** The user has no personal Anthropic key (or it no longer opens). */
export const RECEIPT_NO_KEY = msg('Tambahkan kunci Anthropic di Pengaturan › Integrasi');
export const RECEIPT_NO_PHOTO = msg('Pilih foto struk dulu.');
/** Past what the provider accepts inline (refused before any call). */
export const RECEIPT_PHOTO_TOO_LARGE = msg(
	'Foto terlalu besar untuk dibaca. Paling besar 5 MB dan 8.000 piksel per sisi.'
);
/** The model's answer failed the schema, was cut off or was refused. */
export const RECEIPT_UNREADABLE = msg('Tidak bisa membaca strukmu');
/** The model said the photo shows no receipt. */
export const RECEIPT_NOT_A_RECEIPT = msg('Ini sepertinya bukan struk');
/** Anthropic answered 404 for the reading model (retired or not available to this key). */
export const RECEIPT_MODEL_UNAVAILABLE = msg(
	'Model pembaca struk tidak tersedia di Anthropic saat ini. Coba lagi nanti.'
);
export const RECEIPT_RATE_LIMITED = msg(
	'Terlalu banyak pembacaan struk. Coba lagi dalam beberapa menit.'
);
/** This server already handles as many receipt photos as it can hold at once (or this user has one in flight). */
export const RECEIPT_BUSY = msg(
	'Server sedang memproses foto struk lain. Coba lagi sebentar lagi.'
);
/** The edited figures do not add up and the user did not confirm saving anyway. */
export const RECEIPT_TOTAL_MISMATCH = msg('Periksa totalnya');
export const RECEIPT_TOTAL_REQUIRED = msg('Isi totalnya.');
export const RECEIPT_ITEMS_REQUIRED = msg('Isi nama dan harga setiap barang.');
export const RECEIPT_SPLIT_DISCOUNT = msg(
	'Diskon lebih besar dari pajak dan servis — gunakan “Satu transaksi”'
);
/** Every row of this photo was saved before (or deleted after saving): nothing is written again. */
export const RECEIPT_ALREADY_SAVED = msg('Struk ini sudah pernah disimpan.');
/** `save` without a fresh read of this very photo (no ticket, another photo, or older than a day). */
export const RECEIPT_READ_FIRST = msg('Baca struk ini dulu sebelum menyimpan.');
export const RECEIPT_SAVE_FAILED = msg('Struk tidak bisa disimpan. Coba lagi sebentar lagi.');
/** Title of the split's combined tax, service and discount row. */
export const RECEIPT_ADJUSTMENTS_TITLE = msg('Pajak & servis');
/** Title of a receipt whose shop name was not legible. */
export const RECEIPT_UNNAMED_TITLE = msg('Struk');
/** Labels of the "Satu transaksi" note lines. */
export const RECEIPT_NOTE_TAX = msg('Pajak');
export const RECEIPT_NOTE_SERVICE = msg('Servis');
export const RECEIPT_NOTE_DISCOUNT = msg('Diskon');
export const RECEIPT_NOTE_TOTAL = msg('Total');
