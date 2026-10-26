import { lineText, meanConfidence, type OcrDocument, type OcrPage } from './lines.ts';

/**
 * How engine confidence turns into review (FN-16g, PRD Scope 5.2). A number the engine is unsure of is never
 * repaired: below OCR_MIN_NUMERIC_CONF it is replaced by an unreadable marker before any parser sees it, so its
 * row cannot be read and the statement's self-checks fail; between that and OCR_REVIEW_NUMERIC_CONF it is kept
 * and its row is marked for review. Starting points, to be calibrated with `npm run compat:ocr` on real samples
 * (not measured yet).
 */
export const OCR_MIN_NUMERIC_CONF = 70;
export const OCR_REVIEW_NUMERIC_CONF = 90;

/** A page below this mean word confidence, or with fewer words, is "photo unclear": its rows go to review. */
const OCR_UNCLEAR_MEAN_CONF = 60;
const OCR_UNCLEAR_MIN_WORDS = 8;

/** What a poisoned word becomes: no parser reads it as a digit, a sign or a date. */
export const UNREADABLE = '�';

/** A word that carries a figure: any digit, or a currency mark (`Rp`, `IDR`) possibly signed. */
export function looksNumeric(text: string): boolean {
	return /\p{Nd}/u.test(text) || /^[+\-−]?(?:rp|idr)\.?$/i.test(text);
}

/** Numeric words below the floor become UNREADABLE; every line's text is rebuilt from its words. */
export function poisonLowConfidence(doc: OcrDocument): OcrDocument {
	return {
		pages: doc.pages.map((page) => {
			const lines = page.lines.map((line) => {
				const words = line.words.map((w) =>
					w.c < OCR_MIN_NUMERIC_CONF && looksNumeric(w.t) ? { ...w, t: UNREADABLE } : w
				);
				return { ...line, words, text: lineText(words) };
			});
			return { ...page, lines };
		})
	};
}

/** True when the page's reading is too weak to trust (blurry, dark or skewed photo). */
export function pageUnclear(page: OcrPage): boolean {
	const words = page.lines.reduce((n, l) => n + l.words.length, 0);
	return words < OCR_UNCLEAR_MIN_WORDS || meanConfidence(page.lines) < OCR_UNCLEAR_MEAN_CONF;
}

/** True when a word is a kept figure the engine was not sure enough of: its row is reviewed. */
export const needsNumericReview = (w: { t: string; c: number }) =>
	looksNumeric(w.t) && w.c >= OCR_MIN_NUMERIC_CONF && w.c < OCR_REVIEW_NUMERIC_CONF;
