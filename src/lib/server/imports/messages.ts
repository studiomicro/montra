import { msg } from '#lib/shared/i18n';

/** Server answers of the /impor actions (translated by the page with tr()). Never a path, row id or stack. */
export const FILE_REQUIRED = msg('Pilih berkas CSV dulu.');
export const FILE_TOO_LARGE = msg('Berkas lebih dari 5 MB. Pisahkan menjadi beberapa berkas.');
export const FILE_NOT_TEXT = msg(
	'Berkas tidak bisa dibaca sebagai teks UTF-8. Simpan ulang sebagai CSV UTF-8.'
);
export const FILE_EMPTY = msg('Berkas CSV kosong.');
export const FILE_UNTERMINATED_QUOTE = msg('Berkas CSV rusak: ada tanda kutip yang tidak ditutup.');
export const FILE_TOO_MANY_COLUMNS = msg('Berkas CSV punya lebih dari 50 kolom.');
export const FORMAT_UNKNOWN = msg('Format tidak terdeteksi, pilih manual');
export const FORMAT_MISMATCH = msg('Kolom berkas tidak cocok dengan format yang dipilih.');
export const FORMAT_INVALID = msg('Pilih format dari daftar.');
/** The import's wallets, categories or membership changed while it ran: nothing was written. */
export const IMPORT_GONE = msg('Dompet atau kategori berubah saat impor. Coba lagi.');
export const IMPORT_BUSY = msg(
	'Impor lain sedang berjalan untuk berkas ini. Coba lagi sebentar lagi.'
);
/** The database failed mid-way: nothing was written (one batch), and nothing of the file was logged. */
export const IMPORT_FAILED = msg(
	'Impor gagal karena gangguan server. Tidak ada yang tersimpan. Coba lagi.'
);
export const BATCH_NOT_FOUND = msg('Impor tidak ditemukan.');
export const BATCH_ALREADY_UNDONE = msg('Impor ini sudah diurungkan.');
/* Move an import to another wallet (FN-16j). A missing, archived or other-space wallet: WALLET_NOT_FOUND. */
export const MOVE_SAME_WALLET = msg('Impor ini sudah ada di dompet itu. Pilih dompet lain.');
export const MOVE_CURRENCY_MISMATCH = msg(
	'Mata uang dompet tujuan berbeda dengan dompet impor ini. Pilih dompet dengan mata uang yang sama.'
);
export const MOVE_MIXED_WALLETS = msg(
	'Transaksi di impor ini ada di lebih dari satu dompet — tidak bisa dipindahkan sekaligus.'
);
export const MOVE_NOTHING = msg('Tidak ada transaksi aktif di impor ini untuk dipindahkan.');
export const MOVE_BATCH_UNDONE = msg('Impor ini sudah diurungkan, jadi tidak bisa dipindahkan.');
export const MOVE_SOURCE_ARCHIVED = msg(
	'Dompet impor ini sudah diarsipkan. Pulihkan dompet itu dulu untuk memindahkan impor ini.'
);
export const MOVE_TRANSFER_LINKED = msg(
	'Ada transfer dari impor ini yang sudah dicocokkan. Urungkan pencocokan transfer itu dulu untuk memindahkan impor ini.'
);
export const IMPORTS_LOAD_FAILED = msg('Riwayat impor tidak bisa dimuat. Coba lagi sebentar lagi.');
/* Statement continuity (FN-48 Part B). */
export const CONTINUITY_ALREADY = msg(
	'Saldo mutasi ini sudah tersambung. Tidak ada yang ditambahkan.'
);
export const CONTINUITY_CHANGED = msg(
	'Selisih saldo berubah sejak halaman dimuat. Periksa angka terbaru lalu coba lagi.'
);
export const EXPORT_RANGE_INVALID = msg('Pilih tanggal mulai dan sampai yang benar untuk ekspor.');

/* Statement import (FN-16a). */
export const STATEMENT_FILE_REQUIRED = msg('Pilih berkas mutasi (PDF atau CSV) dulu.');
export const STATEMENT_FILE_EMPTY = msg('Berkas mutasi kosong.');
export const STATEMENT_TOO_LARGE = msg(
	'Berkas lebih dari 15 MB. Unduh mutasi per bulan lalu impor satu per satu.'
);
export const STATEMENT_NOT_READABLE = msg(
	'Berkas tidak dikenali sebagai PDF atau CSV. Untuk CSV, simpan ulang sebagai UTF-8.'
);
export const STATEMENT_SPREADSHEET = msg(
	'Spreadsheet (.xlsx) diimpor lewat bagian Impor spreadsheet. Untuk mutasi bank, unduh sebagai PDF atau CSV.'
);
export const PDF_NEEDS_PASSWORD = msg(
	'PDF ini dikunci sandi. Isi sandi PDF lalu coba lagi. Sandi hanya dipakai untuk membuka berkas ini dan tidak disimpan.'
);
export const PDF_WRONG_PASSWORD = msg('Sandi PDF salah. Periksa lalu coba lagi.');
export const PDF_CORRUPT = msg(
	'PDF rusak atau tidak lengkap. Unduh ulang mutasi dari bank lalu coba lagi.'
);
export const PDF_TOO_COMPLEX = msg(
	'PDF terlalu berat untuk dibaca di sini. Unduh mutasi per bulan lalu coba lagi.'
);
/** FN-16g: a scanned or image-only PDF is read on the device now ("Baca di perangkat"), not by the server. */
export const STATEMENT_NEEDS_AI = msg(
	'PDF ini berupa gambar (hasil pindai). Baca di perangkat lewat bagian "Baca dari foto atau tangkapan layar".'
);
export const STATEMENT_MONTRA_CSV = msg(
	'Ini CSV template Montra atau Money Manager. Impor lewat bagian CSV di atas.'
);
export const STATEMENT_UNSUPPORTED = msg('Format mutasi ini belum didukung.');
export const STATEMENT_INSTITUTION_MISMATCH = msg(
	'Berkas tidak cocok dengan institusi yang dipilih.'
);
/** FN-16e red team L3: two banks' letterheads in one file (one planted in transfer text) — refused whole. */
export const STATEMENT_INSTITUTION_CONFLICT = msg(
	'Berkas ini memuat kop lebih dari satu bank, jadi tidak ada yang diimpor. Unduh ulang mutasinya dari bank lalu coba lagi.'
);
/** FN-16b: a statement whose running balances, totals or rows do not check out is refused whole. */
export const STATEMENT_INCONSISTENT = msg(
	'Isi mutasi ini tidak cocok dengan saldo yang tercetak, jadi tidak ada yang diimpor. Unduh ulang mutasinya dari bank lalu coba lagi.'
);
export const STATEMENT_NO_ROWS = msg('Tidak ada transaksi yang terbaca dari berkas ini.');
export const STATEMENT_FIELDS_INVALID = msg('Pilih institusi dari daftar.');
/* Multi-account statements (FN-16e). */
export const STATEMENT_SECTION_INVALID = msg('Pilih rekening dari daftar.');
export const STATEMENT_SECTION_REQUIRED = msg(
	'Berkas ini berisi beberapa rekening. Pilih satu rekening untuk diimpor ke dompet ini.'
);
export const STATEMENT_SECTION_UNKNOWN = msg(
	'Rekening yang dipilih tidak ada di berkas ini. Pilih lagi dari daftar.'
);
export const STATEMENT_SECTION_UNSUPPORTED = msg(
	'Bagian ini bukan rekening tabungan atau giro dalam rupiah, jadi tidak diimpor sebagai transaksi.'
);
/** The isolate's statement reader is full or this user already has an upload in flight (503, Retry-After). */
export const STATEMENT_BUSY = msg('Sedang membaca mutasi lain. Coba lagi dalam setengah menit.');
export const STATEMENT_RATE_LIMITED = msg(
	'Terlalu banyak unggahan mutasi. Coba lagi dalam beberapa menit.'
);

/* On-device OCR (FN-16g): only the recognised words reach the server, never the image. */
export const OCR_PAYLOAD_INVALID = msg('Hasil baca tidak valid. Baca ulang foto atau berkasnya.');
export const OCR_FIELDS_INVALID = msg('Pilihan impor tidak valid. Baca ulang lalu coba lagi.');
export const OCR_INCONSISTENT = msg(
	'Saldo tidak cocok. Pastikan foto/pindaian jelas dan semua halaman ikut.'
);
export const OCR_NO_ROWS = msg(
	'Tidak ada transaksi yang terbaca. Coba tangkapan layar yang lebih jelas.'
);
export const OCR_UNSUPPORTED = msg(
	'Tampilan ini belum dikenali. Pilih aplikasi atau bank secara manual, atau coba tangkapan layar riwayat transaksi.'
);
export const OCR_INSTITUTION_MISMATCH = msg(
	'Isi gambar tidak cocok dengan aplikasi atau bank yang dipilih.'
);
export const OCR_INSTITUTION_CONFLICT = msg(
	'Gambar ini memuat tanda lebih dari satu bank atau aplikasi, jadi tidak ada yang diimpor.'
);
export const OCR_PICKS_INVALID = msg('Daftar baris sudah berubah. Baca ulang lalu coba lagi.');
