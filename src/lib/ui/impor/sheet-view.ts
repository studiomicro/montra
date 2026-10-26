import type { SheetLayout, SheetReview, TabStatus, TabView } from '#lib/server/spreadsheet/import';
import type { CsvCounts } from '#lib/server/imports/csv-import';
import type { Translator } from '#lib/shared/i18n';
import type { ColumnRole, SheetSkipCounts, TabSkipReason } from '#lib/shared/spreadsheet/types';

/**
 * What the spreadsheet section (FN-17) reads from the page's `form`: only answers tagged
 * `section: 'spreadsheet'`, so the CSV and statement sections never show them and it never shows theirs.
 */

type SheetRead = {
	step: 'read' | 'reviewed';
	filename: string;
	walletId: string | null;
	skipPossibleDuplicates: boolean;
	layout: SheetLayout;
	review: SheetReview | null;
	ai: { configured: boolean; hasKey: boolean };
	aiError: string | null;
	aiTab: number | null;
};
type SheetImported = {
	step: 'imported';
	filename: string;
	counts: CsvCounts;
	skips: SheetSkipCounts;
	batchId: string | null;
};
export type SheetAnswer = SheetRead | SheetImported;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The section's answer in `form`, or null (another section's answer, or none). */
export function sheetAnswer(form: unknown): SheetAnswer | null {
	if (!isRecord(form) || form.section !== 'spreadsheet' || !isRecord(form.sheet)) return null;
	return form.sheet as SheetAnswer;
}

/** The section's refusal message in `form` (untranslated), or ''. */
export function sheetError(form: unknown): string {
	if (!isRecord(form) || form.section !== 'spreadsheet') return '';
	return typeof form.sheetError === 'string' ? form.sheetError : '';
}

type T = Pick<Translator, 'tr' | 'trf'>;

/** The picker's options, in the PRD's order (Tanggal, Keterangan, Kategori, Jumlah, Masuk, Keluar, Tipe, Abaikan). */
export function roleOptions({ tr }: T): { value: ColumnRole; label: string }[] {
	return [
		{ value: 'date', label: tr('Tanggal') },
		{ value: 'title', label: tr('Keterangan') },
		{ value: 'category', label: tr('Nama kategori') },
		{ value: 'amount', label: tr('Jumlah') },
		{ value: 'income', label: tr('Uang masuk') },
		{ value: 'expense', label: tr('Uang keluar') },
		{ value: 'type', label: tr('Tipe (masuk/keluar)') },
		{ value: 'ignore', label: tr('Abaikan kolom') }
	];
}

export function statusLabel(status: TabStatus, { tr }: T): string {
	switch (status) {
		case 'ready':
			return tr('Siap');
		case 'needs_mapping':
			return tr('Pilih kolom Tanggal dan Jumlah');
		case 'needs_kind':
			return tr('Pilih jenis: pengeluaran atau pemasukan');
		case 'needs_month':
			return tr('Pilih bulan dan tahun untuk tanggal tanpa bulan');
		default:
			return tr('Dilewati');
	}
}

export function skipReasonLabel(reason: TabSkipReason | null, { tr }: T): string {
	switch (reason) {
		case 'hidden':
			return tr('Tab tersembunyi');
		case 'not_worksheet':
			return tr('Bukan lembar data (grafik atau lainnya)');
		case 'tab_cap':
			return tr('Lewat batas 40 tab');
		case 'empty':
			return tr('Tab kosong');
		case 'budget':
			return tr('Tampak seperti anggaran, bukan transaksi');
		case 'assets':
			return tr('Tampak seperti daftar aset, bukan transaksi');
		default:
			return tr('Tidak ada kolom tanggal dan jumlah');
	}
}

/** Review and result lines, the same wording as the CSV section. */
export function countLines(imported: boolean, c: CsvCounts, { trf }: T): string[] {
	const lines = [
		imported
			? trf('Diimpor {imported} · Dilewati {skipped} · Sudah pernah diimpor {already}', {
					imported: c.imported,
					skipped: c.skipped,
					already: c.already
				})
			: trf('Siap diimpor {ready} · Dilewati {skipped} · Sudah pernah diimpor {already}', {
					ready: c.imported,
					skipped: c.skipped,
					already: c.already
				})
	];
	if (c.foreignCurrency > 0)
		lines.push(trf('Mata uang selain IDR dilewati: {n}', { n: c.foreignCurrency }));
	if (c.possibleDuplicates > 0)
		lines.push(trf('Mungkin duplikat: {n}', { n: c.possibleDuplicates }));
	if (c.notProcessed > 0)
		lines.push(
			trf(
				'{n} baris belum diproses (batas 5.000 baris per impor). Pisahkan berkas lalu impor sisanya.',
				{ n: c.notProcessed }
			)
		);
	return lines;
}

/** Why rows were skipped, one line per reason that occurred. */
export function skipLines(s: SheetSkipCounts, { trf }: T): string[] {
	const lines: string[] = [];
	if (s.amount_not_number > 0)
		lines.push(trf('Jumlah bukan angka: {n}', { n: s.amount_not_number }));
	if (s.amount_missing > 0) lines.push(trf('Jumlah kosong: {n}', { n: s.amount_missing }));
	if (s.date_missing > 0) lines.push(trf('Tanpa tanggal: {n}', { n: s.date_missing }));
	if (s.date_invalid > 0) lines.push(trf('Tanggal tidak terbaca: {n}', { n: s.date_invalid }));
	if (s.total_row > 0) lines.push(trf('Baris total atau saldo: {n}', { n: s.total_row }));
	if (s.type_unknown > 0) lines.push(trf('Jenis tidak dikenali: {n}', { n: s.type_unknown }));
	return lines;
}

/** Tabs the user can map (not skipped), in workbook order. */
export const mappableTabs = (layout: SheetLayout): TabView[] =>
	layout.tabs.filter((t) => t.status !== 'skipped');
