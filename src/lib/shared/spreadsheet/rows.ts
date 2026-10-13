import type { MappedRow, SkipReason } from '../csv.ts';
import { cleanText, maskAccountNumbers } from '../text.ts';
import { CATEGORY_NAME_MAX_LENGTH, TITLE_MAX_LENGTH } from '../transactions.ts';
import { amountOfCell } from './amounts.ts';
import { monthFromTitle, numberDate, parseTextDate, placeDay } from './dates.ts';
import { autoKind, cellText, hasDayOnlyDates, headerKey } from './layout.ts';
import {
	SHEET_SKIP_REASONS,
	SINGLE_ROLES,
	TAB_KEY_STRIDE,
	type ColumnRole,
	type SheetCell,
	type SheetGrid,
	type SheetMapping,
	type SheetSkipCounts,
	type SheetSkipReason,
	type TabIssue,
	type TabMapping,
	type Workbook
} from './types.ts';

/**
 * Spreadsheet cells → the rows FN-18's import path writes (FN-17). Every number and date is copied by this
 * code from the cell, never by a model: a number cell's exact `<v>` text becomes integer minor units (no
 * float), a text amount goes through the one shared money parser (FN-14a) but never as shorthand ("25rb").
 * Pure: no D1, Workers or DOM dependency.
 */

/** Rows whose text says they are a total, subtotal or balance line (layout g). */
const TOTAL_ROW =
	/^(?:(?:sub ?total|grand total|total|saldo)(?: .*)?|jumlah(?: (?:total|semua|keseluruhan))?|balance)$/;

const INCOME_TYPES = new Set(['masuk', 'pemasukan', 'income', 'cr', 'k', 'kredit', 'credit', 'in']);
const EXPENSE_TYPES = new Set([
	'keluar',
	'pengeluaran',
	'expense',
	'db',
	'd',
	'debit',
	'debet',
	'out'
]);

/** A type cell → kind, or null when it names neither. */
export function kindOfType(text: string): 'expense' | 'income' | null {
	const key = headerKey(text);
	if (INCOME_TYPES.has(key)) return 'income';
	if (EXPENSE_TYPES.has(key)) return 'expense';
	return null;
}

/**
 * Why a mapping cannot read its tab: no date column, no amount column, both an amount and in/out columns, or a
 * role (other than Abaikan) on two columns.
 */
export function columnsIssue(columns: readonly ColumnRole[]): TabIssue | null {
	const has = (role: ColumnRole) => columns.includes(role);
	if (SINGLE_ROLES.some((role) => columns.indexOf(role) !== columns.lastIndexOf(role)))
		return 'needs_mapping';
	if (!has('date')) return 'needs_mapping';
	if (!has('amount') && !has('income') && !has('expense')) return 'needs_mapping';
	if (has('amount') && (has('income') || has('expense'))) return 'needs_mapping';
	return null;
}

const CSV_REASON: Readonly<Record<SheetSkipReason, SkipReason>> = {
	amount_not_number: 'unparseable_amount',
	amount_missing: 'missing_amount',
	date_missing: 'missing_date',
	date_invalid: 'unparseable_date',
	total_row: 'missing_date',
	type_unknown: 'transfer',
	foreign_currency: 'unsupported_currency'
};

export interface TabRows {
	tab: number;
	/** Rows of this tab counted (imported or skipped), past the header. */
	rows: number;
	issue: TabIssue | null;
}

export interface MappedSheet {
	/** Every counted row of every used tab, in tab and row order, at most `maxRows`. */
	rows: MappedRow[];
	/** Rows past `maxRows` (and rows the reader dropped past its own cap). */
	notProcessed: number;
	skips: SheetSkipCounts;
	tabs: TabRows[];
}

/** A cell's text for a title or category: cleaned, capped, account and card numbers cut to the last 4 digits. */
const textOf = (cell: SheetCell | null | undefined, max: number) =>
	maskAccountNumbers(cleanText(cellText(cell), max));

/** One tab's kind rule, or the issue that stops it. */
function kindRule(
	grid: SheetGrid,
	m: TabMapping
): { rule: 'columns' | 'expense' | 'income' | 'sign' } | { issue: TabIssue } {
	if (m.kind !== 'auto') {
		// A chosen kind applies to an amount column; in/out columns still say the kind of their own rows.
		const hasInOut = m.columns.includes('income') || m.columns.includes('expense');
		return { rule: hasInOut ? 'columns' : m.kind };
	}
	const rule = autoKind(grid, m);
	return rule ? { rule } : { issue: 'needs_kind' };
}

/**
 * The confirmed mapping applied to the workbook's cells. Rows are keyed `tab * TAB_KEY_STRIDE + row number`
 * (stable whatever the mapping or skip choices); a repeated header and rows without any mapped content are not
 * rows at all; totals, rows without a date or a numeric amount are counted as skipped by reason.
 */
export function mapSheets(workbook: Workbook, mapping: SheetMapping, maxRows: number): MappedSheet {
	const skips = Object.fromEntries(SHEET_SKIP_REASONS.map((r) => [r, 0])) as SheetSkipCounts;
	const out: MappedSheet = { rows: [], notProcessed: 0, skips, tabs: [] };
	for (const m of mapping.tabs) {
		const grid = workbook.sheets.find((s) => s.index === m.tab);
		if (!grid || !m.use) continue;
		const tab: TabRows = { tab: m.tab, rows: 0, issue: columnsIssue(m.columns) };
		out.tabs.push(tab);
		if (tab.issue) continue;
		const kind = kindRule(grid, m);
		if ('issue' in kind) {
			tab.issue = kind.issue;
			continue;
		}
		const month = m.month ?? monthFromTitle(grid.name);
		if (!month && hasDayOnlyDates(grid, m, workbook.date1904)) {
			tab.issue = 'needs_month';
			continue;
		}
		mapTab(grid, m, kind.rule, month, workbook.date1904, mapping.fillDown, maxRows, out, tab);
		out.notProcessed += grid.droppedRows;
	}
	return out;
}

function mapTab(
	grid: SheetGrid,
	m: TabMapping,
	rule: 'columns' | 'expense' | 'income' | 'sign',
	month: string | null,
	date1904: boolean,
	fillDown: boolean,
	maxRows: number,
	out: MappedSheet,
	tab: TabRows
) {
	const col = (role: ColumnRole) => m.columns.indexOf(role);
	const [dateCol, titleCol, categoryCol, amountCol, incomeCol, expenseCol, typeCol] = (
		['date', 'title', 'category', 'amount', 'income', 'expense', 'type'] as const
	).map(col) as [number, number, number, number, number, number, number];
	const mapped = m.columns.flatMap((r, i) => (r === 'ignore' ? [] : [i]));
	const header = grid.rows.find((r) => r.r === m.headerRow);
	const headerKeys = mapped.map((c) => headerKey(cellText(header?.cells[c])));
	let lastDate: string | null = null;

	for (const row of grid.rows) {
		if (row.r <= m.headerRow) continue;
		const cell = (c: number) => (c < 0 ? null : (row.cells[c] ?? null));
		const keys = mapped.map((c) => headerKey(cellText(cell(c))));
		if (keys.every((k) => k === '')) continue;
		// The header repeated mid-sheet (layout f): not a row.
		if (header && keys.filter((k, i) => k !== '' && k === headerKeys[i]).length >= 2) continue;
		if (out.rows.length >= maxRows) {
			out.notProcessed++;
			continue;
		}
		tab.rows++;
		const index = m.tab * TAB_KEY_STRIDE + row.r;
		const skip = (reason: SheetSkipReason) => {
			out.skips[reason]++;
			out.rows.push({ index, ok: false, reason: CSV_REASON[reason] });
		};
		const texts = mapped.flatMap((c) => {
			const v = cell(c);
			return v?.kind === 'text' ? [headerKey(v.text)] : [];
		});
		if (texts.some((t) => TOTAL_ROW.test(t))) {
			skip('total_row');
			continue;
		}

		const dateCell = cell(dateCol);
		let date: string | null;
		if (!dateCell || cellText(dateCell).trim() === '') {
			if (!fillDown || !lastDate) {
				skip('date_missing');
				continue;
			}
			date = lastDate;
		} else {
			const read =
				dateCell.kind === 'number'
					? numberDate(dateCell.text, dateCell.date, date1904)
					: dateCell.kind === 'text'
						? parseTextDate(dateCell.text)
						: ({ kind: 'invalid' } as const);
			date =
				read.kind === 'date'
					? read.date
					: read.kind === 'day' && month
						? placeDay(read, month)
						: null;
			if (!date) {
				skip('date_invalid');
				continue;
			}
			lastDate = date;
		}

		let minor: number;
		let type: 'expense' | 'income' | null = null;
		if (amountCol >= 0) {
			const read = amountOfCell(cell(amountCol));
			if (typeof read !== 'object') {
				skip(
					read === 'missing'
						? 'amount_missing'
						: read === 'foreign'
							? 'foreign_currency'
							: 'amount_not_number'
				);
				continue;
			}
			minor = read.minor;
			if (rule === 'columns') {
				type = typeCol >= 0 ? kindOfType(cellText(cell(typeCol))) : null;
				if (!type) {
					skip('type_unknown');
					continue;
				}
			}
		} else {
			const reads = [
				{ kind: 'income' as const, read: amountOfCell(cell(incomeCol)) },
				{ kind: 'expense' as const, read: amountOfCell(cell(expenseCol)) }
			];
			const bad = reads.find((r) => r.read === 'not_number' || r.read === 'foreign');
			if (bad) {
				skip(bad.read === 'foreign' ? 'foreign_currency' : 'amount_not_number');
				continue;
			}
			const present = reads.filter(
				(r): r is { kind: 'income' | 'expense'; read: { minor: number } } =>
					typeof r.read === 'object' && r.read.minor !== 0
			);
			if (present.length === 0) {
				skip('amount_missing');
				continue;
			}
			if (present.length > 1) {
				skip('type_unknown');
				continue;
			}
			const only = present[0] as { kind: 'income' | 'expense'; read: { minor: number } };
			minor = only.read.minor;
			type = only.kind;
		}
		if (minor === 0) {
			skip('amount_missing');
			continue;
		}
		if (rule === 'sign') type = minor < 0 ? 'expense' : 'income';
		else if (rule === 'expense' || rule === 'income') type = rule;
		if (!type) {
			skip('type_unknown');
			continue;
		}

		out.rows.push({
			index,
			ok: true,
			value: {
				date,
				type,
				title: textOf(cell(titleCol), TITLE_MAX_LENGTH),
				amountMinor: Math.abs(minor),
				currency: 'IDR',
				categoryName: textOf(cell(categoryCol), CATEGORY_NAME_MAX_LENGTH),
				walletName: '',
				paymentMethod: '',
				recurrence: '',
				tag: '',
				notes: '',
				reference: ''
			}
		});
	}
}
