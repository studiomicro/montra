import { msg } from '#lib/shared/i18n';

/** Server answers of the /pengaturan/aplikasi actions (translated by the page with tr()). */
export const CONNECTED_APPS_LOAD_FAILED = msg(
	'Aplikasi terhubung tidak bisa dimuat. Periksa koneksi lalu coba lagi.'
);
/** One answer for a connection id that is missing, already disconnected or in another space (no oracle). */
export const CONNECTION_NOT_FOUND = msg('Sambungan ini sudah tidak ada.');
/** The server has no well-formed CONNECTED_APPS_ENCRYPTION_KEY: nothing can be stored. */
export const CONNECTED_APPS_NOT_CONFIGURED = msg('Belum dikonfigurasi');
/** A member who neither made the connection nor owns the space (red team L3). */
export const DISCONNECT_NOT_ALLOWED = msg(
	'Hanya yang menghubungkan atau Pemilik ruang yang bisa memutus sambungan ini.'
);
export const PROVIDER_INVALID = msg('Pilih aplikasi dari daftar.');
/** Dev seed: the space already has a live connection of that app. */
export const ALREADY_CONNECTED = msg('Aplikasi ini sudah punya sambungan di ruang ini.');
