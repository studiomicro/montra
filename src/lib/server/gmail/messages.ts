import { msg } from '#lib/shared/i18n';

/**
 * Server answers of /pengaturan/aplikasi/gmail (translated by the page with tr()). Never a path, a secret name, an
 * internal id or Google's own error text.
 */
export const GMAIL_LOAD_FAILED = msg('Gmail tidak bisa dimuat. Periksa koneksi lalu coba lagi.');
export const GMAIL_NOT_CONFIGURED = msg('Belum dikonfigurasi');
export const GMAIL_MISSING_CLIENT = msg('ID klien Google belum dipasang.');
export const GMAIL_MISSING_REDIRECT = msg('Alamat pengalihan belum dipasang.');
export const GMAIL_MISSING_KEY = msg('Kunci enkripsi belum dipasang.');
export const GMAIL_ALREADY_CONNECTED = msg('Gmail sudah terhubung. Muat ulang halaman.');
export const GMAIL_NOT_CONNECTED = msg('Gmail belum terhubung. Muat ulang halaman.');
export const GMAIL_CHANGED_MEANWHILE = msg(
	'Sambungan Gmail berubah di tab lain. Muat ulang halaman lalu coba lagi.'
);
export const GMAIL_SPACE_NOT_AVAILABLE = msg('Ruang itu tidak tersedia.');
export const GMAIL_RATE_LIMITED = msg('Terlalu banyak percobaan. Coba lagi dalam beberapa menit.');
export const GMAIL_SESSION_REQUIRED = msg('Sesi tidak ditemukan. Masuk lagi lalu coba lagi.');
export const GMAIL_LOOKBACK_PLAN = msg('Tersedia di paket Pro');
export const GMAIL_LOOKBACK_INVALID = msg('Pilih rentang waktu dari daftar.');
export const GMAIL_LOOKBACK_RUNNING = msg('Pemindaian lain masih berjalan.');
export const GMAIL_LOOKBACK_LIMIT = msg(
	'Sudah 3 pemindaian dalam 24 jam terakhir. Coba lagi besok.'
);
export const GMAIL_CHECK_RECENT = msg('Baru saja diperiksa. Coba lagi dalam 5 menit.');
export const GMAIL_QUEUE_FAILED = msg('Tidak bisa memulai sekarang. Coba lagi sebentar lagi.');
export const GMAIL_NEEDS_RECONNECT = msg('Hubungkan ulang Gmail dulu.');

/** The result of the OAuth callback, shown once on the settings page (a short-lived cookie carries the code). */
export const GMAIL_CALLBACK_RESULTS = {
	connected: msg('Gmail terhubung. Pembayaran baru akan muncul di Kotak masuk dalam satu jam.'),
	cancelled: msg('Kamu membatalkan izin.'),
	scope: msg('Izin baca e-mail tidak diberikan. Mulai lagi dan centang izin membaca e-mail.'),
	failed: msg('Sambungan tidak bisa diselesaikan. Mulai lagi.')
} as const;
export type GmailCallbackResult = keyof typeof GMAIL_CALLBACK_RESULTS;

// ---- FN-19b follow-ups -----------------------------------------------------------------------------------------
export const GMAIL_AUTOSAVE_WALLET = msg('Pilih dompet rupiah dari ruang tujuan.');
export const GMAIL_AUTOSAVE_SPACE = msg(
	'Kamu bukan anggota ruang tujuan lagi. Pilih ruang lain dulu.'
);
export const GMAIL_SCAN_NOT_FOUND = msg('Pemindaian itu tidak ditemukan. Muat ulang halaman.');
export const GMAIL_UNDO_ALREADY = msg('Sudah diurungkan');
export const GMAIL_REVIEW_LOAD_FAILED = msg(
	'Transaksi dari Gmail tidak bisa dimuat. Periksa koneksi lalu coba lagi.'
);
export const GMAIL_SAVE_STALE = msg(
	'Ada draf yang berubah di tab lain. Muat ulang lalu coba lagi.'
);
export const GMAIL_SAVE_LIMIT = msg('Batas jumlah transaksi ruang ini sudah tercapai.');
export const GMAIL_SAVE_DUPLICATE = msg(
	'Sebagian sudah pernah disimpan. Muat ulang lalu coba lagi.'
);
export const GMAIL_NOTIFY_CHANGED = msg(
	'Pengaturan pemberitahuan berubah di tab lain. Muat ulang halaman lalu coba lagi.'
);
export const GMAIL_SAVE_CATEGORY = msg('Pilih kategori pengeluaran dari daftar.');
export const GMAIL_SAVE_NONE = msg('Tidak ada draf yang menunggu dari pemindaian ini.');
