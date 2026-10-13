import { cleanText } from '../text.ts';
import { TITLE_MAX_LENGTH } from '../transactions.ts';

/**
 * FN-20: a raw payment descriptor ("QRIS*KOPI KENANGAN JKT 0812 3456 7890") made into a merchant name ("Kopi
 * Kenangan") and a normalised match key ("kopi kenangan") that rules, history and the AI cache are keyed by.
 * Pure and shared: the Worker and the browser clean the same way. The descriptor is untrusted text: it is cut
 * before any work, invisible characters go (`cleanText`), and the result holds only letters, digits, `&` and
 * `'` joined by single spaces, so it can never carry HTML. Digit runs (phone numbers, card tails, terminal ids)
 * never reach the name or the key.
 */

/** Longest match key kept (code points). */
export const MATCH_KEY_MAX_LENGTH = 60;
/** Longest descriptor read (code points); the rest is ignored. */
const DESCRIPTOR_MAX_LENGTH = 300;

export interface CleanedDescriptor {
	/** Title Case display name, at most TITLE_MAX_LENGTH code points; '' when nothing is left. */
	name: string;
	/** Lower-case letters and digits, single spaces, at most MATCH_KEY_MAX_LENGTH; '' when nothing is left. */
	key: string;
}

/** Payment-channel words a descriptor starts with (a sequence of tokens each), stripped from the front. */
const PREFIXES: readonly (readonly string[])[] = [
	['qris'],
	['trf'],
	['trsf'],
	['tarikan'],
	['e', 'banking'],
	['ebanking'],
	['m', 'banking'],
	['bi', 'fast'],
	['bifast'],
	['debit', 'domestik'],
	['debit'],
	['kartu', 'debit'],
	['pos'],
	['edc'],
	['purchase'],
	['payment'],
	['pembayaran'],
	['gopay'],
	['ovo'],
	['dana'],
	['shopeepay'],
	['linkaja'],
	['db'],
	['cr'],
	['kr']
];

/** City codes and debit/credit markers that trail a descriptor ("INDOMARET JKT", "… DB"). */
const TRAILING = new Set([
	'jkt',
	'jak',
	'bdg',
	'sby',
	'tng',
	'tgr',
	'dpk',
	'bks',
	'bgr',
	'mdn',
	'smg',
	'jog',
	'yog',
	'dps',
	'mks',
	'plg',
	'idn',
	'id',
	'ina',
	'db',
	'cr',
	'kr'
]);

const DIGIT = /\p{Nd}/gu;
const digitCount = (s: string) => s.match(DIGIT)?.length ?? 0;

/** A token that is an id, not a name: only digits, or three or more digits in it (`xxxx1234`, `WS95031`). */
const isIdToken = (t: string) => {
	const digits = digitCount(t);
	return digits === Array.from(t).length || digits >= 3;
};

function startsWith(tokens: readonly string[], prefix: readonly string[]): boolean {
	return prefix.every((p, i) => tokens[i]?.toLowerCase() === p);
}

/** Leading payment-channel words removed; when they are all there is, the last of them stays as the name. */
function stripPrefixes(tokens: string[]): string[] {
	let rest = tokens;
	for (;;) {
		const hit = PREFIXES.find((p) => startsWith(rest, p));
		if (!hit) return rest;
		if (rest.length === hit.length) return rest.slice(-1);
		rest = rest.slice(hit.length);
	}
}

function stripTrailing(tokens: string[]): string[] {
	let end = tokens.length;
	while (end > 1 && TRAILING.has(tokens[end - 1]!.toLowerCase())) end--;
	return tokens.slice(0, end);
}

const titleCase = (t: string) => {
	const [first = '', ...rest] = Array.from(t.toLowerCase());
	return first.toUpperCase() + rest.join('');
};

/** The match key of an already cleaned name (or any text): lower-case letters and digits, single spaces. */
export function matchKeyOf(text: string): string {
	const key = text
		.slice(0, MATCH_KEY_MAX_LENGTH * 8)
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w !== '')
		.join(' ');
	return Array.from(key).slice(0, MATCH_KEY_MAX_LENGTH).join('').trim();
}

export function cleanDescriptor(raw: string): CleanedDescriptor {
	if (typeof raw !== 'string') return { name: '', key: '' };
	const text = cleanText(raw, DESCRIPTOR_MAX_LENGTH).normalize('NFKC');
	// A slash-joined chunk with 3+ digits is a reference (`1234/FTSCY/WS95031`): dropped whole.
	const chunks = text
		.split(' ')
		.filter((chunk) => !(chunk.includes('/') && digitCount(chunk) >= 3));
	const tokens = chunks
		.join(' ')
		.split(/[^\p{L}\p{N}&']+/u)
		.map((t) => t.replace(/^['&]+|['&]+$/g, ''))
		.filter((t) => t !== '' && !isIdToken(t));
	const kept = stripTrailing(stripPrefixes(tokens));
	const name = Array.from(kept.map(titleCase).join(' ')).slice(0, TITLE_MAX_LENGTH).join('').trim();
	return { name, key: matchKeyOf(name) };
}
