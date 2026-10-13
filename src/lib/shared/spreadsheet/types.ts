/**
 * Spreadsheet import (FN-17): the shapes the server's XLSX reader hands to the pure layout and row mappers.
 * Pure: no D1, Workers or DOM dependency. Every value is still untrusted file content.
 */

/** One cell as the workbook cached it. A formula's text is never read: only its cached `<v>` value. */
export type SheetCell =
	/** `text` is the exact `<v>` text (never a JavaScript float), so money keeps every digit. */
	| { kind: 'number'; text: string; date: boolean; foreign: boolean }
	| { kind: 'text'; text: string }
	| { kind: 'bool'; value: boolean }
	| { kind: 'error' };

/** A non-empty row: `r` is the sheet's own 1-based row number; `cells[i]` is column i (A = 0). */
export interface SheetRow {
	r: number;
	cells: (SheetCell | null)[];
}

/** One visible worksheet, at most SHEET_MAX_COLUMNS wide. */
export interface SheetGrid {
	/** Position of the sheet in the workbook (hidden ones included): part of every row's dedupe key. */
	index: number;
	name: string;
	rows: SheetRow[];
	/** Columns in use (highest non-empty column + 1). */
	columns: number;
	/** Non-empty rows past the reader's row cap: counted as "not processed", never read. */
	droppedRows: number;
}

/** Why a sheet of the workbook is not offered for import. */
export type TabSkipReason =
	'hidden' | 'not_worksheet' | 'tab_cap' | 'empty' | 'budget' | 'assets' | 'no_data';

export interface Workbook {
	/** `<workbookPr date1904="1">`: serials count from 1904-01-01. */
	date1904: boolean;
	sheets: SheetGrid[];
	/** Sheets not read at all (hidden, chart sheets, past the tab cap). */
	skipped: { index: number; name: string; reason: TabSkipReason }[];
}

/** What a column holds (the picker's options: Tanggal, Keterangan, Kategori, Jumlah, Masuk, Keluar, Tipe, Abaikan). */
export const COLUMN_ROLES = [
	'date',
	'title',
	'category',
	'amount',
	'income',
	'expense',
	'type',
	'ignore'
] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

/** Roles at most one column of a tab may have (`ignore` may repeat). */
export const SINGLE_ROLES: readonly ColumnRole[] = [
	'date',
	'title',
	'category',
	'amount',
	'income',
	'expense',
	'type'
];

/** A tab's kind: `auto` reads it from in/out or type columns, the tab title, or the amount sign. */
export const TAB_KINDS = ['auto', 'expense', 'income'] as const;
export type TabKind = (typeof TAB_KINDS)[number];

/** How one tab is read: the user's confirmed choice (or the heuristic's proposal). */
export interface TabMapping {
	tab: number;
	use: boolean;
	/** Row number of the header row; 0 = no header (data from the first row). */
	headerRow: number;
	/** One role per column, `columns.length` = the sheet's columns. */
	columns: ColumnRole[];
	kind: TabKind;
	/** `YYYY-MM` for day-only dates; null: from the tab title, else the tab needs one. */
	month: string | null;
}

export interface SheetMapping {
	tabs: TabMapping[];
	/** "Isi tanggal kosong dari baris atas" (owner decision 7: off by default). */
	fillDown: boolean;
}

/** Why a row with content was not imported (each counted apart in the review). */
export const SHEET_SKIP_REASONS = [
	'amount_not_number',
	'amount_missing',
	'date_missing',
	'date_invalid',
	'total_row',
	'type_unknown',
	'foreign_currency'
] as const;
export type SheetSkipReason = (typeof SHEET_SKIP_REASONS)[number];
export type SheetSkipCounts = Record<SheetSkipReason, number>;

/** Why a whole tab produced no rows with the mapping as it stands. */
export type TabIssue = 'needs_mapping' | 'needs_kind' | 'needs_month';

/** Excel's last row; the reader refuses a file with a row beyond it. */
export const SHEET_MAX_ROW = 1_048_576;
/** Rows per tab in a dedupe key: a tab's rows are `tab * TAB_KEY_STRIDE + row number`, so no two tabs collide. */
export const TAB_KEY_STRIDE = SHEET_MAX_ROW + 1;
