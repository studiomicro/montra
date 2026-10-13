import { csvLine, exportCells, TEMPLATE_COLUMNS, type ExportRow } from '#lib/shared/csv';
import type { Db } from '../db';
import type { SpaceScope } from '../spaces/access';
import { listTransactionsForExport } from '../transactions/aggregate';

/**
 * One transaction as a template line (TEMPLATE_COLUMNS order); every cell guarded against formulas, account and
 * card numbers in the payment method, recurrence, tag, wallet and reference cells cut to the last 4 digits.
 */
export function exportLine(row: ExportRow): string {
	return csvLine(exportCells(row));
}

/** A WIB date range of one export query: at most a year (MAX_FILTER_DAYS), as FN-18's filter requires. */
export interface ExportRange {
	from: string;
	to: string;
}

/**
 * The space's income and expense rows from `fromDate` to `toDate` (WIB dates, at most a year apart: the caller
 * clamps) as a template CSV, streamed page by page (EXPORT_PAGE_SIZE rows per query), so a large space never
 * builds the whole file in memory or runs one unbounded query. Starts with a UTF-8 BOM so spreadsheets read
 * the rupiah text correctly; the shared reader drops it on re-import.
 */
export function exportTransactionsCsv(
	db: Db,
	scope: SpaceScope,
	fromDate: string,
	toDate: string
): ReadableStream<Uint8Array> {
	return exportTransactionsCsvRanges(db, scope, [{ from: fromDate, to: toDate }]);
}

/**
 * The same CSV over several ranges, one after another under one header (FN-31's account export walks a
 * space's whole history year by year, newest first, so the rows come in the same order as one FN-18 export).
 * For one range the bytes are exactly `exportTransactionsCsv`'s; for several, its header followed by each
 * range's rows. Every page re-checks the live membership (`listTransactionsForExport`).
 */
export function exportTransactionsCsvRanges(
	db: Db,
	scope: SpaceScope,
	ranges: readonly ExportRange[]
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let started = false;
	let rangeIndex = 0;
	let cursor: string | null = null;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (!started) {
					started = true;
					controller.enqueue(encoder.encode('\uFEFF' + csvLine(TEMPLATE_COLUMNS)));
					if (ranges.length === 0) controller.close();
					return;
				}
				// Until one page has rows or the last range ends: a pull that enqueues nothing would stall the reader.
				for (;;) {
					const range = ranges[rangeIndex] as ExportRange;
					const page = await listTransactionsForExport(
						db,
						scope,
						{
							from: range.from,
							to: range.to,
							type: null,
							categoryId: null,
							walletId: null,
							q: null
						},
						cursor
					);
					cursor = page.nextCursor;
					const done = !cursor && ++rangeIndex === ranges.length;
					if (page.rows.length > 0)
						controller.enqueue(encoder.encode(page.rows.map(exportLine).join('')));
					if (done) return controller.close();
					if (page.rows.length > 0) return;
				}
			}
		},
		{ highWaterMark: 0 }
	);
}
