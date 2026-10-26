import {
	lineText,
	meanConfidence,
	type OcrDocument,
	type OcrLine,
	type OcrPage
} from '#lib/shared/ocr/lines';

/**
 * Fictional OCR documents for the FN-16g tests: each text line becomes one OCR line whose words sit at their
 * character positions (12 px per character), so the gaps are kept. `conf` gives every word's confidence, or
 * decides it per word.
 */
export type ConfOf = number | ((word: string, line: number) => number);

function ocrLine(text: string, index: number, conf: ConfOf = 96): OcrLine {
	const words = [...text.matchAll(/\S+/g)].map((m) => ({
		t: m[0],
		c: typeof conf === 'number' ? conf : conf(m[0], index),
		x0: m.index * 12,
		x1: (m.index + m[0].length) * 12
	}));
	return { y: index * 30, x: words[0]?.x0 ?? 0, text: lineText(words), words };
}

function ocrPage(lines: readonly string[], conf: ConfOf = 96): OcrPage {
	const built = lines.filter((l) => l.trim() !== '').map((l, i) => ocrLine(l, i, conf));
	return { widthPx: 1080, heightPx: 2400, meanConf: meanConfidence(built), lines: built };
}

/** Pages of text (lines joined by `\n`, as a PDF text layer gives them) as an OCR document. */
export function ocrDocFromText(pages: readonly string[], conf: ConfOf = 96): OcrDocument {
	return { pages: pages.map((p) => ocrPage(p.split('\n'), conf)) };
}

export const ocrDoc = (pages: readonly (readonly string[])[], conf: ConfOf = 96): OcrDocument => ({
	pages: pages.map((p) => ocrPage(p, conf))
});
