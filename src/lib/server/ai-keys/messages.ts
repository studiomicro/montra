import { msg } from '#lib/shared/i18n';

/** Server answers of the /pengaturan/integrasi actions (translated by the page with tr()). */
export const AI_KEYS_LOAD_FAILED = msg(
	'Integrasi AI tidak bisa dimuat. Periksa koneksi lalu coba lagi.'
);
/** AI_KEYS_ENCRYPTION_KEY is unset or malformed: nothing can be stored. */
export const AI_KEYS_NOT_CONFIGURED = msg('Belum dikonfigurasi');
export const AI_KEY_INVALID_FORMAT = msg(
	'Itu bukan kunci Anthropic. Kunci diawali “sk-ant-” dan panjangnya 20–300 karakter.'
);
export const AI_KEY_SAVE_FAILED = msg('Kunci tidak bisa disimpan. Periksa koneksi lalu coba lagi.');
export const AI_KEY_MISSING = msg('Belum ada kunci API');
/** The stored key no longer opens (the encryption secret changed): the user enters it again. */
export const AI_KEY_UNREADABLE = msg(
	'Kunci tersimpan tidak bisa dibuka lagi. Ganti kunci untuk melanjutkan.'
);
/** The key was replaced or removed while "Tes koneksi" ran: the result is not stored. */
export const AI_KEY_CHANGED_MEANWHILE = msg(
	'Kunci berubah selama diuji. Muat ulang halaman lalu coba lagi.'
);
/** AI_GATEWAY_ACCOUNT_ID / AI_GATEWAY_ID unset: "Tes koneksi" is unavailable. */
export const AI_TEST_NOT_CONFIGURED = msg('Tes koneksi belum dikonfigurasi di server ini.');
export const AI_TEST_RATE_LIMITED = msg(
	'Terlalu banyak tes koneksi. Coba lagi dalam beberapa menit.'
);
