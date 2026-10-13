/**
 * The on-device OCR result (FN-16g) as it leaves the device: words with their confidence and horizontal
 * position, grouped into lines. Integer coordinates only; no image data, no thumbnail, no file name. Built on
 * the device from the engine's word boxes, and rebuilt on the server from the words alone (the server never
 * trusts the client's line text), so both run this module.
 */
import type { PageLayout } from '../statements/types.ts';

export interface OcrWord {
	/** The recognised text, as read (never corrected). */
	t: string;
	/** Engine confidence 0–100. */
	c: number;
	/** Left and right edge in page pixels. */
	x0: number;
	x1: number;
}

export interface OcrLine {
	/** Top edge in page pixels. */
	y: number;
	/** Left edge in page pixels. */
	x: number;
	/** The words joined with gap-preserving spacing (rebuilt by the server from `words`). */
	text: string;
	words: OcrWord[];
}

export interface OcrPage {
	widthPx: number;
	heightPx: number;
	/** Mean word confidence 0–100 (recomputed by the server). */
	meanConf: number;
	lines: OcrLine[];
}

export interface OcrDocument {
	pages: OcrPage[];
}

/** One word box as the engine reports it (page pixels; fractional values are rounded). */
export interface RecognisedWord {
	text: string;
	confidence: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Most spaces a horizontal gap becomes: keeps columns apart without padding a line out. */
const MAX_GAP_SPACES = 8;

const clampConf = (c: number) => Math.max(0, Math.min(100, Math.round(c)));

/** The line's text: words in order, each gap as spaces in proportion to the line's character width. */
export function lineText(words: readonly OcrWord[]): string {
	if (words.length === 0) return '';
	let chars = 0;
	let width = 0;
	for (const w of words) {
		chars += Array.from(w.t).length;
		width += Math.max(0, w.x1 - w.x0);
	}
	const charWidth = chars > 0 && width > 0 ? width / chars : 1;
	let out = words[0]!.t;
	for (let i = 1; i < words.length; i++) {
		const gap = words[i]!.x0 - words[i - 1]!.x1;
		const spaces = Math.max(1, Math.min(MAX_GAP_SPACES, Math.round(gap / charWidth)));
		out += ' '.repeat(spaces) + words[i]!.t;
	}
	return out;
}

/** Mean word confidence of a page (integer), 0 for a page without words. */
export function meanConfidence(lines: readonly OcrLine[]): number {
	let sum = 0;
	let n = 0;
	for (const line of lines)
		for (const w of line.words) {
			sum += w.c;
			n++;
		}
	return n === 0 ? 0 : Math.round(sum / n);
}

interface Pending {
	top: number;
	bottom: number;
	words: { word: OcrWord; y0: number }[];
}

/**
 * Word boxes → lines: a word joins the line whose vertical span overlaps it by at least half the smaller
 * height, lines are ordered top to bottom and words left to right. Empty words are dropped.
 */
export function buildPage(
	words: readonly RecognisedWord[],
	widthPx: number,
	heightPx: number
): OcrPage {
	const boxes = words
		.map((w) => ({
			text: w.text.trim(),
			c: clampConf(w.confidence),
			x0: Math.round(Math.min(w.x0, w.x1)),
			x1: Math.round(Math.max(w.x0, w.x1)),
			y0: Math.round(Math.min(w.y0, w.y1)),
			y1: Math.round(Math.max(w.y0, w.y1))
		}))
		.filter((w) => w.text !== '')
		.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
	const pending: Pending[] = [];
	for (const box of boxes) {
		const height = Math.max(1, box.y1 - box.y0);
		const line = pending.find((l) => {
			const overlap = Math.min(l.bottom, box.y1) - Math.max(l.top, box.y0);
			return overlap >= Math.min(height, Math.max(1, l.bottom - l.top)) / 2;
		});
		const word = { word: { t: box.text, c: box.c, x0: box.x0, x1: box.x1 }, y0: box.y0 };
		if (line) {
			line.top = Math.min(line.top, box.y0);
			line.bottom = Math.max(line.bottom, box.y1);
			line.words.push(word);
		} else pending.push({ top: box.y0, bottom: box.y1, words: [word] });
	}
	const lines = pending
		.sort((a, b) => a.top - b.top)
		.map((l): OcrLine => {
			const ws = l.words.map((w) => w.word).sort((a, b) => a.x0 - b.x0);
			return { y: l.top, x: ws[0]!.x0, text: lineText(ws), words: ws };
		});
	return {
		widthPx: Math.round(widthPx),
		heightPx: Math.round(heightPx),
		meanConf: meanConfidence(lines),
		lines
	};
}

/** The pages as text, one line per line, for the per-bank statement parsers (`pdf_text` documents). */
export function textPages(doc: OcrDocument): string[] {
	return doc.pages.map((p) => p.lines.map((l) => lineText(l.words)).join('\n'));
}

/** Where each line of `textPages` starts: its first word's left edge, in page pixels (FN-16f/16h red team L1). */
export function textLayout(doc: OcrDocument): PageLayout[] {
	return doc.pages.map((p) => ({
		width: p.widthPx,
		lineX: p.lines.map((l) => l.words[0]?.x0 ?? null)
	}));
}
