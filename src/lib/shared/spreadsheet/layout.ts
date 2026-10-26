import { cleanText } from '../text.ts';
import { monthFromTitle, numberDate, parseTextDate } from './dates.ts';
import { amountOfCell } from './amounts.ts';
import type {
	ColumnRole,
	SheetCell,
	SheetGrid,
	SheetRow,
	TabKind,
	TabMapping,
	TabSkipReason
} from './types.ts';

/**
 * The heuristic layout reader (FN-17): finds each tab's header row and column roles from Indonesian and
 * English header words, scored over the first rows, never first-match. Everything it decides is a proposal
 * the user can change. Pure: no D1, Workers or DOM dependency.
 */

/** The header row is looked for in a tab's first 30 non-empty rows. */
export const HEADER_SCAN_ROWS = 30;
/** Rows below a header checked for date-like and numeric values. */
const CHECK_ROWS = 10;
/** Sample rows shown per tab (and the most an AI suggestion ever sees). */
export const SAMPLE_ROWS = 5;
/** Longest sample or header cell shown or sent. */
export const SAMPLE_CELL_MAX = 60;

/** Header text → role. Keys are `headerKey` forms (ASCII lower case, punctuation and "(Rp)" dropped). */
const SYNONYMS: Readonly<Record<string, ColumnRole>> = {
	tanggal: 'date',
	tgl: 'date',
	date: 'date',
	'tanggal transaksi': 'date',
	'tgl transaksi': 'date',
	'transaction date': 'date',
	hari: 'date',
	keterangan: 'title',
	uraian: 'title',
	deskripsi: 'title',
	catatan: 'title',
	description: 'title',
	note: 'title',
	notes: 'title',
	merchant: 'title',
	memo: 'title',
	item: 'title',
	'nama transaksi': 'title',
	kategori: 'category',
	category: 'category',
	jumlah: 'amount',
	nominal: 'amount',
	nilai: 'amount',
	amount: 'amount',
	total: 'amount',
	pemasukan: 'income',
	masuk: 'income',
	'uang masuk': 'income',
	kredit: 'income',
	income: 'income',
	in: 'income',
	credit: 'income',
	pengeluaran: 'expense',
	keluar: 'expense',
	'uang keluar': 'expense',
	debit: 'expense',
	debet: 'expense',
	expense: 'expense',
	expenses: 'expense',
	out: 'expense',
	tipe: 'type',
	jenis: 'type',
	type: 'type',
	saldo: 'ignore',
	balance: 'ignore',
	no: 'ignore',
	nomor: 'ignore'
};

/** Words of a budget or an asset/net-worth table (AC 12): such tabs are never read as transactions. */
const BUDGET_WORDS = ['anggaran', 'budget', 'target', 'limit', 'batas', 'alokasi', 'sisa anggaran'];
const ASSET_WORDS = [
	'aset',
	'asset',
	'kekayaan',
	'net worth',
	'portofolio',
	'portfolio',
	'liabilitas'
];

/** Tab titles that say which kind every row of the tab is. */
const INCOME_TITLES = ['pemasukan', 'income', 'pendapatan', 'uang masuk'];
const EXPENSE_TITLES = ['pengeluaran', 'expense', 'expenses', 'belanja', 'uang keluar'];

/** A cell's text as a header key: cleaned, ASCII lower case, "(Rp)"/"Rp"/"IDR" and punctuation dropped. */
export function headerKey(text: string): string {
	return cleanText(text, SAMPLE_CELL_MAX)
		.replace(/[A-Z]/g, (c) => c.toLowerCase())
		.replace(/\((?:rp|idr)\.?\)|\b(?:rp|idr)\b\.?/g, ' ')
		.replace(/[.:*#()[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The role a header cell names, or undefined. */
export function roleOfHeader(text: string): ColumnRole | undefined {
	const key = headerKey(text);
	return Object.hasOwn(SYNONYMS, key) ? SYNONYMS[key] : undefined;
}

/** A cell as display text (numbers as their exact text). */
export function cellText(cell: SheetCell | null | undefined): string {
	if (!cell) return '';
	switch (cell.kind) {
		case 'number':
		case 'text':
			return cell.text;
		case 'bool':
			return cell.value ? 'TRUE' : 'FALSE';
		default:
			return '';
	}
}

/** Kind a tab title names, else null. */
function kindFromTitle(name: string): 'expense' | 'income' | null {
	const key = headerKey(name);
	if (INCOME_TITLES.some((w) => key.includes(w))) return 'income';
	if (EXPENSE_TITLES.some((w) => key.includes(w))) return 'expense';
	return null;
}

/** The roles a header row names (first column wins; later repeats of a single role are ignored). */
function rolesOf(row: SheetRow, columns: number): ColumnRole[] {
	const roles: ColumnRole[] = Array.from({ length: columns }, () => 'ignore');
	const seen = new Set<ColumnRole>();
	for (let c = 0; c < columns; c++) {
		const cell = row.cells[c];
		if (!cell || cell.kind !== 'text') continue;
		const role = roleOfHeader(cell.text);
		if (!role || role === 'ignore' || seen.has(role)) continue;
		seen.add(role);
		roles[c] = role;
	}
	return roles;
}

const hasAmountColumn = (roles: readonly ColumnRole[]) =>
	roles.includes('amount') || roles.includes('income') || roles.includes('expense');

/** Whether a cell reads as a date (a full date, or a day the tab's month completes). */
function dateLike(cell: SheetCell | null | undefined, date1904: boolean): boolean {
	if (!cell) return false;
	if (cell.kind === 'number') return numberDate(cell.text, cell.date, date1904).kind !== 'invalid';
	if (cell.kind === 'text') return parseTextDate(cell.text).kind !== 'invalid';
	return false;
}

/** Whether a cell reads as an amount (a number cell, or numeric text the shared money parser reads). */
function numberLike(cell: SheetCell | null | undefined): boolean {
	const read = amountOfCell(cell);
	return typeof read === 'object';
}

/** Whether the rows below `header` hold dates and amounts where its roles say. */
function confirmedBelow(
	rows: readonly SheetRow[],
	at: number,
	roles: readonly ColumnRole[],
	date1904: boolean
): boolean {
	const dateCol = roles.indexOf('date');
	const amountCols = roles.flatMap((r, i) =>
		r === 'amount' || r === 'income' || r === 'expense' ? [i] : []
	);
	const below = rows.slice(at + 1, at + 1 + CHECK_ROWS);
	return (
		below.some((r) => dateLike(r.cells[dateCol], date1904)) &&
		below.some((r) => amountCols.some((c) => numberLike(r.cells[c])))
	);
}

type TabStatus = 'ready' | 'needs_mapping';

export interface TabProposal {
	mapping: TabMapping;
	/** `ready`: a header with date + amount was found and the rows below agree; else the picker is needed. */
	status: TabStatus;
	/** Every column's role came from the header words (false: guessed from content, or nothing found). */
	fromHeader: boolean;
}

/** The first 30 rows a header may be in, as `[index in rows, row]`. */
function headRows(grid: SheetGrid): SheetRow[] {
	return grid.rows.slice(0, HEADER_SCAN_ROWS);
}

/** Words of a budget or asset table in a tab's first rows → the reason it is skipped. */
function tableWords(grid: SheetGrid): 'budget' | 'assets' | null {
	const text = headRows(grid)
		.flatMap((r) => r.cells.map((c) => (c?.kind === 'text' ? headerKey(c.text) : '')))
		.concat(headerKey(grid.name))
		.join(' | ');
	if (BUDGET_WORDS.some((w) => text.includes(w))) return 'budget';
	if (ASSET_WORDS.some((w) => text.includes(w))) return 'assets';
	return null;
}

/**
 * The kind a tab's rows get with `kind: 'auto'`: from in/out or type columns (per row), the tab title, or the
 * amount sign when both signs occur and there is no type or in/out column; null: the user must choose.
 */
export function autoKind(
	grid: SheetGrid,
	mapping: Pick<TabMapping, 'columns' | 'headerRow'>
): 'columns' | 'expense' | 'income' | 'sign' | null {
	const { columns } = mapping;
	if (columns.includes('income') || columns.includes('expense') || columns.includes('type'))
		return 'columns';
	const fromTitle = kindFromTitle(grid.name);
	if (fromTitle) return fromTitle;
	const amountCol = columns.indexOf('amount');
	if (amountCol < 0) return null;
	let negative = false;
	let positive = false;
	for (const row of grid.rows) {
		if (row.r <= mapping.headerRow) continue;
		const read = amountOfCell(row.cells[amountCol]);
		if (typeof read !== 'object') continue;
		if (read.minor < 0) negative = true;
		else if (read.minor > 0) positive = true;
		if (negative && positive) return 'sign';
	}
	return null;
}

/** Whether the mapped date column holds day-only values (`15`, "15 Okt"), so the tab needs a month. */
export function hasDayOnlyDates(grid: SheetGrid, mapping: TabMapping, date1904: boolean): boolean {
	const dateCol = mapping.columns.indexOf('date');
	if (dateCol < 0) return false;
	for (const row of grid.rows) {
		if (row.r <= mapping.headerRow) continue;
		const cell = row.cells[dateCol];
		if (!cell) continue;
		const read =
			cell.kind === 'number'
				? numberDate(cell.text, cell.date, date1904)
				: cell.kind === 'text'
					? parseTextDate(cell.text)
					: null;
		if (read?.kind === 'day') return true;
	}
	return false;
}

/**
 * A tab's proposal: the best-scored header row in its first 30 rows (distinct roles named, then whether the
 * rows below hold dates and amounts there). Ties, or no header with a date and an amount, leave the picker.
 * A tab without one but with date-like and numeric columns is offered with those guessed; budget and asset
 * tables, and tabs without such columns, are skipped with a reason.
 */
export function proposeTab(
	grid: SheetGrid,
	date1904: boolean
): TabProposal | { skip: TabSkipReason } {
	if (grid.rows.length === 0) return { skip: 'empty' };
	const head = headRows(grid);
	let best: { at: number; roles: ColumnRole[]; score: number } | null = null;
	let tie = false;
	head.forEach((row, at) => {
		const roles = rolesOf(row, grid.columns);
		if (!roles.includes('date') || !hasAmountColumn(roles)) return;
		const named = roles.filter((r) => r !== 'ignore').length;
		const score = named * 2 + (confirmedBelow(grid.rows, at, roles, date1904) ? 1 : 0);
		if (!best || score > best.score) {
			best = { at, roles, score };
			tie = false;
			// The same header repeated further down (layout f) is not a tie; a different reading is.
		} else if (score === best.score && roles.join() !== best.roles.join()) tie = true;
	});
	const month = monthFromTitle(grid.name);
	const kind: TabKind = 'auto';
	if (best) {
		const found = best as { at: number; roles: ColumnRole[]; score: number };
		const confirmed = found.score % 2 === 1;
		const mapping: TabMapping = {
			tab: grid.index,
			use: true,
			headerRow: (head[found.at] as SheetRow).r,
			columns: found.roles,
			kind,
			month
		};
		return { mapping, status: confirmed && !tie ? 'ready' : 'needs_mapping', fromHeader: true };
	}
	const words = tableWords(grid);
	if (words) return { skip: words };
	const guessed = guessByContent(grid, date1904);
	if (!guessed) return { skip: 'no_data' };
	return {
		mapping: { tab: grid.index, use: true, ...guessed, kind, month },
		status: 'needs_mapping',
		fromHeader: false
	};
}

/**
 * Without header words: the first column whose values read as dates and the first other column of numbers,
 * the header being the row above the first such date (0 when it is the first row). Null: no such columns.
 */
function guessByContent(
	grid: SheetGrid,
	date1904: boolean
): { headerRow: number; columns: ColumnRole[] } | null {
	const head = headRows(grid);
	for (let at = 0; at < head.length; at++) {
		const row = head[at] as SheetRow;
		const dateCol = row.cells.findIndex((c) => c?.kind !== 'number' && dateLike(c, date1904));
		const serialCol = row.cells.findIndex((c) => c?.kind === 'number' && c.date);
		const d = dateCol >= 0 ? dateCol : serialCol;
		if (d < 0) continue;
		const amountCol = row.cells.findIndex((c, i) => i !== d && c?.kind === 'number' && !c.date);
		if (amountCol < 0) continue;
		const columns: ColumnRole[] = Array.from({ length: grid.columns }, () => 'ignore');
		columns[d] = 'date';
		columns[amountCol] = 'amount';
		const title = row.cells.findIndex(
			(c, i) => i !== d && c?.kind === 'text' && !dateLike(c, date1904)
		);
		if (title >= 0) columns[title] = 'title';
		return { headerRow: at > 0 ? (head[at - 1] as SheetRow).r : 0, columns };
	}
	return null;
}

/** Up to `SAMPLE_ROWS` rows below the header, each cell as capped display text. */
export function sampleRows(grid: SheetGrid, headerRow: number): string[][] {
	return grid.rows
		.filter((r) => r.r > headerRow)
		.slice(0, SAMPLE_ROWS)
		.map((r) =>
			Array.from({ length: grid.columns }, (_, c) =>
				cleanText(cellText(r.cells[c]), SAMPLE_CELL_MAX)
			)
		);
}

/** The header row's cells as capped display text ('' cells when there is no header). */
export function headerTexts(grid: SheetGrid, headerRow: number): string[] {
	const row = grid.rows.find((r) => r.r === headerRow);
	return Array.from({ length: grid.columns }, (_, c) =>
		cleanText(cellText(row?.cells[c]), SAMPLE_CELL_MAX)
	);
}

/** Column letters as Excel shows them (0 → A, 26 → AA). */
export function columnLetter(index: number): string {
	let n = index + 1;
	let out = '';
	while (n > 0) {
		const rem = (n - 1) % 26;
		out = String.fromCharCode(65 + rem) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}
