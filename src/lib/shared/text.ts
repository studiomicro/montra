/**
 * Control (Cc), format (Cf: zero-width, bidi overrides, soft hyphen) and line/paragraph separators.
 * Removed from untrusted text before storage (checklist › Access and privacy › Untrusted text).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Untrusted single-line text made safe to store: capped to `max * 4` UTF-16 units before any work (so a huge
 * input costs nothing), invisible characters stripped, NFC-normalised, whitespace collapsed and trimmed, then
 * cut to `max` code points.
 */
export function cleanText(input: string, max: number): string {
	const capped = input.slice(0, max * 4);
	// Whitespace (tabs and newlines included) becomes one space first, so "a\tb" stays two words.
	const visible = capped
		.replace(/\s+/g, ' ')
		.replace(INVISIBLE, '')
		.normalize('NFC')
		.replace(/\s+/g, ' ')
		.trim();
	return Array.from(visible).slice(0, max).join('').trim();
}

/**
 * A name as SQLite's `lower()` compares it: only ASCII letters are folded. Find-or-create by name (FN-18) uses
 * it on both sides, so a JavaScript lookup and the SQL `not exists` agree on what "the same name" is.
 */
export function asciiLowerKey(name: string): string {
	return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Single characters that join digit groups (besides `.`, `,` and `/`): dashes, `_`, `*`, bullets, `~`, `+`, `|`. */
const JOINERS = '\\-*_\\u2010-\\u2015\\u2212\\u2022\\u00b7\\u30fb~+|';
/**
 * Digits (any Unicode decimal digit) joined by one or two spaces, a dot, a comma or one of JOINERS, by a JOINER or
 * slash between spaces, or by a slash between groups of 3+ digits (`4111*1111*1111*1111`, `4111–1111–1111–1111`,
 * `4111  1111  …`, `4111·1111·…`, `1234 - 5678 - 9012`, `4111 / 1111 / …`, `0812/3456/7890`; FN-19 forwarding red
 * team L3, fix-lows-services red team N1). A short group before or after a slash (`02/1234…`, a date) stays apart.
 */
const DIGIT_RUN = new RegExp(
	`\\p{Nd}+(?:(?:\\s{1,2}|[.,${JOINERS}]|\\s[${JOINERS}/]\\s|(?<=\\p{Nd}{3})\\/(?=\\p{Nd}{3}))\\p{Nd}+)*`,
	'gu'
);
/**
 * Joiners that split a run into pieces like a space does (kept in the output): a grouped amount next to one
 * (`Rp150.000*12`, an instalment) stays as printed, while card groups between them are still masked together.
 */
const PIECE_SPLIT = new RegExp(`(\\s|[${JOINERS.replace('\\-', '')}])`, 'u');
/** A date (`2026-10-08`, `08-10-2026`, `08.10.2026`, `08/10/2026`): kept as it is. */
const DATE_SHAPE =
	/^(?:\p{Nd}{4}[./-]\p{Nd}{1,2}[./-]\p{Nd}{1,2}|\p{Nd}{1,2}[./-]\p{Nd}{1,2}[./-]\p{Nd}{4})$/u;
/** A thousands-grouped amount with dots (`1.250.000`, `1.250.000,50`) or commas (`1,250,000.00`): kept. */
const GROUPED_AMOUNT =
	/^(?:\p{Nd}{1,3}(?:\.\p{Nd}{3})+(?:,\p{Nd}{1,2})?|\p{Nd}{1,3}(?:,\p{Nd}{3})+(?:\.\p{Nd}{1,2})?)$/u;
/**
 * An ungrouped amount with a 2-digit comma decimal (`1250,50`): kept only when it starts its run, and only below 8
 * digits in all unless `Rp`/`IDR` comes right before it (red team N1: `Rek 1234567890,12` is an account, not an amount).
 */
const BARE_DECIMAL = /^(\p{Nd}{1,13}),\p{Nd}{2}$/u;
const CURRENCY_BEFORE = /(?:\brp|\bidr)\.?\s?$/iu;
const MIN_MASKED_DIGITS = 8;

/** The pieces of one digit run (split at PIECE_SPLIT), dates and amounts kept, the rest masked as one number. */
function maskRun(run: string, currencyBefore: boolean): string {
	let out = '';
	let segment: string[] = [];
	const flush = () => {
		const text = segment.join('');
		const digits = text.match(/\p{Nd}/gu) ?? [];
		out +=
			digits.length >= MIN_MASKED_DIGITS
				? '\u2022\u2022\u2022\u2022' + digits.slice(-4).join('')
				: text;
		segment = [];
	};
	const bareAmount = (part: string) => {
		const whole = BARE_DECIMAL.exec(part)?.[1];
		return (
			whole !== undefined &&
			out === '' &&
			segment.length === 0 &&
			(currencyBefore || whole.length + 2 < MIN_MASKED_DIGITS)
		);
	};
	for (const part of run.split(PIECE_SPLIT)) {
		if (part === '') continue;
		if (PIECE_SPLIT.test(part) && part.length === 1) {
			if (segment.length > 0) segment.push(part);
			else out += part;
		} else if (DATE_SHAPE.test(part) || GROUPED_AMOUNT.test(part) || bareAmount(part)) {
			const trailing =
				segment.length > 0 && PIECE_SPLIT.test(segment.at(-1)!) ? segment.pop()! : '';
			flush();
			out += trailing + part;
		} else segment.push(part);
	}
	flush();
	return out;
}

/**
 * Account and card numbers reduced to their last 4 digits (CLAUDE.md masking rule), after NFKC normalisation
 * (fullwidth digits become ASCII): any sequence of decimal digits (any script) joined as DIGIT_RUN describes that
 * holds 8 or more digits becomes `\u2022\u2022\u2022\u2022` + its last 4 digits — except pieces shaped like a date
 * (`2026-10-08`, `08.10.2026`, `08/10/2026`) or an amount (`1.250.000`, `1,250,000.00`, `Rp 1250000,00`), which stay. A number split across separate fields is not joined (out of
 * scope). Used on imported references, payment methods, tags, recurrences, wallet names, file names and
 * forwarded mail text (FN-19), before storage and on export.
 */
export function maskAccountNumbers(text: string): string {
	return text
		.normalize('NFKC')
		.replace(DIGIT_RUN, (run: string, at: number, whole: string) =>
			maskRun(run, CURRENCY_BEFORE.test(whole.slice(Math.max(0, at - 6), at)))
		);
}
