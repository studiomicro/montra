import { msg } from '../../shared/i18n.ts';

/**
 * Answers of /tanya and /pengaturan/ingatan (FN-22), translated by the page with tr(). Provider outcomes FN-41
 * already names (invalid key, quota, network) reuse AI_KEY_TEST_LABELS instead of a second wording.
 */
/** AI_GATEWAY_ACCOUNT_ID / AI_GATEWAY_ID unset: no question can be answered on this server. */
export const TANYA_NOT_CONFIGURED = msg('Asisten AI belum dikonfigurasi.');
/** The user has no personal Anthropic key (or it no longer opens). */
export const TANYA_NO_KEY = msg('Tambahkan kunci Anthropic di Pengaturan › Integrasi');
export const TANYA_EMPTY = msg('Tulis pertanyaanmu dulu.');
export const TANYA_RATE_LIMITED = msg('Terlalu banyak pertanyaan. Coba lagi dalam beberapa menit.');
/** This user already has a question in flight here, or the server holds as many as it can. */
export const TANYA_BUSY = msg('Tanya masih menjawab pertanyaan lain. Coba lagi sebentar lagi.');
/** Anthropic answered 404 for the model (retired or not available to this key). */
export const TANYA_MODEL_UNAVAILABLE = msg(
	'Model asisten tidak tersedia di Anthropic saat ini. Coba lagi nanti.'
);
/** The whole question passed its deadline (one provider call or all of them). */
export const TANYA_TIMEOUT = msg('Tanya terlalu lama menjawab. Coba lagi.');
/** The provider's answer could not be read, or it was cut off before the end. */
export const TANYA_MALFORMED = msg('Jawaban asisten tidak bisa dibaca. Coba lagi.');
export const TANYA_CUT_OFF = msg('Jawaban asisten terpotong. Coba pertanyaan yang lebih singkat.');
/** The model declined to answer (`stop_reason: refusal`). */
export const TANYA_REFUSED = msg('Asisten tidak bisa menjawab pertanyaan ini.');
/** The model kept asking for data past the round limit. */
export const TANYA_TOO_MANY_ROUNDS = msg(
	'Tanya tidak bisa menjawab pertanyaan ini dari catatanmu. Coba tanyakan lebih spesifik.'
);
export const TANYA_SAVE_FAILED = msg('Jawaban tidak bisa disimpan. Coba lagi sebentar lagi.');
export const TANYA_LOAD_FAILED = msg('Percakapan tidak bisa dimuat. Coba lagi sebentar lagi.');
export const TANYA_CLEAR_FAILED = msg('Percakapan tidak bisa dihapus. Coba lagi sebentar lagi.');
/** Shown instead of model prose that held a figure the server could not check (answer-guard.ts). */
export const TANYA_FIGURES_ONLY = msg('Ini angka dari catatanmu.');
