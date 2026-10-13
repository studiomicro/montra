import { msg } from '#lib/shared/i18n';

/** Server answers of the savings-goal actions (translated by the pages with tr()). */
export const GOAL_NAME_INVALID = msg('Isi nama target, paling banyak 60 karakter.');
export const TARGET_INVALID = msg(
	'Isi jumlah target dengan angka bulat lebih dari nol, tanpa sen.'
);
export const AMOUNT_INVALID = msg('Isi jumlah dengan angka bulat lebih dari nol, tanpa sen.');
export const NOTE_INVALID = msg('Catatan paling banyak 200 karakter.');
/** One answer for a goal id that is missing or belongs to another space (no oracle). */
export const GOAL_NOT_FOUND = msg('Target tidak ditemukan.');
/** One answer for a contribution that is missing, already deleted, or belongs to another goal or space. */
export const CONTRIBUTION_NOT_FOUND = msg('Catatan tabungan tidak ditemukan.');
/** A stale form: FN-04's exact phrase (same i18n key), not a re-keyed copy. */
export const GOAL_CHANGED = msg('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.');
export const GOAL_LIMIT = msg('Ruang ini sudah punya 50 target, batas terbanyak.');
/** The goal's saved total would no longer be an exact integer (far beyond any real amount). */
/** The goal holds MAX_CONTRIBUTIONS_PER_GOAL live contributions. */
export const CONTRIBUTION_LIMIT = msg(
	'Target ini sudah punya 10.000 catatan tabungan, batas terbanyak.'
);
export const SAVED_TOO_LARGE = msg('Jumlah tabungan target ini sudah terlalu besar.');
export const GOALS_LOAD_FAILED = msg('Target tabungan tidak bisa dimuat. Coba lagi sebentar lagi.');
