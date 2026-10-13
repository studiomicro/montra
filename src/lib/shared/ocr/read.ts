import { CSV_MAX_ROWS, type MappedRow, type RowReview } from '../csv.ts';
import { parseMoneyAmount } from '../money-parse.ts';
import { detectInstitution, letterheadClaims } from '../statements/detect.ts';
import { STATEMENT_PARSERS } from '../statements/parsers.ts';
import { balanceCheck, type BalanceCheck } from '../statements/rows.ts';
import { choiceOf, pickSection, type StatementSectionChoice } from '../statements/sections.ts';
import type { StatementDocument, StatementParse, StatementParser } from '../statements/types.ts';
import { needsNumericReview, pageUnclear, poisonLowConfidence } from './confidence.ts';
import { textLayout, textPages, type OcrDocument } from './lines.ts';
import { firstReview, parseScreenList, screenClaims, type ScreenParser } from './screens/common.ts';
import { EWALLET_PARSERS } from './screens/ewallet.ts';
import { MOBILE_BANKING_PARSERS } from './screens/mobile-banking.ts';

/**
 * An on-device OCR reading (FN-16g, PRD Scope 5) → rows, deterministically: the same document always gives the
 * same rows, keys and order. Runs unchanged on the device (preview), in the compatibility harness and on the
 * server, which rebuilds it from the words and trusts nothing else the device sent.
 *
 * 1. Figures the engine was unsure of are poisoned (confidence.ts), never repaired.
 * 2. A bank letterhead → the per-bank statement parser over the page text, with every self-check it has; a gap in
 *    the printed balances refuses the whole document; no printed balances puts every row in review.
 * 3. Otherwise a screenshot family claimed by its own header words → the list reader (screens/common.ts).
 */

export const SCREEN_PARSERS: readonly ScreenParser[] = [
	...EWALLET_PARSERS,
	...MOBILE_BANKING_PARSERS
];

export type OcrRefusal =
	| 'institution_unknown'
	| 'institution_mismatch'
	| 'institution_conflict'
	| 'inconsistent'
	| 'no_rows'
	| 'section_required'
	| 'section_unknown'
	| 'section_unsupported';

export interface OcrReadInput {
	doc: OcrDocument;
	/** A statement parser or screenshot family id the user picked; null: detect. */
	institution: string | null;
	/** Account picked in a multi-account statement; null: the only one. */
	section: number | null;
	/** WIB date of the reading (relative days, assumed years, the no-future rule). */
	todayWib: string;
}

export interface OcrReading {
	kind: 'statement' | 'screenshot';
	institution: { id: string; label: string };
	manual: boolean;
	pages: number;
	/** Rows in reading order; `index` is the position. OK rows may carry a review reason. */
	rows: MappedRow[];
	/** Per row index: what tells identical rows apart in the dedupe key (balance after, else time, else ''). */
	keyParts: string[];
	balance: BalanceCheck;
	/** Pages whose reading is too weak to trust (their rows are in review). */
	unclearPages: number;
	/** Screenshot rows that failed, were cancelled or are pending: skipped. */
	notCompleted: number;
	/** Rows past CSV_MAX_ROWS, not processed. */
	notProcessed: number;
	section: StatementSectionChoice | null;
	sections: StatementSectionChoice[];
}

/** What a refusal may say: counts only, never row text. */
export interface OcrRefusalCounts {
	pages: number;
	rows: number;
	/** The printed-balance gap in IDR minor units, when that is why. */
	gapMinor: number | null;
}

export type OcrReadResult =
	| { ok: true; reading: OcrReading }
	| { ok: false; error: OcrRefusal; counts: OcrRefusalCounts; sections?: StatementSectionChoice[] };

const okRows = (rows: readonly MappedRow[]) => rows.filter((r) => r.ok).length;

/**
 * Bank rows whose figures were read with middling confidence: the amount or the day/month of the row matches a
 * figure the engine was unsure of. The bank parsers do not say which word a row came from, so this errs on the
 * side of review.
 */
function lowConfidenceRows(doc: OcrDocument, rows: readonly MappedRow[]): Set<number> {
	const amounts = new Set<number>();
	const days = new Set<string>();
	for (const page of doc.pages)
		for (const line of page.lines)
			for (const w of line.words) {
				if (!needsNumericReview(w)) continue;
				const amount = parseMoneyAmount(w.t);
				if (amount) amounts.add(Math.abs(amount.minor));
				const day = /^(\d{1,2})[/.-](\d{1,2})/.exec(w.t);
				if (day) days.add(`${day[2]!.padStart(2, '0')}-${day[1]!.padStart(2, '0')}`);
			}
	const flagged = new Set<number>();
	for (const r of rows)
		if (r.ok && (amounts.has(r.value.amountMinor) || days.has(r.value.date.slice(5))))
			flagged.add(r.index);
	return flagged;
}

function withReviews(rows: readonly MappedRow[], reasonsOf: (r: MappedRow) => Set<RowReview>) {
	return rows.map((r): MappedRow => {
		if (!r.ok) return r;
		const reasons = reasonsOf(r);
		if (r.review) reasons.add(r.review);
		const review = firstReview(reasons);
		return review ? { ...r, review } : r;
	});
}

function readStatement(
	doc: OcrDocument,
	text: StatementDocument,
	parser: StatementParser,
	input: OcrReadInput,
	manual: boolean
): OcrReadResult {
	const pages = doc.pages.length;
	const whole = parser.parse(text);
	const refused = (
		error: OcrRefusal,
		parse: StatementParse,
		gapMinor: number | null = null,
		sections?: StatementSectionChoice[]
	) => ({
		ok: false as const,
		error,
		counts: { pages, rows: okRows(parse.rows), gapMinor },
		...(sections ? { sections } : {})
	});
	if (whole.inconsistent) return refused('inconsistent', whole);
	let parse = whole;
	let section: StatementSectionChoice | null = null;
	const sections = whole.sections?.map(choiceOf) ?? [];
	if (whole.sections) {
		const picked = pickSection(whole.sections, input.section);
		if (!picked.ok) return refused(picked.error, whole, null, sections);
		parse = picked.section.parse;
		section = sections[picked.index]!;
	}
	const rows = parse.rows.slice(0, CSV_MAX_ROWS);
	const balance = balanceCheck({ ...parse, rows });
	// A scanned or photographed statement that does not add up is refused whole (PRD Scope 5.3).
	if (balance.status === 'gap') return refused('inconsistent', parse, balance.gapMinor);
	if (okRows(rows) === 0)
		return refused('no_rows', parse, null, sections.length > 0 ? sections : undefined);
	const unclear = doc.pages.filter(pageUnclear).length;
	const low = lowConfidenceRows(doc, rows);
	return {
		ok: true,
		reading: {
			kind: 'statement',
			institution: { id: parser.id, label: parser.label },
			manual,
			pages,
			rows: withReviews(rows, (r) => {
				const reasons = new Set<RowReview>();
				if (balance.status === 'omitted') reasons.add('no_balance_check');
				if (unclear > 0) reasons.add('photo_unclear');
				if (low.has(r.index)) reasons.add('low_confidence');
				return reasons;
			}),
			keyParts: rows.map(() => ''),
			balance,
			unclearPages: unclear,
			notCompleted: 0,
			notProcessed: parse.rows.length - rows.length,
			section,
			sections
		}
	};
}

function readScreens(
	doc: OcrDocument,
	parser: ScreenParser,
	input: OcrReadInput,
	manual: boolean
): OcrReadResult {
	const pages = doc.pages.length;
	const parse = parseScreenList(doc, { todayWib: input.todayWib });
	const all = parse.rows.map((r) => r.row);
	const counts = { pages, rows: okRows(all), gapMinor: null };
	if (parse.inconsistent) return { ok: false, error: 'inconsistent', counts };
	if (counts.rows === 0) return { ok: false, error: 'no_rows', counts };
	const kept = parse.rows.slice(0, CSV_MAX_ROWS);
	return {
		ok: true,
		reading: {
			kind: 'screenshot',
			institution: { id: parser.id, label: parser.label },
			manual,
			pages,
			rows: kept.map((r) => r.row),
			keyParts: kept.map((r) => r.keyPart),
			balance: { status: 'omitted' },
			unclearPages: doc.pages.filter(pageUnclear).length,
			notCompleted: parse.notCompleted,
			notProcessed: parse.rows.length - kept.length,
			section: null,
			sections: []
		}
	};
}

/** Reads an OCR document into rows; never throws for bad input, every refusal is typed. */
export function readOcrDocument(
	input: OcrReadInput,
	statementParsers: readonly StatementParser[] = STATEMENT_PARSERS,
	screenParsers: readonly ScreenParser[] = SCREEN_PARSERS
): OcrReadResult {
	const doc = poisonLowConfidence(input.doc);
	const text: StatementDocument = {
		format: 'pdf_text',
		pages: textPages(doc),
		layout: textLayout(doc)
	};
	const refuse = (error: OcrRefusal): OcrReadResult => ({
		ok: false,
		error,
		counts: { pages: doc.pages.length, rows: 0, gapMinor: null }
	});
	const letterheads = letterheadClaims(text, statementParsers);
	if (letterheads.length > 1) return refuse('institution_conflict');
	const screens = screenClaims(doc, screenParsers);
	if (input.institution !== null) {
		const bank = statementParsers.find((p) => p.id === input.institution);
		if (bank) {
			if (!bank.formats.includes('pdf_text')) return refuse('institution_mismatch');
			if (letterheads.length === 1 && letterheads[0] !== bank)
				return refuse('institution_mismatch');
			return readStatement(doc, text, bank, input, true);
		}
		const screen = screenParsers.find((p) => p.id === input.institution);
		if (!screen || letterheads.length === 1) return refuse('institution_mismatch');
		if (screens.length > 0 && !screens.includes(screen)) return refuse('institution_mismatch');
		return readScreens(doc, screen, input, true);
	}
	if (letterheads.length === 1) return readStatement(doc, text, letterheads[0]!, input, false);
	if (screens.length > 1) return refuse('institution_conflict');
	if (screens.length === 1) return readScreens(doc, screens[0]!, input, false);
	const detected = detectInstitution(text, statementParsers);
	if (detected.institution) return readStatement(doc, text, detected.institution, input, false);
	return refuse('institution_unknown');
}
