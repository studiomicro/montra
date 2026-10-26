import { isDateString } from '../dates.ts';
import { parseMoneyAmount } from '../money-parse.ts';
import type { MappedRow, StatementDocument } from './types.ts';

/**
 * Text helpers both OCBC statement layouts share (FN-16f Laporan Konsolidasi, FN-16h Rekening Koran): the amount
 * grammar, the page-to-lines split, printed dates with a month name, and the running-balance self-check.
 */

export const AMOUNT = String.raw`\d{1,3}(?:,\d{3})*\.\d{2}`;
/** A row's amount line: an optional description tail, then debet, kredit and the running balance. */
export const ROW_AMOUNT = new RegExp(
	String.raw`^(?:(.*\S)\s+)?(${AMOUNT}) (${AMOUNT}) (${AMOUNT})$`
);
export const TRAILING_AMOUNT = new RegExp(String.raw`(?:^|\s)${AMOUNT}$`);
/** Most sections one file may hold; past it the file is refused (bounded work). */
export const OCBC_MAX_SECTIONS = 20;

const MONTHS: Readonly<Record<string, number>> = {
	jan: 1,
	january: 1,
	januari: 1,
	feb: 2,
	february: 2,
	februari: 2,
	mar: 3,
	march: 3,
	maret: 3,
	apr: 4,
	april: 4,
	may: 5,
	mei: 5,
	jun: 6,
	june: 6,
	juni: 6,
	jul: 7,
	july: 7,
	juli: 7,
	aug: 8,
	agu: 8,
	agt: 8,
	august: 8,
	agustus: 8,
	sep: 9,
	september: 9,
	oct: 10,
	okt: 10,
	october: 10,
	oktober: 10,
	nov: 11,
	november: 11,
	dec: 12,
	des: 12,
	december: 12,
	desember: 12
};

/** A page's text as trimmed, single-spaced, non-empty lines. */
export const linesOf = (page: string) =>
	page
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter((l) => l !== '');

/**
 * How far right of the leftmost row start (as a share of the page width) a line may begin and still start a row.
 * A row's date sits in the table's first column; description and note text, which other people write, sits in a
 * column further right (FN-16f/16h red team L1).
 */
const ROW_START_TOLERANCE = 0.02;

/** A document's pages as `linesOf` lines, and which of those lines may start a row (`canStart(page, line)`). */
export interface PositionedPages {
	pages: string[][];
	canStart: (page: number, line: number) => boolean;
}

/**
 * The pages as `linesOf` lines plus a row-start gate from the reader's layout: a line that reads like a row start
 * (`rowStart`) only starts a row when it begins in the column where the file's row dates begin — within
 * ROW_START_TOLERANCE of the page width of the leftmost such line in the whole file, positions taken as shares
 * of each page's own width. A row start further right is
 * description text imitating one and stays part of the open row. Without a layout (or one that does not match
 * the text) every line may start a row, as before.
 */
export function positionedPages(doc: StatementDocument, rowStart: RegExp): PositionedPages {
	if (doc.format !== 'pdf_text') return { pages: [], canStart: () => true };
	const pages: string[][] = [];
	const xs: (number | null)[][] = [];
	doc.pages.forEach((page, p) => {
		const raw = page.split('\n');
		const layout = doc.layout?.[p];
		const aligned = layout !== undefined && layout.lineX.length === raw.length;
		const lines: string[] = [];
		const at: (number | null)[] = [];
		raw.forEach((line, i) => {
			const text = line.replace(/\s+/g, ' ').trim();
			if (text === '') return;
			lines.push(text);
			at.push(aligned ? (layout.lineX[i] ?? null) : null);
		});
		pages.push(lines);
		xs.push(at);
	});
	// Every x as a share of its own page's width (red team cycle 2 L3): OCR images of one statement may come at
	// different resolutions, so pixel positions of two pages are not comparable, their shares are.
	const share = (page: number, line: number): number | null => {
		const x = xs[page]?.[line];
		const width = doc.layout?.[page]?.width;
		return x === null || x === undefined || !width ? null : x / width;
	};
	let leftmost = Infinity;
	pages.forEach((lines, p) =>
		lines.forEach((line, i) => {
			const at = share(p, i);
			if (at !== null && rowStart.test(line)) leftmost = Math.min(leftmost, at);
		})
	);
	return {
		pages,
		canStart(page, line) {
			const at = share(page, line);
			if (at === null || !Number.isFinite(leftmost)) return true;
			return at - leftmost <= ROW_START_TOLERANCE;
		}
	};
}

export const amountOf = (text: string) => parseMoneyAmount(text)?.minor ?? null;

/** `05-Jun-2026` or `5 June 2026` → `2026-06-05`, or null. */
export function dateOf(printed: string): string | null {
	const m = /^(\d{1,2})[- ]([A-Za-z]+)[- ](\d{4})$/.exec(printed);
	const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
	if (!m || !month) return null;
	const date = `${m[3]}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
	return isDateString(date) ? date : null;
}

export function only<T>(values: Iterable<T>): T | null {
	const set = new Set(values);
	return set.size === 1 ? [...set][0]! : null;
}

export interface ReadRow {
	row: MappedRow;
	/** Printed running balance; null when the row is unreadable. */
	balance: number | null;
}

export interface Period {
	from: string;
	to: string;
}

/** The section checks out against itself (every printed running balance, then the closing); any doubt is false. */
export function consistent(
	read: readonly ReadRow[],
	opening: number | null,
	closing: number | null
) {
	if (opening === null || closing === null) return false;
	let running = opening;
	for (const r of read) {
		if (!r.row.ok) return false;
		running += r.row.value.type === 'income' ? r.row.value.amountMinor : -r.row.value.amountMinor;
		if (!Number.isSafeInteger(running) || r.balance !== running) return false;
	}
	return running === closing;
}
