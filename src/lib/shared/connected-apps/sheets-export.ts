import { exportCells, guardFormula, TEMPLATE_COLUMNS, type ExportRow } from '../csv.ts';

/**
 * Google Sheets rows for FN-29 (no network call here): the `values` of a `spreadsheets.values.append` body, a
 * header row in FN-18's template column order followed by one row per transaction. Each cell is exactly the
 * cell FN-18's CSV export writes before CSV quoting (`exportCells`: account and card numbers masked) and passes
 * the same formula guard (`guardFormula`: a leading `'`), so a spreadsheet cell is never evaluated as a formula.
 * Meant for `valueInputOption=USER_ENTERED`, where the leading `'` marks the cell as text and is not shown.
 */
export function buildSheetsRows(rows: readonly ExportRow[]): string[][] {
	return [
		TEMPLATE_COLUMNS.map(guardFormula),
		...rows.map((row) => exportCells(row).map(guardFormula))
	];
}
