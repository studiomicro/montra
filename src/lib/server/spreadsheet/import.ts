import { CSV_MAX_ROWS } from '#lib/shared/csv';
import {
	columnLetter,
	HEADER_SCAN_ROWS,
	headerTexts,
	proposeTab,
	sampleRows,
	type TabProposal
} from '#lib/shared/spreadsheet/layout';
import { monthFromTitle } from '#lib/shared/spreadsheet/dates';
import { columnsIssue, mapSheets, type MappedSheet } from '#lib/shared/spreadsheet/rows';
import {
	TAB_KEY_STRIDE,
	type ColumnRole,
	type SheetMapping,
	type SheetSkipCounts,
	type TabIssue,
	type TabKind,
	type TabMapping,
	type TabSkipReason,
	type Workbook
} from '#lib/shared/spreadsheet/types';
import { CATEGORY_NAME_MAX_LENGTH } from '#lib/shared/transactions';
import { cleanText } from '#lib/shared/text';
import { listCategories } from '../categories/repo';
import type { Db } from '../db';
import {
	fallbackWalletOf,
	importRows,
	matchVisibleCategory,
	previewRows,
	visibleCategoryIndex,
	type CsvCounts,
	type ImportRowsFailure,
	type PreparedRows
} from '../imports/csv-import';
import type { SpaceScope } from '../spaces/access';
import { bytesToHex } from '../util';
import { readXlsx, type XlsxRefusal } from './xlsx-read';

/**
 * The spreadsheet import (FN-17) on the server: the uploaded bytes are read in memory (xlsx-read.ts), each
 * tab's layout proposed by the shared heuristics, the user's confirmed mapping applied by the shared row
 * mapper, and the rows handed to FN-18's preview and import path (`source: 'spreadsheet'`, keys
 * `spreadsheet:<file hash>:<tab * 2^20 + row number>`). Nothing of the file, its cells or the mapping is
 * stored or logged; every request re-reads the bytes and never trusts a client row.
 */

export type SheetRefusal = XlsxRefusal | 'not_transactions' | 'fields_invalid' | 'nothing_mapped';

/** Most distinct sheet categories the review lists (the counts cover all rows). */
export const REVIEW_CATEGORIES_MAX = 50;
/** Header rows offered in the picker: the tab's first rows. */
const HEADER_CHOICES = 10;

export type TabStatus = 'ready' | 'needs_mapping' | TabIssue | 'skipped';

/** One tab as the section shows it (no cell beyond the header and SAMPLE_ROWS capped samples). */
export interface TabView {
	tab: number;
	name: string;
	status: TabStatus;
	reason: TabSkipReason | null;
	use: boolean;
	headerRow: number;
	headerChoices: number[];
	columns: { index: number; letter: string; header: string; samples: string[]; role: ColumnRole }[];
	kind: TabKind;
	month: string | null;
	/** The month the tab title names, if any (day-only dates use it unless the user picks another). */
	titleMonth: string | null;
	/** Rows counted with the mapping (null before the review). */
	rows: number | null;
}

export interface SheetReview {
	counts: CsvCounts;
	/** Sums of every readable row of the file as mapped (integer minor units), to check against the sheet. */
	fileTotals: { incomeMinor: number; expenseMinor: number; rows: number };
	skips: SheetSkipCounts;
	categories: { name: string; kind: 'expense' | 'income'; target: string | null; rows: number }[];
	duplicates: {
		tabName: string;
		row: number;
		date: string;
		type: 'expense' | 'income';
		title: string;
		amountMinor: number;
	}[];
}

export interface SheetLayout {
	tabs: TabView[];
	fillDown: boolean;
	/** Tabs the AI suggestion may help with (no confident date + amount mapping). */
	unmapped: number[];
}

interface Analysis {
	workbook: Workbook;
	proposals: Map<number, TabProposal>;
	skipped: { index: number; name: string; reason: TabSkipReason }[];
	hash: string;
}

async function analyse(
	bytes: Uint8Array
): Promise<{ ok: true; value: Analysis } | { ok: false; error: SheetRefusal }> {
	// 128 bits of the SHA-256 of the exact bytes, before reading: the same file always gives the same keys.
	const hash = bytesToHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource)).slice(
		0,
		32
	);
	const read = readXlsx(bytes);
	if (!read.ok) return read;
	const { workbook } = read;
	const proposals = new Map<number, TabProposal>();
	const skipped = [...workbook.skipped];
	for (const grid of workbook.sheets) {
		const proposal = proposeTab(grid, workbook.date1904);
		if ('skip' in proposal)
			skipped.push({ index: grid.index, name: grid.name, reason: proposal.skip });
		else proposals.set(grid.index, proposal);
	}
	// AC 12: only budget or asset tables, or nothing with dates and amounts — not a transaction record.
	if (proposals.size === 0) return { ok: false, error: 'not_transactions' };
	return { ok: true, value: { workbook, proposals, skipped, hash } };
}

/**
 * The posted mapping checked against this very file: only offered tabs, a header among the first rows (or
 * none), no more columns than the tab has (missing ones read as Abaikan). Null when it does not fit.
 */
function fitMapping(analysis: Analysis, mapping: SheetMapping): SheetMapping | null {
	const tabs: TabMapping[] = [];
	for (const m of mapping.tabs) {
		const grid = analysis.workbook.sheets.find((s) => s.index === m.tab);
		if (!grid || !analysis.proposals.has(m.tab)) return null;
		if (m.columns.length > grid.columns) return null;
		const headers = grid.rows.slice(0, HEADER_SCAN_ROWS).map((r) => r.r);
		if (m.headerRow !== 0 && !headers.includes(m.headerRow)) return null;
		const columns = Array.from({ length: grid.columns }, (_, i) => m.columns[i] ?? 'ignore');
		tabs.push({ ...m, columns });
	}
	return { tabs, fillDown: mapping.fillDown };
}

/** The heuristic proposal of every offered tab (the mapping a fresh read shows). */
function proposedMapping(analysis: Analysis): SheetMapping {
	return {
		tabs: [...analysis.proposals.values()].map((p) => ({
			...p.mapping,
			use: p.status === 'ready'
		})),
		fillDown: false
	};
}

function layoutOf(
	analysis: Analysis,
	mapping: SheetMapping,
	mapped: MappedSheet | null
): SheetLayout {
	const { workbook, proposals } = analysis;
	const tabs: TabView[] = [];
	for (const grid of workbook.sheets) {
		const proposal = proposals.get(grid.index);
		if (!proposal) continue;
		const m = mapping.tabs.find((t) => t.tab === grid.index) ?? { ...proposal.mapping, use: false };
		const result = mapped?.tabs.find((t) => t.tab === grid.index);
		const header = headerTexts(grid, m.headerRow);
		const samples = sampleRows(grid, m.headerRow);
		// A fresh read shows the heuristic's verdict; a review its issues; a suggestion whether its columns fit.
		const fresh = !mapped && m.columns === proposal.mapping.columns;
		const status: TabStatus = result
			? (result.issue ?? 'ready')
			: fresh
				? proposal.status
				: (columnsIssue(m.columns) ?? 'ready');
		tabs.push({
			tab: grid.index,
			name: cleanText(grid.name, 100),
			status,
			reason: null,
			use: m.use,
			headerRow: m.headerRow,
			headerChoices: [0, ...grid.rows.slice(0, HEADER_CHOICES).map((r) => r.r)],
			columns: Array.from({ length: grid.columns }, (_, i) => ({
				index: i,
				letter: columnLetter(i),
				header: header[i] ?? '',
				samples: samples.map((row) => row[i] ?? ''),
				role: m.columns[i] ?? 'ignore'
			})),
			kind: m.kind,
			month: m.month,
			titleMonth: monthFromTitle(grid.name),
			rows: result ? result.rows : null
		});
	}
	for (const s of analysis.skipped)
		tabs.push({
			tab: s.index,
			name: cleanText(s.name, 100),
			status: 'skipped',
			reason: s.reason,
			use: false,
			headerRow: 0,
			headerChoices: [],
			columns: [],
			kind: 'auto',
			month: null,
			titleMonth: null,
			rows: null
		});
	tabs.sort((a, b) => a.tab - b.tab);
	return {
		tabs,
		fillDown: mapping.fillDown,
		unmapped: [...proposals.values()]
			.filter((p) => p.status === 'needs_mapping')
			.map((p) => p.mapping.tab)
	};
}

function prepared(analysis: Analysis, mapped: MappedSheet): PreparedRows {
	return {
		source: 'spreadsheet',
		format: null,
		rows: mapped.rows,
		notProcessed: mapped.notProcessed,
		keyPrefix: `spreadsheet:${analysis.hash}:`
	};
}

export type ReadSheetResult =
	| { ok: true; layout: SheetLayout; review: SheetReview | null }
	| { ok: false; error: SheetRefusal };

/**
 * "Baca berkas" (no mapping: the heuristic proposal, no review) or "Pakai pemetaan ini" (the posted mapping
 * applied: the review with counts, skip reasons, category matches and possible duplicates). Writes nothing.
 */
export async function previewSheet(
	db: Db,
	spaceId: string,
	input: { bytes: Uint8Array; mapping: SheetMapping | null }
): Promise<ReadSheetResult> {
	const read = await analyse(input.bytes);
	if (!read.ok) return read;
	const analysis = read.value;
	if (!input.mapping)
		return { ok: true, layout: layoutOf(analysis, proposedMapping(analysis), null), review: null };
	const mapping = fitMapping(analysis, input.mapping);
	if (!mapping) return { ok: false, error: 'fields_invalid' };
	const mapped = mapSheets(analysis.workbook, mapping, CSV_MAX_ROWS);
	const layout = layoutOf(analysis, mapping, mapped);
	const [{ counts, duplicates }, categories] = await Promise.all([
		previewRows(db, spaceId, prepared(analysis, mapped)),
		listCategories(db, spaceId, { includeHidden: true })
	]);
	const index = visibleCategoryIndex(categories);
	const names = new Map(categories.map((c) => [c.id, c.name]));
	const distinct = new Map<string, SheetReview['categories'][number]>();
	const fileTotals = { incomeMinor: 0, expenseMinor: 0, rows: 0 };
	for (const r of mapped.rows) {
		if (!r.ok) continue;
		fileTotals.rows++;
		if (r.value.type === 'income') fileTotals.incomeMinor += r.value.amountMinor;
		else fileTotals.expenseMinor += r.value.amountMinor;
		const name = cleanText(r.value.categoryName, CATEGORY_NAME_MAX_LENGTH);
		const key = `${r.value.type}:${name.toLowerCase()}`;
		const seen = distinct.get(key);
		if (seen) seen.rows++;
		else if (distinct.size < REVIEW_CATEGORIES_MAX) {
			const target = name ? matchVisibleCategory({ ...r.value, title: '' }, index) : null;
			distinct.set(key, {
				name,
				kind: r.value.type,
				target: target ? (names.get(target) ?? null) : null,
				rows: 1
			});
		}
	}
	const tabName = (tab: number) => layout.tabs.find((t) => t.tab === tab)?.name ?? '';
	return {
		ok: true,
		layout,
		review: {
			counts,
			fileTotals,
			skips: mapped.skips,
			categories: [...distinct.values()],
			duplicates: duplicates.map((d) => ({
				tabName: tabName(Math.floor((d.line - 1) / TAB_KEY_STRIDE)),
				row: (d.line - 1) % TAB_KEY_STRIDE,
				date: d.date,
				type: d.type,
				title: d.title,
				amountMinor: d.amountMinor
			}))
		}
	};
}

/** The tab an AI suggestion is asked for: its name, header row and at most SAMPLE_ROWS rows (capped). */
export async function suggestionInput(
	bytes: Uint8Array,
	tab: number,
	mapping: SheetMapping | null
): Promise<
	| {
			ok: true;
			layout: SheetLayout;
			analysis: Analysis;
			tabName: string;
			header: string[];
			samples: string[][];
			rowNumbers: number[];
			columns: number;
	  }
	| { ok: false; error: SheetRefusal }
> {
	const read = await analyse(bytes);
	if (!read.ok) return read;
	const analysis = read.value;
	const fitted = mapping ? fitMapping(analysis, mapping) : proposedMapping(analysis);
	if (!fitted) return { ok: false, error: 'fields_invalid' };
	const proposal = analysis.proposals.get(tab);
	const grid = analysis.workbook.sheets.find((s) => s.index === tab);
	if (!proposal || !grid) return { ok: false, error: 'fields_invalid' };
	const headerRow = fitted.tabs.find((t) => t.tab === tab)?.headerRow ?? proposal.mapping.headerRow;
	const samples = sampleRows(grid, headerRow);
	const below = grid.rows
		.filter((r) => r.r > headerRow)
		.slice(0, samples.length)
		.map((r) => r.r);
	return {
		ok: true,
		layout: layoutOf(analysis, fitted, null),
		analysis,
		tabName: cleanText(grid.name, 100),
		header: headerTexts(grid, headerRow),
		samples,
		rowNumbers: [headerRow, ...below],
		columns: grid.columns
	};
}

/** The layout with one tab's mapping replaced by a suggestion (pre-fill only: no review is computed). */
export function withSuggestion(
	analysis: Analysis,
	layout: SheetLayout,
	tab: number,
	suggestion: { headerRow: number; columns: ColumnRole[]; kind: TabKind }
): SheetLayout {
	const mapping: SheetMapping = {
		fillDown: layout.fillDown,
		tabs: layout.tabs
			.filter((t) => t.status !== 'skipped')
			.map((t) =>
				t.tab === tab
					? {
							tab,
							use: true,
							headerRow: suggestion.headerRow,
							columns: suggestion.columns,
							kind: suggestion.kind,
							month: t.month
						}
					: {
							tab: t.tab,
							use: t.use,
							headerRow: t.headerRow,
							columns: t.columns.map((c) => c.role),
							kind: t.kind,
							month: t.month
						}
			)
	};
	return layoutOf(analysis, mapping, null);
}

export interface ImportSheetInput {
	bytes: Uint8Array;
	filename: string | null;
	mapping: SheetMapping;
	walletId: string;
	skipPossibleDuplicates: boolean;
}

export type ImportSheetResult =
	| { ok: true; batchId: string | null; counts: CsvCounts; skips: SheetSkipCounts }
	| { ok: false; error: SheetRefusal | ImportRowsFailure };

/**
 * "Impor": the wallet checked first (another space's or an archived wallet answers `wallet_not_found`), the
 * bytes re-read with the confirmed mapping, then FN-18's `importRows` with nothing created: one wallet for
 * every row, visible categories or none.
 */
export async function importSheet(
	db: Db,
	scope: SpaceScope,
	input: ImportSheetInput,
	now: number
): Promise<ImportSheetResult> {
	const fallback = await fallbackWalletOf(db, scope.spaceId, input.walletId);
	if (!fallback.ok) return fallback;
	const read = await analyse(input.bytes);
	if (!read.ok) return read;
	const mapping = fitMapping(read.value, input.mapping);
	if (!mapping) return { ok: false, error: 'fields_invalid' };
	const mapped = mapSheets(read.value.workbook, mapping, CSV_MAX_ROWS);
	if (mapped.rows.length === 0 && mapped.notProcessed === 0)
		return { ok: false, error: 'nothing_mapped' };
	const result = await importRows(
		db,
		scope,
		prepared(read.value, mapped),
		{
			filename: input.filename,
			fallbackWallet: fallback.wallet,
			skipPossibleDuplicates: input.skipPossibleDuplicates,
			createMissing: false
		},
		now
	);
	return result.ok ? { ...result, skips: mapped.skips } : result;
}
