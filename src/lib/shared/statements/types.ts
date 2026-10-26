import type { MappedRow } from '../csv.ts';

/**
 * E-statement reading (FN-16a), shared by the app Worker and the local compatibility harness. A statement row is
 * FN-18's `MappedRow`/`RawCsvTransaction` with a different reader in front of it, never a second row type.
 */
export type { MappedRow } from '../csv.ts';

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

type StatementDocumentFormat = StatementDocument['format'];

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
	/**
	 * FN-55b, a card parser only: what the card statement printed (balances in the wallet's convention, owed
	 * negative) and each row's class. Built only by `buildCardStatement` (card-rows.ts), which also sets
	 * `inconsistent` when any of its self-checks fails.
	 */
	card?: CardStatementFigures;
	/** FN-55b: why the statement is refused although it reads (a layout not supported yet), with `inconsistent`. */
	unsupported?: 'multiple_cards';
}

/** FN-55b: how a card statement row is counted and categorised (card-rows.ts `classifyCardRow`). */
export type CardRowClass =
	'purchase' | 'installment' | 'fee' | 'interest' | 'tax' | 'payment' | 'credit';

/** FN-55b: the figures a card statement printed, as stored on `card_statements` (IDR minor units). */
export interface CardStatementFigures {
	/** WIB date `YYYY-MM-DD`. */
	statementDate: string;
	dueDate: string | null;
	/** The printed period, when the statement prints one. */
	periodFrom: string | null;
	periodTo: string | null;
	/** The earliest printed posting date (null when none is printed); a span fallback (continuity.ts). */
	firstPostingDate: string | null;
	/** Wallet convention: owed is negative, a printed credit (CR) balance positive. */
	previousBalanceMinor: number;
	newBalanceMinor: number;
	/** As printed, never computed; null when not printed. */
	minimumPaymentMinor: number | null;
	limitMinor: number | null;
	/** Last 4 digits of the one printed card number; null when the statement prints none. */
	cardLast4: string | null;
	/** Row sums per class (positive magnitudes): payments, other credits, purchases (with installments), fees (with tax), interest. */
	totals: { payments: number; credits: number; purchases: number; fees: number; interest: number };
	/** Each row's class, by its position in `rows`. */
	classes: readonly CardRowClass[];
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
	/**
	 * FN-55b: `card` reads a credit-card statement into a `kartu_kredit` wallet (its own id, e.g. `bca-card`, never
	 * a layout inside the bank's parser); absent or `bank`: an account statement. The wallet picked decides which
	 * kind is offered and detected (read.ts).
	 */
	kind?: 'bank' | 'card';
	/**
	 * A `msg()` phrase shown with the "needs password" and "wrong password" answers, written only from the issuer's
	 * own e-statement e-mail or cover text (FN-55 B6); absent: the generic answer.
	 */
	passwordHint?: string;
	/** Name shown to the user (a bank's own name, not translated). */
	label: string;
	formats: readonly StatementDocumentFormat[];
	/** Confidence 0–1 that the document is this institution's statement; 0 means "not mine". */
	detect(doc: StatementDocument): number;
	/** The rows plus printed balances. Opening/closing/running-balance lines are never rows. */
	parse(doc: StatementDocument): StatementParse;
}
