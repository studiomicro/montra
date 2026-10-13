import { currencyExponent } from './money-format.ts';
import { cleanText } from './text.ts';

/**
 * The one shared money parser (FN-14a): typed, spoken and statement amounts → integer IDR minor units.
 * Pure and deterministic — no clock, no randomness, no locale state — so device and Workers agree byte for byte.
 * Unreadable or ambiguous input gives `null` / `[]`, never a guess ("money is never invented"), and never throws.
 */

export type ParsedAmount = { minor: number; direction?: 'debit' | 'credit' };
export type MoneyMention = ParsedAmount & { start: number; end: number; raw: string };

/**
 * Largest single amount in minor units (Rp 100.000.000.000 for a two-decimal currency). With at most
 * MAX_TRANSACTIONS_PER_SPACE rows a space's SQL sums stay far inside SQLite's 64-bit integers; a sum past
 * 2^53 is shown as "too large", never a failed page (server `aggregate.ts`).
 */
export const MAX_AMOUNT_MINOR = 10_000_000_000_000;

/** Untrusted text is capped to this many code points after cleaning (voice line, statement row, CSV cell). */
export const MONEY_TEXT_MAX = 2000;

/** Rupiah value of the seven fixed slang words. */
export const IDR_SLANG: Readonly<Record<string, number>> = Object.freeze({
	cepek: 100,
	gopek: 500,
	seceng: 1_000,
	noceng: 2_000,
	goceng: 5_000,
	ceban: 10_000,
	goban: 50_000
});

const DIGIT_WORDS: Readonly<Record<string, number>> = {
	satu: 1,
	dua: 2,
	tiga: 3,
	empat: 4,
	lima: 5,
	enam: 6,
	tujuh: 7,
	delapan: 8,
	sembilan: 9
};

/** Words allowed as a slang multiplier (`dua ceban`). */
const MULTIPLIER_WORDS: Readonly<Record<string, number>> = {
	...DIGIT_WORDS,
	sepuluh: 10,
	sebelas: 11
};

const UNIT_RUPIAH: Readonly<Record<string, bigint>> = {
	k: 1_000n,
	rb: 1_000n,
	ribu: 1_000n,
	jt: 1_000_000n,
	juta: 1_000_000n
};

const IDR_SCALE = 10n ** BigInt(currencyExponent('IDR'));
const MAX_DIGIT_RUN = 30;
/** Longest well-formed spoken amount ("sembilan ratus sembilan puluh sembilan juta … sembilan") is 18 words. */
const MAX_NUMBER_WORDS = 18;

function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | null {
	return Object.hasOwn(table, key) ? (table[key] as T) : null;
}

const DIGITS = Object.keys(DIGIT_WORDS).join('|');
const MULTIPLIERS = Object.keys(MULTIPLIER_WORDS).join('|');
const SLANG = Object.keys(IDR_SLANG).join('|');
/** Vocabulary of the spoken-number grammar (`parseNumberWords`). */
const GRAMMAR_WORDS = `${DIGITS}|sepuluh|sebelas|seratus|seribu|sejuta|puluh|belas|ratus|ribu|rb|juta|jt`;
/** Words that continue a spoken number we do not read; an amount glued to one is never read partially. */
const NUMBER_WORDS = `${GRAMMAR_WORDS}|miliar|koma|setengah|nol`;
const START = '(?<![\\p{L}\\p{N}])';
const END = '(?![\\p{L}\\p{N}])';
const NUMBER_WORD = `(?:${GRAMMAR_WORDS})${END}`;

/**
 * The one tokenizer behind both exports, run on ASCII-lower-cased text without the `i` flag (so Unicode case
 * folding such as `ſ` → `s` can never match a dictionary word). Alternatives: slang, spoken number, numeric.
 * Signs must touch the figure or currency (`-Rp 25.000`, `Rp -25.000`); a spaced dash is punctuation.
 */
const TOKEN = new RegExp(
	[
		`${START}(?:(?<slangMulN>\\d{1,2})\\s*|(?<slangMulW>${MULTIPLIERS})\\s+)?(?<slang>${SLANG})${END}`,
		`${START}(?<words>${NUMBER_WORD}(?:\\s+${NUMBER_WORD})*)`,
		`${START}(?:(?<dirPre>db|cr)(?!\\p{L})\\s*)?(?<open>\\(\\s*)?(?<sign>[-−+])?(?<cur>(?:rp\\.?|idr)\\s*)?` +
			`(?<sign2>[-−])?(?<num>\\d+(?:[.,]\\d+)*)(?:[.,]-)?` +
			`(?:\\s*(?<unit>ribu|rb|juta|jt|k)${END}|(?=(?:db|cr)${END})|${END})` +
			`(?<close>\\s*\\))?(?:\\s*(?<dir>db|cr)${END})?`
	].join('|'),
	'gu'
);
const AMBIGUOUS_BEFORE = new RegExp(`(?:${START}(?:${NUMBER_WORDS})|\\d)\\s+$`, 'u');
const AMBIGUOUS_AFTER_WORD = new RegExp(`^\\s+(?:${NUMBER_WORDS})${END}`, 'u');
const AMBIGUOUS_AFTER_DIGIT = /^\s+\d/u;
const TRAILS_TO_END = /^[\s\p{P}]*$/u;

type Token = MoneyMention & {
	/** Carries a currency, unit, slang, spoken scale, DB/CR or thousands grouping: safe to report in free text. */
	marked: boolean;
};

type Figure = { units: bigint; scale: bigint; grouped: boolean };

/**
 * Digits with `.`/`,` separators → value as `units / scale`. The last separator followed by exactly 1–2 digits
 * is the decimal mark; every other separator groups thousands (first group 1–3 digits not starting with 0, then
 * exactly 3). A separator used both ways (`1.250.00`) or a malformed group is rejected, never guessed.
 */
function readFigure(run: string): Figure | null {
	if (run.length > MAX_DIGIT_RUN) return null;
	const parts = run.split(/[.,]/);
	const seps = run.replace(/\d/g, '');
	let intParts = parts;
	let frac = '';
	const last = parts[parts.length - 1] as string;
	if (seps.length > 0 && last.length <= 2) {
		const decimalSep = seps[seps.length - 1] as string;
		if (seps.slice(0, -1).includes(decimalSep)) return null;
		frac = last;
		intParts = parts.slice(0, -1);
	}
	const groupSeps = seps.slice(0, intParts.length - 1);
	if (new Set(groupSeps).size > 1) return null;
	if (intParts.length > 1) {
		const [head, ...rest] = intParts as [string, ...string[]];
		if (head.length > 3 || head.startsWith('0') || rest.some((g) => g.length !== 3)) return null;
	}
	const scale = 10n ** BigInt(frac.length);
	return { units: BigInt(intParts.join('') + frac), scale, grouped: intParts.length > 1 };
}

/** `scale` is at most 100 = IDR_SCALE, so the division is always exact. */
function toMinor(units: bigint, scale: bigint, rupiahPerUnit: bigint): number | null {
	const minor = (units * rupiahPerUnit * IDR_SCALE) / scale;
	if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	return Number(minor);
}

/**
 * Spoken Indonesian number → rupiah, bounded grammar (Owner decision B, changed 2026-10-08):
 *   amount  = [sejuta | group juta] [seribu | group ribu] [group], with at least one of juta/ribu
 *   group   = [seratus | D ratus] [sepuluh | sebelas | D belas | D puluh [D] | D]   (1–999; D = satu…sembilan,
 *             and D ≥ 2 before ratus/belas/puluh)
 * One left-to-right pass; anything else (out-of-order scales, `satu ratus`, a lone group) → null.
 */
function parseNumberWords(words: readonly string[]): bigint | null {
	if (words.length > MAX_NUMBER_WORDS) return null;
	let i = 0;
	const digit = (at: number, min: number): number | null => {
		const d = lookup(DIGIT_WORDS, words[at] ?? '');
		return d !== null && d >= min ? d : null;
	};
	const group = (): bigint | null => {
		let value = 0;
		let read = false;
		if (words[i] === 'seratus') {
			value = 100;
			i += 1;
			read = true;
		} else if (digit(i, 2) !== null && words[i + 1] === 'ratus') {
			value = (digit(i, 2) as number) * 100;
			i += 2;
			read = true;
		}
		const d = digit(i, 1);
		const nextWord = words[i + 1];
		if (words[i] === 'sepuluh' || words[i] === 'sebelas') {
			value += words[i] === 'sepuluh' ? 10 : 11;
			i += 1;
			read = true;
		} else if (d !== null && d >= 2 && nextWord === 'belas') {
			value += 10 + d;
			i += 2;
			read = true;
		} else if (d !== null && d >= 2 && nextWord === 'puluh') {
			value += d * 10;
			i += 2;
			read = true;
			const ones = digit(i, 1);
			if (ones !== null && !['ratus', 'belas', 'puluh'].includes(words[i + 1] ?? '')) {
				value += ones;
				i += 1;
			}
		} else if (d !== null && !['ratus', 'belas', 'puluh'].includes(nextWord ?? '')) {
			value += d;
			i += 1;
			read = true;
		}
		return read ? BigInt(value) : null;
	};
	const scaled = (single: string, names: readonly string[], size: bigint): bigint | null => {
		if (words[i] === single) {
			i += 1;
			return size;
		}
		const saved = i;
		const g = group();
		if (g !== null && names.includes(words[i] ?? '')) {
			i += 1;
			return g * size;
		}
		i = saved;
		return null;
	};
	const millions = scaled('sejuta', ['juta', 'jt'], 1_000_000n);
	const thousands = scaled('seribu', ['ribu', 'rb'], 1_000n);
	if (millions === null && thousands === null) return null;
	const rest = group();
	if (i !== words.length) return null;
	return (millions ?? 0n) + (thousands ?? 0n) + (rest ?? 0n);
}

/**
 * `whole` is true when the token must be the entire input (an amount cell): only there does `(25.000)` mean an
 * accounting negative. Inside free text brackets are punctuation around a positive amount.
 */
function readToken(m: RegExpExecArray, whole: boolean): Token | null {
	const g = m.groups ?? {};
	let start = m.index;
	let end = m.index + m[0].length;

	if (g.slang !== undefined) {
		const perSlang = lookup(IDR_SLANG, g.slang);
		const mul =
			g.slangMulN !== undefined
				? Number(g.slangMulN)
				: g.slangMulW !== undefined
					? lookup(MULTIPLIER_WORDS, g.slangMulW)
					: 1;
		if (perSlang === null || mul === null || mul === 0) return null;
		const minor = toMinor(BigInt(mul), 1n, BigInt(perSlang));
		return minor === null ? null : { minor, start, end, raw: '', marked: true };
	}
	if (g.words !== undefined) {
		const rupiah = parseNumberWords(g.words.split(/\s+/));
		const minor = rupiah === null ? null : toMinor(rupiah, 1n, 1n);
		return minor === null ? null : { minor, start, end, raw: '', marked: true };
	}

	const figure = readFigure(g.num ?? '');
	if (!figure) return null;
	const hasOpen = g.open !== undefined;
	const hasClose = g.close !== undefined;
	const parenthesised = whole && hasOpen && hasClose;
	const dir = g.dirPre ?? g.dir;
	if (g.dirPre !== undefined && g.dir !== undefined) return null;
	// In free text a leading DB/CR before a bare number is usually a code ("Kode DB 123456"), not an amount.
	if (
		g.dirPre !== undefined &&
		!whole &&
		g.cur === undefined &&
		g.unit === undefined &&
		!figure.grouped
	) {
		return null;
	}
	if (hasOpen && !parenthesised) {
		// A bracket between a leading DB/CR and the figure is malformed.
		if (g.dirPre !== undefined) return null;
		start += (g.open as string).length;
	}
	if (hasClose && !parenthesised) {
		// A bracket between the figure and its DB/CR suffix is malformed.
		if (g.dir !== undefined) return null;
		end -= (g.close as string).length;
	}

	const minus = (g.sign !== undefined && g.sign !== '+') || g.sign2 !== undefined;
	const signs =
		(g.sign !== undefined ? 1 : 0) + (g.sign2 !== undefined ? 1 : 0) + (parenthesised ? 1 : 0);
	// Two sign notations, or a sign plus DB/CR, contradict each other.
	if (signs > 1 || (signs > 0 && dir !== undefined)) return null;

	const perUnit = g.unit !== undefined ? lookup(UNIT_RUPIAH, g.unit) : 1n;
	if (perUnit === null) return null;
	const magnitude = toMinor(figure.units, figure.scale, perUnit);
	if (magnitude === null) return null;
	const minor = (minus || parenthesised) && magnitude !== 0 ? -magnitude : magnitude;
	const token: Token = {
		minor,
		start,
		end,
		raw: '',
		marked: g.cur !== undefined || g.unit !== undefined || dir !== undefined || figure.grouped
	};
	if (dir !== undefined) token.direction = dir === 'db' ? 'debit' : 'credit';
	return token;
}

function isAmbiguous(lower: string, token: Token): boolean {
	const before = lower.slice(Math.max(0, token.start - 16), token.start);
	const after = lower.slice(token.end, token.end + 16);
	if (AMBIGUOUS_BEFORE.test(before) || AMBIGUOUS_AFTER_WORD.test(after)) return true;
	// "Rp 1 250 000" must not read as Rp 1; a DB/CR suffix closes the amount, so a following column is fine.
	return token.direction === undefined && AMBIGUOUS_AFTER_DIGIT.test(after);
}

/** ASCII-only lower case: same length and offsets as the input, no Unicode case folding. */
function asciiLower(text: string): string {
	return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

type Prepared = { clean: string; truncated: boolean };

/**
 * Cleans untrusted text (invisible/bidi characters stripped, length capped before `normalize()`). When the cap
 * cut the text, the partial trailing word is dropped so a figure is never shortened silently.
 */
function prepare(text: string): Prepared {
	// Two extra code points: cleanText trims, so a single extra one could be a space that disappears.
	const longer = Array.from(cleanText(text, MONEY_TEXT_MAX + 2));
	// cleanText also cuts the raw input at (max * 4) UTF-16 units before stripping invisible characters, so
	// zero-width padding can hide a cut that the cleaned length alone does not show.
	const rawCut = text.length > (MONEY_TEXT_MAX + 2) * 4;
	if (!rawCut && longer.length <= MONEY_TEXT_MAX)
		return { clean: longer.join(''), truncated: false };
	const capped = longer.slice(0, MONEY_TEXT_MAX).join('');
	const cut = capped.lastIndexOf(' ');
	return { clean: (cut < 0 ? '' : capped.slice(0, cut)).trimEnd(), truncated: true };
}

function tokenize({ clean, truncated }: Prepared, whole: boolean): Token[] {
	const lower = asciiLower(clean);
	const tokens: Token[] = [];
	for (const m of lower.matchAll(TOKEN)) {
		const token = readToken(m, whole);
		if (!token || isAmbiguous(lower, token)) continue;
		// An amount reaching the cut may have continued past it (more digits, a unit, a DB/CR suffix).
		if (truncated && TRAILS_TO_END.test(lower.slice(token.end))) continue;
		token.raw = clean.slice(token.start, token.end);
		tokens.push(token);
	}
	return tokens;
}

function publicShape(token: Token): ParsedAmount {
	const out: ParsedAmount = { minor: token.minor };
	if (token.direction) out.direction = token.direction;
	return out;
}

/** Untrusted text as the parser sees it; `findMoneyMentions` offsets index this string. */
export function cleanMoneyText(text: string): string {
	return prepare(text).clean;
}

/** One amount occupying the whole input (`Rp 1.250.000`, `25rb`, `2 ceban`, `(25.000)`, `50.000 DB`), or null. */
export function parseMoneyAmount(text: string): ParsedAmount | null {
	const prepared = prepare(text);
	if (prepared.truncated) return null;
	const tokens = tokenize(prepared, true);
	const only = tokens[0];
	if (tokens.length !== 1 || !only || only.start !== 0 || only.end !== prepared.clean.length) {
		return null;
	}
	return publicShape(only);
}

/**
 * Every amount mention in free text, in reading order. Offsets index `cleanMoneyText(text)` (identical to the
 * input when it is already clean). Brackets around an amount here are punctuation, not a negative. A bare
 * number without a currency, unit, slang word, spoken scale, DB/CR or thousands grouping (a year, a quantity,
 * a phone number) is not a mention.
 */
export function findMoneyMentions(text: string): MoneyMention[] {
	return tokenize(prepare(text), false)
		.filter((t) => t.marked)
		.map((t) => ({ ...publicShape(t), start: t.start, end: t.end, raw: t.raw }));
}
