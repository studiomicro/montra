import { msg } from '../../shared/i18n.ts';

/** Answers of /agen and its download route (FN-23), translated by the page with tr(). */
export const AGENT_PLAN_REQUIRED = msg('Tersedia di paket Agen');
/** A download or action after the Agent plan lapsed. */
export const AGENT_PLAN_ENDED = msg('Paket Agen berakhir');
export const AGENT_INVALID = msg('Pilih jenis laporan dan periode yang tersedia.');
export const AGENT_EMPTY = msg('Belum ada catatan di periode ini.');
export const AGENT_USER_BUSY = msg(
	'Masih ada laporan yang sedang dibuat. Tunggu sampai selesai, lalu coba lagi.'
);
export const AGENT_SPACE_BUSY = msg(
	'Ruang ini sedang membuat beberapa laporan. Coba lagi sebentar lagi.'
);
export const AGENT_USER_DAILY = msg('Batas 5 laporan per 24 jam tercapai. Coba lagi besok.');
export const AGENT_SPACE_DAILY = msg(
	'Batas 15 laporan per 24 jam untuk ruang ini tercapai. Coba lagi besok.'
);
export const AGENT_TOO_MANY = msg('Sudah ada 20 laporan. Hapus laporan lama dulu.');
export const AGENT_SAVE_FAILED = msg('Laporan tidak bisa dibuat. Coba lagi sebentar lagi.');
export const AGENT_LOAD_FAILED = msg('Laporan tidak bisa dimuat. Coba lagi sebentar lagi.');
export const AGENT_DELETE_FAILED = msg('Laporan tidak bisa dihapus. Coba lagi sebentar lagi.');
