import { msg } from '#lib/shared/i18n';
import { CATEGORY_NOT_FOUND } from '../categories/messages';
import { CATEGORY_REQUIRED, TRANSACTION_LIMIT, WALLET_REQUIRED } from '../transactions/messages';
import { WALLET_CHANGED, WALLET_NOT_FOUND } from '../wallets/messages';

/** Server answers of the /kotak-masuk actions (translated by the pages with tr()). */
export const DRAFTS_LOAD_FAILED = msg('Draf tidak bisa dimuat. Coba lagi sebentar lagi.');
/** One answer for a draft id that is missing, already saved or discarded, or in another space (no oracle). */
export const DRAFT_NOT_FOUND = msg('Draf tidak ditemukan.');
/** A stale form: FN-04's exact phrase, not a second key for the same meaning. */
export const DRAFT_CHANGED = WALLET_CHANGED;
export const NOTHING_SELECTED = msg('Pilih minimal satu draf.');
/** "Simpan" on a selection where no draft has both a wallet and a category yet: nothing was written. */
export const NONE_COMPLETE = msg(
	'Belum ada draf terpilih yang lengkap. Atur dompet dan kategorinya dulu.'
);
/** Every selected draft is gone (saved, discarded or never in this space): nothing to do. */
export const SELECTION_GONE = msg('Draf yang dipilih sudah tidak ada. Muat ulang lalu coba lagi.');
/** A bulk write met a draft that changed meanwhile: the whole request wrote nothing. */
export const SELECTION_CHANGED = msg(
	'Sebagian draf berubah sejak terakhir dimuat. Tidak ada yang disimpan. Muat ulang lalu coba lagi.'
);
/** Owner decision A: a mixed expense/income selection never gets one category. */
export const MIXED_KIND = msg(
	'Pilih draf dengan jenis yang sama untuk mengatur kategori sekaligus'
);
export const CATEGORY_KIND_MISMATCH = msg('Pilih kategori yang sesuai jenis draf yang dipilih.');
/** A draft's capture was already recorded from the same source (dedupe key): the batch wrote nothing. */
export const ALREADY_RECORDED = msg(
	'Salah satu draf sudah pernah tercatat dari sumber yang sama. Tidak ada yang disimpan. Abaikan draf itu, lalu coba lagi.'
);
export {
	CATEGORY_NOT_FOUND,
	CATEGORY_REQUIRED,
	TRANSACTION_LIMIT,
	WALLET_NOT_FOUND,
	WALLET_REQUIRED
};
