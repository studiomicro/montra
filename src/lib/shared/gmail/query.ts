import { PAYMENT_SUBJECT_WORDS } from '../inbound/mail.ts';

/**
 * The Gmail search (`q`) of a check (FN-19 Gmail PRD § 5): a cheap prefilter only, the local payment check
 * (shared/inbound/mail.ts `looksLikePayment`) decides. Promotions and Social are excluded here and again per
 * message from its `labelIds` (a negative operator can still return a conversation holding an excluded mail).
 * Built from constants and one integer: no user text ever reaches `q`.
 */

/**
 * Sender names from the FN-19 list (banks, e-wallets, shops and travel, subscriptions), as Gmail `from:` words.
 * Real sender domains are not confirmed yet (owner samples pending); a word matches a sender's name or address.
 */
export const GMAIL_SENDER_TERMS = [
	'bca',
	'mandiri',
	'bri',
	'bni',
	'jago',
	'bsi',
	'cimb',
	'permata',
	'jenius',
	'seabank',
	'gopay',
	'gojek',
	'grab',
	'ovo',
	'dana',
	'shopee',
	'tokopedia',
	'blibli',
	'lazada',
	'bukalapak',
	'traveloka',
	'tiket',
	'bluebird',
	'kai',
	'apple',
	'googleplay',
	'netflix',
	'spotify'
] as const;

/** Longest query built (a guard: the constants above keep it far shorter). */
export const GMAIL_QUERY_MAX = 1000;

const term = (word: string) => (/\s/.test(word) ? `"${word}"` : word);

/** The `q` of a check listing mail received after `afterEpochS` (epoch seconds, as Gmail's filtering guide asks). */
export function gmailQuery(afterEpochS: number): string {
	if (!Number.isSafeInteger(afterEpochS) || afterEpochS < 0)
		throw new RangeError('after must be a non-negative integer');
	const from = GMAIL_SENDER_TERMS.map(term).join(' OR ');
	const subject = PAYMENT_SUBJECT_WORDS.map(term).join(' OR ');
	const q = `-category:promotions -category:social after:${afterEpochS} (from:(${from}) OR subject:(${subject}))`;
	if (q.length > GMAIL_QUERY_MAX) throw new RangeError('query too long');
	return q;
}
