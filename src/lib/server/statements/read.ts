import { CSV_MAX_ROWS, parseCsv, type CsvParseError } from '../../shared/csv.ts';
import {
	decodeStatementText,
	detectInstitution,
	letterheadClaims,
	sniffStatementFile,
	statementHints,
	type StatementHints
} from '../../shared/statements/detect.ts';
import { STATEMENT_PARSERS } from '../../shared/statements/parsers.ts';
import { balanceCheck, type BalanceCheck } from '../../shared/statements/rows.ts';
import type {
	StatementDocument,
	StatementParse,
	StatementParser
} from '../../shared/statements/types.ts';
import {
	choiceOf,
	pickSection,
	type StatementSectionChoice
} from '../../shared/statements/sections.ts';
import { extractPdfText } from './pdf-text.ts';

/**
 * One uploaded statement file → its institution's rows (FN-16a), entirely in memory: the bytes and the
 * extracted text are never stored, logged or returned (CLAUDE.md uploads rule). Shared by the /impor actions and
 * the local compatibility harness (`npm run compat:statements`), so both read a file exactly the same way.
 */

/** Largest statement file one request reads (owner decision B). */
export const STATEMENT_MAX_BYTES = 15 * 1024 * 1024;

export type StatementRefusal =
	/** Neither PDF, spreadsheet nor UTF-8/UTF-16 text. */
	| 'not_readable'
	/** XLS/XLSX: no institution is confirmed to export one, so no reader ships (see the engineer report). */
	| 'spreadsheet_unsupported'
	| 'encrypted'
	| 'wrong_password'
	| 'corrupt'
	| 'too_complex'
	/** A scanned/image-only PDF: FN-16's AI read, not configured. */
	| 'needs_ai'
	/** A FN-18 template or Money Manager CSV: the CSV import reads it. */
	| 'montra_csv'
	/** No parser claims the file ("format belum didukung"). */
	| 'institution_unknown'
	/** The institution the user picked does not read this kind of file, or the file is another bank's. */
	| 'institution_mismatch'
	/** Two banks' letterheads in one file (one was planted in remark text): refused, never a manual pick. */
	| 'institution_conflict'
	/** This isolate's PDF reader stayed busy (answered 503 with Retry-After). */
	| 'reader_busy'
	/** The statement does not check out against itself (running balances, totals, an unreadable row). */
	| 'inconsistent'
	/** The parser found no readable transaction row (the import answers it; never shown as success). */
	| 'no_rows'
	/** The file holds several accounts and none was picked (FN-16e): the user picks one from `sections`. */
	| 'section_required'
	/** The picked account is not in this file. */
	| 'section_unknown'
	/** The picked (or only) account is not an IDR savings or current account: never read into transactions. */
	| 'section_unsupported'
	/** FN-55b: a credit-card statement, but the wallet picked is not a `kartu_kredit` wallet (or none was). */
	| 'needs_card_wallet'
	/** FN-55b: an account statement, but the wallet picked is a `kartu_kredit` wallet (the sign would flip). */
	| 'needs_bank_wallet'
	/** FN-55b: a card statement layout not supported yet (more than one printed card). */
	| 'card_unsupported'
	/** FN-55b: the card wallet is not in rupiah (card statements are IDR only). */
	| 'card_currency'
	/** FN-55b: the printed card's last 4 digits differ from the wallet's. */
	| 'card_mismatch'
	/** FN-55b: this card's statement of that date is already imported (a live `card_statements` row). */
	| 'card_already_imported'
	/** FN-55b: the card already keeps CARD_STATEMENTS_MAX live statements. */
	| 'card_limit'
	| CsvParseError;

export type { StatementSectionChoice };

export type StatementReadFormat = StatementDocument['format'];

interface StatementReading {
	format: StatementReadFormat;
	institution: { id: string; label: string };
	/** Detection confidence (1 when the user picked the institution). */
	confidence: number;
	/** The user picked the institution (detection did not). */
	manual: boolean;
	/** Pages read (PDF) or null. */
	pages: number | null;
	/** Declared PDF pages past the page cap, not read. */
	pagesNotProcessed: number;
	/** Rows past CSV_MAX_ROWS, not processed. */
	notProcessed: number;
	parse: StatementParse;
	balance: BalanceCheck;
	/** The account read, for a statement that holds accounts (FN-16e); null otherwise. */
	section: StatementSectionChoice | null;
	/** Every account in the file (empty for a statement without sections). */
	sections: StatementSectionChoice[];
}

export type StatementReadResult =
	| { ok: true; reading: StatementReading }
	| {
			ok: false;
			error: StatementRefusal;
			/** What was recognised about the file (`institution_unknown`, `montra_csv`, `institution_mismatch`). */
			hints: StatementHints | null;
			/** The file's accounts, for the picker (FN-16e); absent for a statement without sections. */
			sections?: StatementSectionChoice[];
	  };

export interface StatementReadInput {
	/** The file. A PDF's buffer is handed to PDF.js without a copy and may be detached afterwards. */
	bytes: Uint8Array;
	/** PDF password, used for this read only; never stored or logged. */
	password: string | null;
	/** Institution id the user picked; null: detect. */
	institution: string | null;
	/** Account picked in a multi-account statement (its `index`); null or absent: the only one. */
	section?: number | null;
	/**
	 * FN-55b: the kind of the wallet the statement goes to (`card`: a `kartu_kredit` wallet); absent: `bank`. Only
	 * parsers of that kind are read with; a statement of the other kind is refused (its sign convention differs).
	 */
	walletKind?: 'bank' | 'card';
}

const refuse = (
	error: StatementRefusal,
	hints: StatementHints | null = null,
	sections?: StatementSectionChoice[]
) => ({ ok: false, error, hints, ...(sections ? { sections } : {}) }) as const;

/** Widest statement CSV record read: a remark's commas widen only its description (FN-16c red team L1). */
const STATEMENT_CSV_MAX_COLUMNS = 200;

async function documentOf(
	input: StatementReadInput
): Promise<
	| { ok: true; doc: StatementDocument; pagesNotProcessed: number; notProcessed: number }
	| { ok: false; error: StatementRefusal }
> {
	const kind = sniffStatementFile(input.bytes);
	if (kind === 'xlsx' || kind === 'xls') return { ok: false, error: 'spreadsheet_unsupported' };
	if (kind === 'pdf') {
		const pdf = await extractPdfText(input.bytes, { password: input.password });
		if (!pdf.ok) return { ok: false, error: pdf.reason === 'no_text' ? 'needs_ai' : pdf.reason };
		return {
			ok: true,
			doc: { format: 'pdf_text', pages: pdf.pages, layout: pdf.layout },
			pagesNotProcessed: pdf.pagesNotProcessed,
			notProcessed: 0
		};
	}
	const text = kind === 'text' ? decodeStatementText(input.bytes) : null;
	if (text === null) return { ok: false, error: 'not_readable' };
	// FN-16c red team L1: a remark another person wrote may hold a lone `"` or many commas. A file whose quotes
	// do not pair up is read again with `"` as text; a bank parser's own self-checks then decide, so nothing is
	// guessed. Statement records are read up to STATEMENT_CSV_MAX_COLUMNS wide (the bank's columns stay the last).
	let parsed = parseCsv(text, { maxColumns: STATEMENT_CSV_MAX_COLUMNS });
	if (!parsed.ok && parsed.error === 'unterminated_quote')
		parsed = parseCsv(text, { maxColumns: STATEMENT_CSV_MAX_COLUMNS, literalQuotes: true });
	if (!parsed.ok) return parsed;
	return {
		ok: true,
		doc: { format: 'csv', rows: parsed.rows },
		pagesNotProcessed: 0,
		notProcessed: parsed.more
	};
}

/**
 * Reads the file: kind by magic bytes, PDF text (unpdf) or CSV (FN-18's reader), then the picked institution's
 * parser or the detected one. Never throws for bad input; every refusal is typed.
 */
export async function readStatement(
	input: StatementReadInput,
	parsers: readonly StatementParser[] = STATEMENT_PARSERS
): Promise<StatementReadResult> {
	const read = await documentOf(input);
	if (!read.ok) return refuse(read.error);
	const { doc } = read;
	const hints = statementHints(doc);
	let parser: StatementParser | null;
	let confidence = 1;
	const manual = input.institution !== null;
	const claims = letterheadClaims(doc, parsers);
	if (claims.length > 1) return refuse('institution_conflict', hints);
	if (manual) {
		parser = parsers.find((p) => p.id === input.institution) ?? null;
		if (!parser || !parser.formats.includes(doc.format))
			return refuse('institution_mismatch', hints);
		if (claims.length === 1 && claims[0] !== parser) return refuse('institution_mismatch', hints);
	} else {
		const detected = detectInstitution(doc, parsers);
		parser = detected.institution;
		confidence = detected.confidence;
	}
	if (!parser) return refuse(hints.montraCsv ? 'montra_csv' : 'institution_unknown', hints);
	// FN-55b: a card statement only into a card wallet, an account statement only into any other wallet.
	const kind = parser.kind ?? 'bank';
	if (kind !== (input.walletKind ?? 'bank'))
		return refuse(kind === 'card' ? 'needs_card_wallet' : 'needs_bank_wallet', hints);
	const whole = parser.parse(doc);
	if (kind === 'card' && whole.unsupported === 'multiple_cards')
		return refuse('card_unsupported', hints);
	// A card statement is refused whole on any doubt, including one past the row cap (never truncated).
	if (whole.inconsistent || (kind === 'card' && (!whole.card || whole.rows.length > CSV_MAX_ROWS)))
		return refuse('inconsistent', hints);
	let parse = whole;
	let section: StatementSectionChoice | null = null;
	const sections = whole.sections?.map(choiceOf) ?? [];
	if (whole.sections) {
		const picked = pickSection(whole.sections, input.section ?? null);
		if (!picked.ok) return refuse(picked.error, hints, sections);
		parse = picked.section.parse;
		section = sections[picked.index]!;
	}
	const rows = parse.rows.slice(0, CSV_MAX_ROWS);
	return {
		ok: true,
		reading: {
			format: doc.format,
			institution: { id: parser.id, label: parser.label },
			confidence,
			manual,
			pages: doc.format === 'pdf_text' ? doc.pages.length : null,
			pagesNotProcessed: read.pagesNotProcessed,
			notProcessed: read.notProcessed + (parse.rows.length - rows.length),
			parse: { ...parse, rows },
			// Over the rows actually imported: a file cut at CSV_MAX_ROWS shows its gap, never a "pass".
			balance: balanceCheck({ ...parse, rows }),
			section,
			sections
		}
	};
}
