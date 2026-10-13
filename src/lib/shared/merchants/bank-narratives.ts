import { cleanText } from '../text.ts';
import type { CategoryKind, TileKey } from '../transactions.ts';

/**
 * FN-48: Indonesian bank mutation jargon ("BIAYA ADM", "TARIKAN ATM", "KARTU KREDIT/PL …", "TRSF E-BANKING DB",
 * "BI-FAST CR", "SWITCHING …") to a bank-statement preset tile. Pure and shared, no AI, no clock. It reads the
 * row's raw words, because FN-20's `cleanDescriptor` strips exactly these channel words (`trsf`, `tarikan`,
 * `bi fast`, `db`, `cr`) before the dictionary sees the text.
 *
 * Words: lower-case letter runs only (digits, card tails and references are dropped), matched whole and, for a
 * phrase, as consecutive words. The signals are read in this priority, the first that fits the row's kind wins:
 *
 * 1. fee (`biaya-bank`, expense): "adm"/"admin"/"administrasi", or "biaya" together with a banking word, so a
 *    transfer fee ("SWITCHING DB BIAYA TXN") is a fee, never a transfer, and "biaya sekolah" is left alone;
 * 2. tax (`pajak`, expense): "pajak", "pph" (so "PAJAK BUNGA" is tax, not interest);
 * 3. interest (`bunga`, income): "bunga", "jasa giro", "interest";
 * 4. cash withdrawal (`tarik-tunai`, expense): "tarikan atm", "tarik tunai", "penarikan tunai", "cash withdrawal";
 * 5. credit-card bill (`kartu-kredit`, expense): a narrative that starts with "kartu kredit" or pays one
 *    ("pembayaran/bayar/tagihan kartu kredit"), so a purchase merely mentioning the card is not a bill;
 * 6. transfer (`transfer`, both kinds): "trsf", "trf", "transfer", "bi fast"/"bifast", "kliring", "rtgs", "skn",
 *    "switching".
 *
 * A debit-card purchase ("KARTU DEBIT KACAMATAMOO") carries none of these and gets nothing here. Only the bank's
 * own leading words are read as a signal (red team L1 and cycle 2 L2; see narrativeTile).
 */

/** Longest narrative read (code points); the rest is ignored. */
const NARRATIVE_MAX_LENGTH = 300;

/** The row's words: lower-case letter runs (digits and every other character split and dropped). */
export function narrativeWords(raw: string): string[] {
	if (typeof raw !== 'string') return [];
	return cleanText(raw, NARRATIVE_MAX_LENGTH)
		.normalize('NFKC')
		.toLowerCase()
		.split(/[^\p{L}]+/u)
		.filter((w) => w !== '');
}

function hasRun(words: readonly string[], phrase: readonly string[]): boolean {
	outer: for (let i = 0; i + phrase.length <= words.length; i++) {
		for (let j = 0; j < phrase.length; j++) if (words[i + j] !== phrase[j]) continue outer;
		return true;
	}
	return false;
}

const anyRun = (words: readonly string[], phrases: readonly (readonly string[])[]) =>
	phrases.some((p) => hasRun(words, p));

const p = (...phrases: string[]) => phrases.map((s) => s.split(' '));

const ADMIN_WORDS = p('adm', 'admin', 'administrasi');
/** Words that make "biaya" a bank fee rather than any cost ("biaya sekolah"). */
const FEE_CONTEXT = p(
	'txn',
	'transaksi',
	'trsf',
	'trf',
	'transfer',
	'switching',
	'kliring',
	'rtgs',
	'skn',
	'bi fast',
	'bifast',
	'atm',
	'kartu',
	'bulanan',
	'meterai',
	'materai',
	'provisi'
);
const TAX_WORDS = p('pajak', 'pph');
const INTEREST_WORDS = p('bunga', 'jasa giro', 'interest');
const CASH_WORDS = p(
	'tarikan atm',
	'tarikan tunai',
	'tarik tunai',
	'penarikan tunai',
	'cash withdrawal'
);
const CARD_BILL_WORDS = p('pembayaran kartu kredit', 'bayar kartu kredit', 'tagihan kartu kredit');
const TRANSFER_WORDS = p(
	'trsf',
	'trf',
	'transfer',
	'bi fast',
	'bifast',
	'kliring',
	'rtgs',
	'skn',
	'switching'
);

/**
 * Words a bank writes at the start of a transfer narrative: its channel and direction marks (`TRSF E-BANKING DB`,
 * `BI-FAST CR`, `SWITCHING DB`). Whatever follows them may be the sender's note.
 */
const CHANNEL_WORDS = new Set([
	'trsf',
	'trf',
	'transfer',
	'bi',
	'fast',
	'bifast',
	'kliring',
	'rtgs',
	'skn',
	'switching',
	'e',
	'banking',
	'db',
	'cr'
]);

/** How many leading words are the bank's channel prefix. */
function channelPrefix(words: readonly string[]): number {
	let at = 0;
	while (at < words.length && CHANNEL_WORDS.has(words[at]!)) at++;
	return at;
}

/** One of `phrases` starts exactly at word `at`. */
const startsWith = (
	words: readonly string[],
	at: number,
	phrases: readonly (readonly string[])[]
) => phrases.some((phrase) => hasRun(words.slice(at, at + phrase.length), phrase));

/**
 * The bank-statement tile a narrative names for a row of `kind`, or undefined. Only the bank's own words pick a
 * tile (FN-48 red team L1, cycle 2 L2: an allowlist, not a list of known third-party prefixes): a fee, tax,
 * interest, cash or card-bill word counts only as the narrative's first word ("BIAYA ADM", "PAJAK BUNGA",
 * "BUNGA", "TARIKAN ATM", "KARTU KREDIT/PL"), or, for a fee, right after a debit transfer's channel prefix
 * ("SWITCHING DB BIAYA TXN"); a transfer only from its leading channel prefix. A sender's note, a merchant's
 * name or any other text later in the narrative never picks one.
 */
export function narrativeTile(raw: string, kind: CategoryKind): TileKey | undefined {
	const words = narrativeWords(raw);
	if (words.length === 0) return undefined;
	const at = channelPrefix(words);
	const prefix = words.slice(0, at);
	const transfer = anyRun(prefix, TRANSFER_WORDS);
	const debitFee = at > 0 && prefix[at - 1] === 'db';
	if (at === 0 || debitFee) {
		const bankFee =
			startsWith(words, at, ADMIN_WORDS) ||
			(words[at] === 'biaya' &&
				(debitFee || startsWith(words, at + 1, [...ADMIN_WORDS, ...FEE_CONTEXT])));
		if (bankFee) return kind === 'expense' ? 'biaya-bank' : undefined;
	}
	if (at === 0) {
		if (startsWith(words, 0, TAX_WORDS)) return kind === 'expense' ? 'pajak' : undefined;
		if (startsWith(words, 0, INTEREST_WORDS)) return kind === 'income' ? 'bunga' : undefined;
		if (kind === 'expense') {
			if (startsWith(words, 0, CASH_WORDS)) return 'tarik-tunai';
			if (startsWith(words, 0, [['kartu', 'kredit'], ...CARD_BILL_WORDS])) return 'kartu-kredit';
		}
	}
	return transfer ? 'transfer' : undefined;
}
