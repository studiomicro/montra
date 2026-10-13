import { detectCsvFormat, type CsvFormat } from '../csv.ts';
import type { StatementDocument, StatementParser } from './types.ts';

/**
 * Format and institution detection for statement files (FN-16a). Pure: magic bytes and the parsers' own
 * documented phrases only — never a guess from a file name, a MIME type, or a column count.
 */

/** What the bytes are, by their magic number (the extension and MIME type the browser sends are ignored). */
export type StatementFileKind = 'pdf' | 'xlsx' | 'xls' | 'text' | 'unknown';

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0) =>
	magic.every((b, i) => bytes[at + i] === b);

/** `%PDF-` within the first 1024 bytes (PDF.js accepts a header after leading junk). */
function hasPdfHeader(bytes: Uint8Array): boolean {
	const end = Math.min(bytes.length, 1024) - 5;
	for (let i = 0; i <= end; i++)
		if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return true;
	return false;
}

/**
 * The file kind by magic number: PDF (`%PDF-`), XLSX (a ZIP container, `PK\x03\x04`), legacy XLS (an OLE
 * compound file, `D0 CF 11 E0 A1 B1 1A E1`), text (decodes as UTF-8 or BOM-marked UTF-16), else unknown.
 */
export function sniffStatementFile(bytes: Uint8Array): StatementFileKind {
	if (hasPdfHeader(bytes)) return 'pdf';
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'xlsx';
	if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'xls';
	return decodeStatementText(bytes) === null ? 'unknown' : 'text';
}

/**
 * The bytes as text: a UTF-16 LE/BE byte-order mark selects UTF-16, anything else must be strict UTF-8 (a
 * UTF-8 BOM is dropped). A file in another encoding (Windows-1252, …), or holding NUL characters (binary), is
 * null — refused with "re-save as UTF-8", never read as mojibake.
 */
export function decodeStatementText(bytes: Uint8Array): string | null {
	let encoding = 'utf-8';
	if (startsWith(bytes, [0xff, 0xfe])) encoding = 'utf-16le';
	else if (startsWith(bytes, [0xfe, 0xff])) encoding = 'utf-16be';
	let text: string;
	try {
		text = new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
	if (text.includes('\u0000')) return null;
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Least confidence a parser must claim for its institution to be chosen automatically. */
export const MIN_DETECT_CONFIDENCE = 0.5;

export type InstitutionDetection =
	{ institution: StatementParser; confidence: number } | { institution: null; confidence: 0 };

/**
 * The institution whose parser claims the document most confidently (at least MIN_DETECT_CONFIDENCE, and for
 * one of the parser's formats). Two parsers tied at the top are "unknown": the user picks, it is never guessed.
 */
export function detectInstitution(
	doc: StatementDocument,
	parsers: readonly StatementParser[]
): InstitutionDetection {
	let best: StatementParser | null = null;
	let bestScore = 0;
	let tied = false;
	for (const parser of parsers) {
		if (!parser.formats.includes(doc.format)) continue;
		const score = parser.detect(doc);
		if (!(score >= MIN_DETECT_CONFIDENCE)) continue;
		if (score > bestScore) {
			best = parser;
			bestScore = score;
			tied = false;
		} else if (score === bestScore) tied = true;
	}
	return best && !tied
		? { institution: best, confidence: Math.min(1, bestScore) }
		: { institution: null, confidence: 0 };
}

/**
 * The score a parser gives only when the bank's own letterhead is printed (title, bank line and table header):
 * every shipped parser tops out here.
 */
export const LETTERHEAD_CONFIDENCE = 0.9;

/**
 * The parsers that find their bank's full letterhead in the document (FN-16e red team L3). A genuine statement
 * never carries two banks' letterheads, so two claims mean one was planted in third-party text (a transfer
 * remark): the file is refused, never offered for a manual pick. One claim is the file's bank: a manual pick of
 * another parser is a mismatch, so a parser never reads only structure planted inside another bank's file.
 */
export function letterheadClaims(
	doc: StatementDocument,
	parsers: readonly StatementParser[]
): StatementParser[] {
	return parsers.filter(
		(p) => p.formats.includes(doc.format) && p.detect(doc) >= LETTERHEAD_CONFIDENCE
	);
}

/** What was recognised about a file no parser claims: counts and shapes only, never its content. */
export interface StatementHints {
	format: StatementDocument['format'];
	/** Pages read (PDF). */
	pages: number | null;
	/** Header columns (CSV). */
	columns: number | null;
	/** The header is one of FN-18's own CSV shapes: it belongs in the CSV import, not here. */
	montraCsv: CsvFormat | null;
}

export function statementHints(doc: StatementDocument): StatementHints {
	if (doc.format === 'pdf_text')
		return { format: doc.format, pages: doc.pages.length, columns: null, montraCsv: null };
	const header = doc.rows[0] ?? [];
	return {
		format: doc.format,
		pages: null,
		columns: header.length,
		montraCsv: detectCsvFormat(header)
	};
}
