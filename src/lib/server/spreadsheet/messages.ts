import { msg } from '#lib/shared/i18n';

/** Server answers of the spreadsheet import (FN-17), translated by the page with tr(). Never a path or cell. */
export const SHEET_FILE_REQUIRED = msg('Pilih berkas .xlsx dulu.');
export const SHEET_FILE_EMPTY = msg('Berkas spreadsheet kosong.');
export const SHEET_TOO_LARGE = msg(
	'Berkas spreadsheet terlalu besar (batas 5 MB, isi terbuka 50 MB). Pisahkan menjadi beberapa berkas.'
);
export const SHEET_CSV_HERE = msg(
	'Ini berkas CSV. Impor lewat bagian Impor mutasi (CSV) atau Impor mutasi (PDF/CSV).'
);
export const SHEET_LEGACY = msg(
	'Format .xls, .xlsb, .ods dan .numbers belum didukung. Simpan ulang sebagai .xlsx atau CSV.'
);
export const SHEET_MACRO = msg(
	'Berkas berisi makro (.xlsm) tidak dibaca. Simpan ulang sebagai .xlsx tanpa makro atau CSV.'
);
export const SHEET_ENCRYPTED = msg(
	'Berkas ini dikunci sandi. Buka di Excel, hapus sandinya, simpan sebagai .xlsx, lalu coba lagi.'
);
export const SHEET_NOT_XLSX = msg('Berkas ini bukan spreadsheet .xlsx yang bisa dibaca.');
export const SHEET_CORRUPT = msg(
	'Berkas .xlsx rusak atau tidak lengkap. Simpan ulang lalu coba lagi.'
);
export const SHEET_UNSAFE = msg(
	'Berkas ini memuat bagian yang tidak aman dibaca, jadi ditolak. Simpan ulang dari Excel atau Google Sheets.'
);
export const SHEET_TOO_COMPLEX = msg(
	'Berkas ini terlalu rumit untuk dibaca di sini. Hapus tab yang tidak perlu lalu coba lagi.'
);
export const SHEET_TOO_MANY_COLUMNS = msg(
	'Ada tab dengan isi lebih dari 50 kolom. Hapus kolom yang tidak perlu lalu coba lagi.'
);
export const SHEET_NO_SHEETS = msg('Tidak ada tab yang terlihat di berkas ini.');
export const SHEET_NOT_TRANSACTIONS = msg(
	'Berkas ini tampak seperti anggaran atau daftar aset, bukan catatan transaksi.'
);
export const SHEET_FIELDS_INVALID = msg(
	'Pemetaan kolom tidak valid. Baca berkas lagi lalu pilih ulang.'
);
export const SHEET_WALLET_REQUIRED = msg('Pilih dompet untuk impor ini.');
export const SHEET_NOTHING_MAPPED = msg(
	'Belum ada tab yang siap. Pilih kolom Tanggal dan Jumlah (atau Masuk/Keluar) lalu tekan Pakai pemetaan ini.'
);
export const SHEET_RATE_LIMITED = msg(
	'Terlalu banyak unggahan spreadsheet. Coba lagi dalam beberapa menit.'
);
export const SHEET_BUSY = msg('Sedang membaca spreadsheet lain. Coba lagi dalam setengah menit.');

/* AI mapping suggestion (BYOK). */
export const SHEET_AI_NOT_CONFIGURED = msg('Belum dikonfigurasi');
export const SHEET_AI_NO_KEY = msg('Tambahkan kunci Anthropic di Pengaturan › Integrasi AI');
export const SHEET_AI_UNUSABLE = msg('Saran AI tidak bisa dipakai, pilih kolom manual');
export const SHEET_AI_RATE_LIMITED = msg(
	'Terlalu banyak permintaan saran AI. Coba lagi dalam beberapa menit.'
);
export const SHEET_AI_TAB_INVALID = msg('Pilih tab yang perlu pemetaan.');
