import { PAYMENT_SUBJECT_WORDS } from '../inbound/mail.ts';
import { SENDER_DOMAINS, type SenderDomain } from '../inbound/sender-domains.ts';

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

/**
 * Longest query built (our own guard, not a Google limit): the name words take about 500 characters, and a full
 * registry (SENDER_DOMAINS_MAX domains of at most SENDER_DOMAIN_MAX_LENGTH characters, FN-19b) adds at most
 * about 1,350 more.
 */
export const GMAIL_QUERY_MAX = 2000;

const term = (word: string) => (/\s/.test(word) ? `"${word}"` : word);

/**
 * The `q` of a check listing mail received after `afterEpochS` (epoch seconds, as Gmail's filtering guide asks).
 * FN-19b: each confirmed registry domain (sender-domains.ts, a constant list) joins the `from:` terms as
 * `@<domain>`, beside the name words that stay the wide net.
 */
export function gmailQuery(
	afterEpochS: number,
	registry: readonly SenderDomain[] = SENDER_DOMAINS
): string {
	if (!Number.isSafeInteger(afterEpochS) || afterEpochS < 0)
		throw new RangeError('after must be a non-negative integer');
	const from = [...GMAIL_SENDER_TERMS.map(term), ...registry.map((e) => `@${e.domain}`)].join(
		' OR '
	);
	const subject = PAYMENT_SUBJECT_WORDS.map(term).join(' OR ');
	const q = `-category:promotions -category:social after:${afterEpochS} (from:(${from}) OR subject:(${subject}))`;
	if (q.length > GMAIL_QUERY_MAX) throw new RangeError('query too long');
	return q;
}
