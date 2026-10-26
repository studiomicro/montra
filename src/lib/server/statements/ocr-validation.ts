import { z } from 'zod';
import { CSV_MAX_ROWS } from '#lib/shared/csv';
import { lineText, meanConfidence, type OcrDocument } from '#lib/shared/ocr/lines';
import { SCREEN_PARSERS } from '#lib/shared/ocr/read';
import { STATEMENT_PARSERS } from '#lib/shared/statements/parsers';
import { cleanText } from '#lib/shared/text';
import {
	OCR_FIELDS_INVALID,
	OCR_PAYLOAD_INVALID,
	STATEMENT_SECTION_INVALID
} from '../imports/messages';
import { ID_MAX_LENGTH } from '../transactions/validation';

/**
 * The on-device OCR actions' input (FN-16g, PRD Scope 4): the recognised words only (never an image), checked
 * against hard bounds with zod — unknown keys refused, prototype-safe — and cleaned before any parser sees them.
 * The server rebuilds every line's text and confidence from the words and ignores what the device computed.
 */

/** Largest body the OCR actions read (words of 12 pages; an image is never sent). */
export const OCR_BODY_MAX_BYTES = 512 * 1024;
const OCR_MAX_PAGES = 12;
const OCR_MAX_LINES_PER_PAGE = 250;
const OCR_MAX_WORDS_PER_PAGE = 3000;
const OCR_WORD_MAX_LENGTH = 64;
/** Longest line text accepted on the wire (it is rebuilt anyway). */
const OCR_LINE_TEXT_MAX = 4096;
const COORD_MAX = 20_000;

const coord = z.number().int().min(0).max(COORD_MAX);
const confidence = z.number().int().min(0).max(100);

const wordSchema = z.strictObject({
	t: z.string().min(1).max(OCR_WORD_MAX_LENGTH),
	c: confidence,
	x0: coord,
	x1: coord
});
const lineSchema = z.strictObject({
	y: coord,
	x: coord,
	text: z.string().max(OCR_LINE_TEXT_MAX),
	words: z.array(wordSchema).max(OCR_MAX_WORDS_PER_PAGE)
});
const pageSchema = z
	.strictObject({
		widthPx: coord,
		heightPx: coord,
		meanConf: confidence,
		lines: z.array(lineSchema).max(OCR_MAX_LINES_PER_PAGE)
	})
	.refine((p) => p.lines.reduce((n, l) => n + l.words.length, 0) <= OCR_MAX_WORDS_PER_PAGE);
const documentSchema = z.strictObject({ pages: z.array(pageSchema).min(1).max(OCR_MAX_PAGES) });

/** Row positions the user ticked in or out: bounded, never past the import's row cap. */
const picksSchema = z
	.array(
		z
			.number()
			.int()
			.min(0)
			.max(CSV_MAX_ROWS - 1)
	)
	.max(CSV_MAX_ROWS);

/** The document as the parsers see it: every word cleaned and capped, empty words dropped, text rebuilt. */
function cleaned(doc: z.infer<typeof documentSchema>): OcrDocument {
	return {
		pages: doc.pages.map((page) => {
			const lines = page.lines
				.map((line) => {
					const words = line.words
						.map((w) => ({ ...w, t: cleanText(w.t, OCR_WORD_MAX_LENGTH).replace(/\s+/g, '') }))
						.filter((w) => w.t !== '')
						.sort((a, b) => a.x0 - b.x0);
					return { y: line.y, x: words[0]?.x0 ?? line.x, text: lineText(words), words };
				})
				.filter((l) => l.words.length > 0)
				.sort((a, b) => a.y - b.y);
			return {
				widthPx: page.widthPx,
				heightPx: page.heightPx,
				meanConf: meanConfidence(lines),
				lines
			};
		})
	};
}

/** Parses the `ocr` field: JSON of the expected shape within every bound, or null. */
function parseOcrDocument(text: string): OcrDocument | null {
	if (text.length === 0 || text.length > OCR_BODY_MAX_BYTES) return null;
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return null;
	}
	const parsed = documentSchema.safeParse(json);
	return parsed.success ? cleaned(parsed.data) : null;
}

const SECTION_FIELD = /^(?:\d{1,2})?$/;

export interface OcrFields {
	doc: OcrDocument;
	/** Picked statement parser or screenshot family; null: detect. */
	institution: string | null;
	defaultWalletId: string | null;
	skipPossibleDuplicates: boolean;
	section: number | null;
	/** Review rows ticked in. */
	include: number[];
	/** Ready rows ticked out. */
	exclude: number[];
}

function picks(text: string): number[] | null {
	if (text === '') return [];
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return null;
	}
	const parsed = picksSchema.safeParse(json);
	return parsed.success ? parsed.data : null;
}

/** The OCR form's fields; any value out of bounds is refused with a content-free message. */
export function parseOcrFields(
	form: FormData
): { ok: true; value: OcrFields } | { ok: false; error: string } {
	const field = (name: string) => {
		const v = form.get(name);
		return typeof v === 'string' ? v : '';
	};
	const doc = parseOcrDocument(field('ocr'));
	if (!doc) return { ok: false, error: OCR_PAYLOAD_INVALID };
	const institution = field('institution');
	const known =
		institution === '' ||
		STATEMENT_PARSERS.some((p) => p.id === institution) ||
		SCREEN_PARSERS.some((p) => p.id === institution);
	const walletId = field('defaultWalletId');
	if (!known || walletId.length > ID_MAX_LENGTH) return { ok: false, error: OCR_FIELDS_INVALID };
	const section = field('statementSection');
	if (!SECTION_FIELD.test(section)) return { ok: false, error: STATEMENT_SECTION_INVALID };
	const include = picks(field('include'));
	const exclude = picks(field('exclude'));
	if (!include || !exclude) return { ok: false, error: OCR_FIELDS_INVALID };
	return {
		ok: true,
		value: {
			doc,
			institution: institution === '' ? null : institution,
			defaultWalletId: walletId === '' ? null : walletId,
			skipPossibleDuplicates: field('skipPossibleDuplicates') === 'on',
			section: section === '' ? null : Number(section),
			include,
			exclude
		}
	};
}
