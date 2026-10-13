import { categoryHintFromWords } from './category-keywords.ts';
import { cleanMoneyText, findMoneyMentions } from './money-parse.ts';
import { TITLE_MAX_LENGTH, type TileKey } from './transactions.ts';
import { cleanText } from './text.ts';
import type { WalletType } from './wallets.ts';

/**
 * One spoken or typed sentence → transaction candidates (FN-14). Pure and deterministic: the browser's speech
 * path, the typed path and the no-JavaScript server path all call `parseVoiceSentence`, so the same sentence
 * always gives the same candidates. Amounts come only from FN-14a's `findMoneyMentions` (never a second
 * tokenizer); this module adds segmentation, wallet/income/category words and nothing else. Untrusted input:
 * `cleanMoneyText` strips control/zero-width characters and caps the length before anything else; never throws.
 */

/** Most transactions one "Simpan" writes (owner decision B); the rest wait for the next submission. */
export const VOICE_BATCH_MAX = 20;

export interface VoiceContext {
	/** The space's own wallets, favourite first (wallet-word matching only). */
	wallets: readonly { id: string; name: string; type: WalletType }[];
}

export interface VoiceDraftCandidate {
	title: string;
	/** IDR minor units, positive. */
	amountMinor: number;
	type: 'expense' | 'income';
	/** Id of the space wallet the item named; absent when it named none (the save falls back to the favourite). */
	walletHint?: string;
	categoryHint?: TileKey;
}

const SEPARATORS: ReadonlySet<string> = new Set(['dan', 'terus', 'lalu', 'plus']);
const INCOME_WORDS: ReadonlySet<string> = new Set([
	'gaji',
	'bonus',
	'thr',
	'refund',
	'cashback',
	'jual'
]);
/** Fixed wallet words → the wallet type they name (the first wallet of that type in the space). */
const WALLET_TYPE_WORDS: readonly { words: readonly string[]; type: WalletType }[] = [
	{ words: ['kartu', 'kredit'], type: 'kartu_kredit' },
	{ words: ['tunai'], type: 'tunai' },
	{ words: ['cash'], type: 'tunai' }
];
/** Words that introduce a wallet ("pakai gopay"); dropped from the title together with the wallet words. */
const WALLET_LEADS: ReadonlySet<string> = new Set(['pakai', 'pake', 'via', 'dengan', 'dari']);

/** ASCII-only lower case: same length, no Unicode case folding (as the money parser reads text). */
function asciiLower(text: string): string {
	return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Text → words; a comma is its own word so it can act as a separator. */
function words(text: string): string[] {
	return text
		.replace(/,/g, ' , ')
		.split(/\s+/)
		.filter((w) => w !== '');
}

/** A word without the punctuation around it, lower-cased (for keyword checks only). */
const bare = (word: string) => asciiLower(word).replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');

const isSeparator = (word: string) => word === ',' || SEPARATORS.has(bare(word));

function trimSeparators(list: string[]): string[] {
	let start = 0;
	let end = list.length;
	while (start < end && isSeparator(list[start] as string)) start++;
	while (end > start && isSeparator(list[end - 1] as string)) end--;
	return list.slice(start, end);
}

/** A gap between two amounts: the words before its first separator end the previous item, the rest start the next. */
function splitGap(gap: string[]): { tail: string[]; head: string[] } {
	const at = gap.findIndex(isSeparator);
	return at < 0 ? { tail: [], head: gap } : { tail: gap.slice(0, at), head: gap.slice(at + 1) };
}

/** Index of `needle` (a run of bare words) inside `haystack`'s bare words, or -1. */
function findRun(haystack: readonly string[], needle: readonly string[]): number {
	if (needle.length === 0) return -1;
	for (let i = 0; i + needle.length <= haystack.length; i++) {
		if (needle.every((w, j) => haystack[i + j] === w)) return i;
	}
	return -1;
}

/**
 * The wallet an item names: a space wallet's own name as whole words (longest name first), else a fixed wallet
 * word naming a type the space has. Returns the wallet id and the item's words without the wallet phrase.
 */
function matchWallet(
	itemWords: string[],
	wallets: VoiceContext['wallets']
): { walletHint?: string; rest: string[] } {
	const bareWords = itemWords.map(bare);
	const byName = wallets
		.map((w) => ({ id: w.id, run: words(asciiLower(w.name)).map(bare).filter(Boolean) }))
		.filter((w) => w.run.length > 0)
		.sort((a, b) => b.run.join(' ').length - a.run.join(' ').length);
	const candidates: { id: string; run: string[] }[] = [...byName];
	for (const fixed of WALLET_TYPE_WORDS) {
		const wallet = wallets.find((w) => w.type === fixed.type);
		if (wallet) candidates.push({ id: wallet.id, run: [...fixed.words] });
	}
	for (const c of candidates) {
		const at = findRun(bareWords, c.run);
		if (at < 0) continue;
		const from = at > 0 && WALLET_LEADS.has(bareWords[at - 1] as string) ? at - 1 : at;
		return {
			walletHint: c.id,
			rest: [...itemWords.slice(0, from), ...itemWords.slice(at + c.run.length)]
		};
	}
	return { rest: itemWords };
}

/**
 * The space wallet a free text names, with the same name and type words a spoken item uses (FN-15: the payment
 * line printed on a receipt, e.g. "DEBIT BCA" or "TUNAI"), or undefined when it names none.
 */
export function walletHintFromText(
	text: string,
	wallets: VoiceContext['wallets']
): string | undefined {
	if (typeof text !== 'string') return undefined;
	return matchWallet(words(cleanMoneyText(text)), wallets).walletHint;
}

function buildCandidate(
	itemWords: string[],
	amountMinor: number,
	context: VoiceContext
): VoiceDraftCandidate {
	const bareWords = itemWords.map(bare);
	const type = bareWords.some((w) => INCOME_WORDS.has(w)) ? 'income' : 'expense';
	const { walletHint, rest } = matchWallet(itemWords, context.wallets);
	const title = cleanText(
		trimSeparators(rest)
			.join(' ')
			.replace(/\s+,/g, ',')
			.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, ''),
		TITLE_MAX_LENGTH
	);
	const candidate: VoiceDraftCandidate = { title, amountMinor, type };
	if (walletHint !== undefined) candidate.walletHint = walletHint;
	if (type === 'expense') {
		// The shared keyword table (FN-06 fixed words, widened 2026-10-08 by FN-39, owner decision).
		const hint = categoryHintFromWords(bareWords);
		if (hint !== undefined) candidate.categoryHint = hint;
	}
	return candidate;
}

/**
 * The sentence's items, one per money mention, in reading order. The words before a mention (since the previous
 * one) name it; in the gap between two mentions the words before the first separator (`dan`, `terus`, `lalu`,
 * `plus`, a comma) still belong to the earlier item, so "kopi 25rb pakai gopay, parkir goceng" keeps "pakai
 * gopay" with the coffee. Words after the last mention, up to a separator, belong to the last item. A bare number
 * before a noun ("beli 2 kopi") is not a mention, so it stays in the title. Zero mentions → `[]`.
 */
export function parseVoiceSentence(text: string, context: VoiceContext): VoiceDraftCandidate[] {
	if (typeof text !== 'string') return [];
	const clean = cleanMoneyText(text);
	const mentions = findMoneyMentions(clean).filter((m) => m.minor !== 0);
	if (mentions.length === 0) return [];
	const items: { words: string[]; minor: number }[] = [];
	let cursor = 0;
	mentions.forEach((m, i) => {
		const gap = words(clean.slice(cursor, m.start));
		if (i === 0) items.push({ words: gap, minor: Math.abs(m.minor) });
		else {
			const { tail, head } = splitGap(gap);
			(items[i - 1] as { words: string[] }).words.push(...tail);
			items.push({ words: head, minor: Math.abs(m.minor) });
		}
		cursor = m.end;
	});
	const after = words(clean.slice(cursor));
	const stop = after.findIndex(isSeparator);
	(items[items.length - 1] as { words: string[] }).words.push(
		...(stop < 0 ? after : after.slice(0, stop))
	);
	return items.map((item) => buildCandidate(item.words, item.minor, context));
}

/**
 * The transcript as the parser reads it, cut into plain and amount parts for the live "amounts highlighted"
 * view. Rendered as text (never HTML); joined back it equals `cleanMoneyText(text)`.
 */
export function highlightMoney(text: string): { text: string; mark: boolean }[] {
	const clean = cleanMoneyText(typeof text === 'string' ? text : '');
	const parts: { text: string; mark: boolean }[] = [];
	let cursor = 0;
	for (const m of findMoneyMentions(clean)) {
		if (m.start > cursor) parts.push({ text: clean.slice(cursor, m.start), mark: false });
		parts.push({ text: clean.slice(m.start, m.end), mark: true });
		cursor = m.end;
	}
	if (cursor < clean.length) parts.push({ text: clean.slice(cursor), mark: false });
	return parts;
}
