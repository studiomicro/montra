import { msg } from '#lib/shared/i18n';
import { WALLET_CHANGED } from '../wallets/messages';

/** Server answers of FN-20's pages and actions (translated by the pages with tr()). */
export const RULES_LOAD_FAILED = msg('Aturan pedagang tidak bisa dimuat. Coba lagi sebentar lagi.');
/** One answer for a rule id that is missing, deleted or of another space (no oracle). */
export const RULE_NOT_FOUND = msg('Aturan tidak ditemukan.');
/** A stale form ("changed meanwhile"): FN-04's exact phrase, not a second key for the same meaning. */
export const RULE_CHANGED = WALLET_CHANGED;
export const DELETE_ALL_UNCONFIRMED = msg('Centang konfirmasi dulu untuk menghapus semua aturan.');
/** Without a key: FN-15/FN-22's exact phrase; the deterministic layers still worked, nothing was blocked. */
export { RECEIPT_NO_KEY as AI_KEY_HINT } from '../receipts/messages';
export const AI_NOT_CONFIGURED = msg('Saran kategori AI belum dikonfigurasi.');
export const AI_RATE_LIMITED = msg('Saran kategori AI sedang dibatasi. Coba lagi dalam satu jam.');
export const AI_FAILED = msg(
	'Saran kategori AI tidak bisa dibaca kali ini. Kategori lain tetap diisi.'
);
