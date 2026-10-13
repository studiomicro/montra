import { msg } from './i18n.ts';
import type { CategoryKind, TransactionSource } from './transactions.ts';

/** Capture sources a draft comes from: every transaction source except `manual` (a typed row needs no review). */
export const DRAFT_SOURCES = [
	'gmail',
	'voice',
	'receipt',
	'statement',
	'spreadsheet',
	'csv',
	'slack'
] as const satisfies readonly TransactionSource[];
export type DraftSource = (typeof DRAFT_SOURCES)[number];

/** Set by a capture (FN-19's duplicate check, a low-confidence read); FN-11 only shows it. */
export const DRAFT_FLAGS = ['duplicate', 'needs_review'] as const;
export type DraftFlag = (typeof DRAFT_FLAGS)[number];

export const DRAFT_SOURCE_LABELS: Readonly<Record<DraftSource, string>> = {
	// FN-19: forwarded mail is captured as `gmail` (owner decision 2: no new source value), shown as "E-mail".
	gmail: msg('E-mail'),
	voice: msg('Suara'),
	receipt: msg('Struk'),
	statement: msg('Mutasi'),
	spreadsheet: msg('Spreadsheet'),
	csv: msg('CSV'),
	slack: msg('Slack')
};

/** Most drafts one bulk action (Atur kategori, Atur dompet, Simpan) works on per request. */
export const DRAFT_BATCH_MAX = 50;

/**
 * The value of a draft's checkbox: its id and the `updated_at` the page was loaded with, so a write against a
 * draft that changed meanwhile is refused ("changed meanwhile"), never applied to the newer state.
 */
export function draftToken(draft: { id: string; updatedAt: number }): string {
	return `${draft.id}:${draft.updatedAt}`;
}

/** The one kind every selected draft shares, `mixed` when expense and income are both selected, null when empty. */
export function selectionKind(types: readonly CategoryKind[]): CategoryKind | 'mixed' | null {
	const kinds = new Set(types);
	if (kinds.size === 0) return null;
	if (kinds.size > 1) return 'mixed';
	return types[0] as CategoryKind;
}

/** Rows (already newest day first) in WIB-day groups by `occurredOn`, keeping their order. */
export function groupByDay<T extends { occurredOn: string }>(
	rows: readonly T[]
): { date: string; rows: T[] }[] {
	const days: { date: string; rows: T[] }[] = [];
	for (const row of rows) {
		const last = days.at(-1);
		if (last && last.date === row.occurredOn) last.rows.push(row);
		else days.push({ date: row.occurredOn, rows: [row] });
	}
	return days;
}
