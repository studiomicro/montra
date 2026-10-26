import { TANYA_BODY_MAX } from '../../shared/tanya.ts';
import { FIGURE_ID_PATTERN, type FigureBook } from './figures.ts';
import { TANYA_FIGURES_ONLY } from './messages.ts';

/**
 * The last check before an answer is shown (FN-22 criteria 9 and 10): the model writes every figure as
 * `[[f:ID]]`, and only ids the server returned during this question resolve. Prose that could show a number the
 * server did not produce is dropped: the page then shows the figure cards with TANYA_FIGURES_ONLY.
 *
 * The check is an allowlist, so it fails closed on characters nobody listed (red team S1, S2, S8):
 * 1. The text is NFKC-folded, then every invisible or combining character is removed (INVISIBLE). The page renders
 *    this normalised text, so what is checked is what is shown.
 * 2. Outside the placeholders, every character must be in ALLOWED: Latin letters, ASCII digits, space, newline and
 *    a fixed set of prose punctuation. Anything else (another script, a currency symbol, an unusual space or
 *    separator, a non-ASCII digit, an emoji) drops the prose.
 * 3. Every word that holds a digit must be a year, an ISO date, a time or at most three digits (DIGIT_WORD), and
 *    must not sit next to another number or a figure on the same line, across spaces and punctuation only.
 * 4. No currency or magnitude word, and no sign directly before a figure (S9).
 * 5. No letters standing in for digits (`l.OOO.OOO`, `[[f:ID]].OOO`, `1 OOO OOO`), and no figure re-signed or scaled
 *    by a word, brackets, a second glued figure or a multiplier (red team S11, S12; checked 2026-10-13).
 */

const PLACEHOLDER = new RegExp(`\\[\\[f:(${FIGURE_ID_PATTERN})\\]\\]`, 'g');
/** A resolved placeholder while the text is checked (private use, which INVISIBLE strips from model text). */
const MARK = '\uE000';
/** Removed after NFKC: invisible, format, control (the newline is kept), private use, unassigned and combining. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{M}\p{Zl}\p{Zp}]/gu;
/**
 * Latin letters (accented ones included, but not the digit-like `Ø`/`ø` or the `Þ`/`þ` that passes for a `p`; S11),
 * ASCII digits, space, newline, prose punctuation, a resolved figure.
 */
const ALLOWED = new RegExp(
	`^[A-Za-z\\u00C0-\\u00D6\\u00D9-\\u00DD\\u00DF-\\u00F6\\u00F9-\\u00FD\\u00FF-\\u017F0-9 \\n.,:;!?()'"/&*\\-\\u2018\\u2019\\u201C\\u201D\\u2013\\u2014\\u2022${MARK}]*$`,
	'u'
);
/** Belt and braces for step 2: a currency symbol or a digit that is not ASCII. */
const FOREIGN_DIGIT_OR_CURRENCY = /\p{Sc}|(?![0-9])\p{Nd}/u;
/**
 * A word (between spaces) that holds a digit, with opening and closing punctuation around it: an ISO date, a time
 * `HH:MM`, a year 19xx/20xx or at most three digits. `1,5`, `25rb`, `1.OOO`, `-25` and `2026an` do not match.
 */
const DIGIT_WORD =
	/^[("'\u2018\u201C]*(?:(?:19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:[01]?\d|2[0-3]):[0-5]\d|(?:19|20)\d\d|\d{1,3})[)"'\u2019\u201D.,:;!?]*$/;
/** A word of punctuation only, skipped when looking for the neighbour of a number. */
const PUNCTUATION_WORD = new RegExp(`^[^A-Za-z\\u00C0-\\u017F0-9${MARK}]+$`);
/**
 * Words that make the number before them an amount (`5 grand`, `900 won`, `3 k`, `20 persen`), FN-47's units
 * included (`500 sen`, `900 cents`, `500 RMB`, `900 NT`, `900 HK`). Whole words only: `sendiri`, `senin` pass.
 */
const AMOUNT_AFTER_NUMBER =
	/^(?:rb|rebu|ribu|k|jt|juta|m|mio|mn|bn|t|g|grand|won|perak|persen|percent|sen|cents?|rmb|ntd|nt|hk)\b/i;
/**
 * Currency names and codes (`Rp`, `R p`, `R-p`, `IDR`, `yen` …; `R M B` spelled out before a number, FN-47 red team
 * L4), amount abbreviations standing alone (`rb`, `jt`, `rbu`, `mil`; S11), number words that only appear in an amount (Indonesian
 * `se-` prefixes included: `sejuta`, `seratus`) and the Jakarta slang amounts (`goceng`, `ceban` …).
 */
const MONEY_WORD = new RegExp(
	[
		String.raw`\br[ .\-]?p\b`,
		String.raw`\b[a-z](?: [a-z]){2}\b(?= *[0-9\uE000])`,
		String.raw`\b(?:rb|rbu|jt|perak|rupiyah|mil|noceng)\b`,
		String.raw`\b(?:idr|usd|sgd|eur|myr|jpy|gbp|aud|cny|twd|hkd|inr|rmb|ntd|hk|renminbi|cents?|rupiahs?|dollars?|dolar|euros?|yen|yuan|ringgit|baht|pounds?|rupees?|lakhs?|crores?|pesos?|francs?|sterling|bucks|quid)\b`,
		// FN-47: `NT 900` (New Taiwan dollar). Only before a number or a figure, so other prose with `NT` stays.
		String.raw`\bnt\b(?= *[0-9\uE000])`,
		String.raw`(?:\b|\bse)(?:ribu|rebu|juta|ratus|puluh|miliar|milyar|triliun)[a-z]*`,
		String.raw`\b(?:hundreds?|thousands?|millions?|billions?|trillions?)\b`,
		String.raw`\b(?:cepek|cepe|gopek|seceng|goceng|gocap|ceban|noban|goban|cetiao)\b`
	].join('|'),
	'i'
);
/**
 * A sign right before a figure (`-[[f:ID]]`, `+ [[f:ID]]`, `a-[[f:ID]]`) turns income into spending; a dash between
 * two figures (`[[f:A]] – [[f:B]]`) is a range and stays.
 */
const SIGNED_FIGURE = new RegExp(`(?<!${MARK} *)[-+\\u2013\\u2014] *${MARK}`);
/**
 * A figure re-signed or scaled (S12): a sign word before it, two figures glued by nothing or spaces only
 * (`Rp 1.250.000−Rp 25.000` reads as a subtraction), or a multiplier after it. A figure in brackets
 * (`Indomaret ([[f:A]])`) and a hyphen range (`[[f:A]]-[[f:B]]`) stay: ordinary answers use them, and the figure
 * shown is still the server's own.
 */
const RESHAPED_FIGURE = new RegExp(
	[
		`\\b(?:minus|min|negatif|defisit) *${MARK}`,
		// "kurang [[f:A]] lagi" (a shortfall, still the positive server figure) is ordinary Indonesian and stays.
		`\\bkurang *${MARK}(?! *lagi\\b)`,
		`\\( *[-+\\u2013\\u2014] *\\) *${MARK}`,
		`${MARK}[.,]? *${MARK}`,
		`${MARK} *(?:x|kali|dikali)(?![A-Za-z])`
	].join('|'),
	'i'
);
/** Letters that pass for digits at a glance (S11): `O`, `D`, `l`, `I`, `S`, `B`, `Z`, `G` and their kin. */
const LOOKALIKE = '[0-9OoØøDQlIı|SsBZzG]';
/** A word that is a grouped amount spelled with lookalikes (`l.OOO.OOO`, `SOO.OOO`). */
const LOOKALIKE_AMOUNT = new RegExp(
	`^[("'\\u2018\\u201C]*${LOOKALIKE}{1,3}(?:[.,]${LOOKALIKE}{3})+[)"'\\u2019\\u201D.,:;!?]*$`
);
/**
 * A word of lookalikes only, 3+ long, with at least two zero-like letters (`OOO`, `SOO`, `lOOOOOO`): read as the
 * digits it imitates before the number checks (red team N2), so `l OOO OOO` is two numbers side by side.
 */
const LOOKALIKE_RUN = new RegExp(`^(${LOOKALIKE}{3,})([)"'\\u2019\\u201D.,:;!?]*)$`);
function asDigits(word: string): string {
	const m = LOOKALIKE_RUN.exec(word);
	if (!m || (m[1]!.match(/[0OoØøDQ]/g) ?? []).length < 2) return word;
	return '0'.repeat(m[1]!.length) + m[2];
}
/**
 * The text the money-word test reads (red team N2): marks folded away (`Ŗp` is `Rp`), lower case, and runs of single
 * letters joined across spaces, dots and dashes (`R–p`, `I.D.R`, `U.S.D.`, `r b`, `j t` read as `rp`, `idr`, `usd`,
 * `rb`, `jt`).
 */
function moneyFold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/\b[a-z](?:[ .\-\u2013\u2014]{1,2}[a-z]\b)+/g, (run) => run.replace(/[^a-z]/g, ''));
}
/** Three zero-like letters (`OOO`): after a number or a figure they multiply it by 1,000. */
const ZERO_GROUP = /^[0OoØøDQ]{3}[)"'\u2019\u201D.,:;!?]*$/;
const ZERO_GROUP_AFTER_FIGURE = new RegExp(`${MARK}[.,]? *[0OoØøDQ]{3}(?![A-Za-z0-9])`);

export type GuardResult = { kind: 'prose'; text: string } | { kind: 'figures_only'; text: string };

/** The model text as the page may show it: NFKC-folded, invisible and combining characters gone, tabs as spaces. */
function normaliseModelText(modelText: string): string {
	return modelText
		.slice(0, TANYA_BODY_MAX * 2)
		.replace(/\r\n?/g, '\n')
		.replace(/\t/g, ' ')
		.normalize('NFKC')
		.replace(INVISIBLE, (c) => (c === '\n' ? c : ''));
}

/** One line of checked text: every number is a plain small number, date, time or year standing alone. */
function lineHasLooseNumber(line: string): boolean {
	const words = line
		.split(' ')
		.filter((w) => w !== '')
		.map(asDigits);
	const neighbour = (from: number, step: number) => {
		for (let i = from + step; i >= 0 && i < words.length; i += step) {
			const word = words[i] ?? '';
			if (!PUNCTUATION_WORD.test(word)) return word;
		}
		return '';
	};
	for (const [i, word] of words.entries()) {
		if (!/[0-9]/.test(word)) continue;
		if (!DIGIT_WORD.test(word)) return true;
		const before = neighbour(i, -1);
		const after = neighbour(i, 1);
		if (/[0-9]/.test(before) || before.includes(MARK)) return true;
		if (/[0-9]/.test(after) || after.includes(MARK)) return true;
		if (AMOUNT_AFTER_NUMBER.test(after) || ZERO_GROUP.test(after)) return true;
	}
	return words.some((word) => LOOKALIKE_AMOUNT.test(word));
}

function unverified(checked: string): boolean {
	if (!ALLOWED.test(checked) || FOREIGN_DIGIT_OR_CURRENCY.test(checked)) return true;
	if (MONEY_WORD.test(moneyFold(checked))) return true;
	return checked
		.split('\n')
		.some(
			(line) =>
				SIGNED_FIGURE.test(line) ||
				RESHAPED_FIGURE.test(line) ||
				ZERO_GROUP_AFTER_FIGURE.test(line) ||
				lineHasLooseNumber(line)
		);
}

export function guardAnswer(modelText: string, book: FigureBook): GuardResult {
	const text = normaliseModelText(modelText);
	let unknown = false;
	let words = false;
	const checked = text.replace(PLACEHOLDER, (_, id: string) => {
		if (!book.get(id)) unknown = true;
		return MARK;
	});
	if (/[^\s\uE000]/u.test(checked)) words = true;
	if (unknown || !words || unverified(checked))
		return { kind: 'figures_only', text: TANYA_FIGURES_ONLY };
	const filled = text
		.replace(PLACEHOLDER, (_, id: string) => book.get(id)?.formatted ?? '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	const capped = Array.from(filled).slice(0, TANYA_BODY_MAX).join('').trim();
	return capped
		? { kind: 'prose', text: capped }
		: { kind: 'figures_only', text: TANYA_FIGURES_ONLY };
}
