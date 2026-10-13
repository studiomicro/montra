import type { Locale } from '../../shared/i18n.ts';
import { formatMoney } from '../../shared/money-format.ts';

/**
 * The figures of one question (FN-22 criterion 9): every amount or percent a tool returns is entered here with a
 * short id and its server-formatted text (the shared formatter: `Rp 1.250.000`, `−Rp 25.000` with U+2212). The
 * model sees `{ id, label, value }` and must write a figure only as `[[f:ID]]`; answer-guard.ts puts the
 * formatted text back. Ids are random per question (FIGURE_ID_LENGTH lowercase letters and digits), so an id from
 * an older answer, or one stored text tells the model to use, fails as unknown instead of naming another figure.
 */
export interface Figure {
	id: string;
	label: string;
	formatted: string;
}

const FIGURE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const FIGURE_ID_LENGTH = 8;
/** What the answer guard reads as an id inside `[[f:…]]`. */
export const FIGURE_ID_PATTERN = '[a-z0-9]{1,16}';

function randomFigureId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(FIGURE_ID_LENGTH));
	return Array.from(bytes, (b) => FIGURE_ID_ALPHABET[b % FIGURE_ID_ALPHABET.length]).join('');
}

/** Most figures one question can hold (8 tools × a bounded list each, far below). */
const MAX_FIGURES = 400;

export class FigureBook {
	readonly #figures = new Map<string, Figure>();
	readonly #locale: Locale;

	constructor(locale: Locale) {
		this.#locale = locale;
	}

	#add(label: string, formatted: string): Figure | null {
		if (this.#figures.size >= MAX_FIGURES) return null;
		let id = randomFigureId();
		while (this.#figures.has(id)) id = randomFigureId();
		const figure = { id, label, formatted };
		this.#figures.set(figure.id, figure);
		return figure;
	}

	/** An amount in integer minor units; null (never a rounded figure) when it is too large to show. */
	money(label: string, minor: number | null, currency: string): Figure | null {
		if (minor === null) return null;
		return this.#add(label, formatMoney(minor, currency, 'auto', this.#locale));
	}

	/**
	 * A count (transactions, categories) as a locale-grouped integer (`1.234`, English `1,234`): the guard rejects a
	 * raw number of four or more digits, so a count the model may cite is a figure too (FN-23).
	 */
	count(label: string, n: number): Figure | null {
		if (!Number.isSafeInteger(n) || n < 0) return null;
		const grouped = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, this.#locale === 'en' ? ',' : '.');
		return this.#add(label, grouped);
	}

	/** A whole percent computed by the server (`floorPercent`); null stays null. */
	percent(label: string, value: number | null): Figure | null {
		if (value === null) return null;
		return this.#add(label, `${value}%`);
	}

	get(id: string): Figure | undefined {
		return this.#figures.get(id);
	}

	get size(): number {
		return this.#figures.size;
	}
}

/** A figure as the model receives it: its id and the formatted text, never the raw minor units. */
export const forModel = (f: Figure | null) =>
	f ? { figure_id: f.id, label: f.label, value: f.formatted } : null;
