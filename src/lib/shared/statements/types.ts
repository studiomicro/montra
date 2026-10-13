import type { MappedRow } from '../csv.ts';

/**
 * E-statement reading (FN-16a), shared by the app Worker and the local compatibility harness. A statement row is
 * FN-18's `MappedRow`/`RawCsvTransaction` with a different reader in front of it, never a second row type.
 */
export type { MappedRow, RawCsvTransaction, SkipReason } from '../csv.ts';

/** What a statement file was read into before an institution parser sees it. */
export type StatementDocument =
	/**
	 * A PDF with a text layer: the text of each page, in order. `layout` (when the reader has positions: the PDF
	 * text layer, on-device OCR) gives each page's width and the left edge of each of its lines, in the same units.
	 */
	| { format: 'pdf_text'; pages: readonly string[]; layout?: readonly PageLayout[] }
	/** A CSV export: the header row first, then the records (blank lines dropped). */
	| { format: 'csv'; rows: readonly (readonly string[])[] };

/**
 * Where a page's lines start (FN-16f/16h red team L1): `lineX[i]` is the left edge of line `i` of
 * `page.split('\n')` (null for a line with no text), `width` the page's width, both in the reader's units.
 */
export interface PageLayout {
	width: number;
	lineX: readonly (number | null)[];
}

export type StatementDocumentFormat = StatementDocument['format'];

/** One institution parser's reading of a statement. */
export interface StatementParse {
	/** Transaction rows in statement order; `index` is the dedupe key's row index. */
	rows: MappedRow[];
	/** Printed opening balance (integer IDR minor units), null when the statement prints none. */
	openingBalanceMinor: number | null;
	/** Printed closing balance, null when the statement prints none. */
	closingBalanceMinor: number | null;
	/**
	 * The parser's own cross-checks failed (a printed running balance, total or period disagrees with the rows,
	 * or a row is unreadable): the whole statement is refused, nothing is imported.
	 */
	inconsistent?: boolean;
	/**
	 * A statement holding several accounts (a consolidated statement, FN-16e): each account's own reading. When
	 * present, the top-level rows are empty and one section is imported at a time (read.ts picks it).
	 */
	sections?: readonly StatementSection[];
}

/** One account of a statement that holds several (FN-16e). */
export interface StatementSection {
	/** The product name as printed (`Tabungan …`); bank text, cleaned and masked before it is shown. */
	label: string;
	/** Last 4 digits of the section's account number; null when it prints none (or several). */
	accountLast4: string | null;
	/**
	 * Why the section is never imported: a foreign currency, not a savings or current account (a deposit, card or
	 * investment summary), or its own self-checks failed. Null: importable.
	 */
	refusal: 'unsupported_currency' | 'not_transaction_account' | 'inconsistent' | null;
	/** The section's rows and printed balances; row indices are unique across the whole file (dedupe keys). */
	parse: StatementParse;
}

/**
 * One institution's statement reader: a single module under `src/lib/shared/statements/`, listed in
 * `parsers.ts`. Written only from a real, redacted sample (docs/features/fn-16a-statement-parsers/PRD.md);
 * `detect` uses the sample's own stable phrases (letterhead, header line), never a column count.
 */
export interface StatementParser {
	/** Stable id (`bca`, `bri`): the picker's value and the harness's institution column. */
	id: string;
	/** Name shown to the user (a bank's own name, not translated). */
	label: string;
	formats: readonly StatementDocumentFormat[];
	/** Confidence 0–1 that the document is this institution's statement; 0 means "not mine". */
	detect(doc: StatementDocument): number;
	/** The rows plus printed balances. Opening/closing/running-balance lines are never rows. */
	parse(doc: StatementDocument): StatementParse;
}
