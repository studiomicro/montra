import { asciiLowerKey, cleanText } from './text';

/**
 * Brand badges (FN-43): the banks, e-wallets and ride/food services a wallet, subscription or statement is most
 * often named after, each drawn as MONTRA's own monogram tile in a colour close to (never copied from) the
 * service's public colour. No logo, image or brand asset is fetched, bundled or embedded.
 */
export interface BrandEntry {
	/** Registry id: also the `--badge-<id>` token and the `.b-<id>` class. */
	id: string;
	/** The proper noun (code comments and tests only; the user's own typed name is what renders). */
	name: string;
	/**
	 * Words or word runs that name the service anywhere in a name ("Tabungan BCA", "Bank Central Asia"). Written
	 * lower-case with single spaces between words; matched whole-word only, never as a substring.
	 */
	aliases: readonly string[];
	/**
	 * Names that match only as the whole name, for a service whose name is also an everyday word ("DANA" is the
	 * e-wallet, "Dana darurat" is an emergency fund).
	 */
	wholeNames?: readonly string[];
	/** The 2–5 character monogram drawn in the tile. */
	badgeText: string;
}

/** Registry order decides a tie: banks, then e-wallets, then ride/food. */
export const BRANDS: readonly BrandEntry[] = [
	// Banks
	{ id: 'bca', name: 'BCA', aliases: ['bca', 'bank central asia'], badgeText: 'BCA' },
	{ id: 'mandiri', name: 'Bank Mandiri', aliases: ['mandiri'], badgeText: 'mdr' },
	{ id: 'bni', name: 'BNI', aliases: ['bni', 'bank negara indonesia'], badgeText: 'BNI' },
	{ id: 'bri', name: 'BRI', aliases: ['bri', 'brimo', 'bank rakyat indonesia'], badgeText: 'BRI' },
	{ id: 'bsi', name: 'BSI', aliases: ['bsi', 'bank syariah indonesia'], badgeText: 'BSI' },
	{ id: 'cimb', name: 'CIMB Niaga', aliases: ['cimb'], badgeText: 'CIMB' },
	{ id: 'permata', name: 'PermataBank', aliases: ['permata', 'permatabank'], badgeText: 'PMT' },
	{ id: 'danamon', name: 'Danamon', aliases: ['danamon'], badgeText: 'DMN' },
	{ id: 'btn', name: 'BTN', aliases: ['btn', 'bank tabungan negara'], badgeText: 'BTN' },
	{ id: 'ocbc', name: 'OCBC', aliases: ['ocbc'], badgeText: 'OCBC' },
	{
		id: 'jago',
		name: 'Bank Jago',
		aliases: ['bank jago'],
		wholeNames: ['jago'],
		badgeText: 'Jago'
	},
	{ id: 'seabank', name: 'SeaBank', aliases: ['seabank', 'sea bank'], badgeText: 'Sea' },
	{
		id: 'blu',
		name: 'blu (BCA Digital)',
		aliases: ['blu bca', 'bca digital', 'blubca'],
		wholeNames: ['blu'],
		badgeText: 'blu'
	},
	{ id: 'jenius', name: 'Jenius (BTPN)', aliases: ['jenius', 'btpn'], badgeText: 'Jns' },
	{
		id: 'allo',
		name: 'Allo Bank',
		aliases: ['allo bank', 'allobank'],
		wholeNames: ['allo'],
		badgeText: 'Allo'
	},
	// E-wallets
	{ id: 'gopay', name: 'GoPay', aliases: ['gopay', 'go pay'], badgeText: 'GoPay' },
	{ id: 'ovo', name: 'OVO', aliases: ['ovo'], badgeText: 'OVO' },
	{
		id: 'dana',
		name: 'DANA',
		aliases: ['dana e wallet', 'dana ewallet', 'e wallet dana', 'ewallet dana'],
		wholeNames: ['dana'],
		badgeText: 'DANA'
	},
	{ id: 'shopeepay', name: 'ShopeePay', aliases: ['shopeepay', 'shopee pay'], badgeText: 'SPay' },
	{ id: 'linkaja', name: 'LinkAja', aliases: ['linkaja', 'link aja'], badgeText: 'Link' },
	{ id: 'astrapay', name: 'AstraPay', aliases: ['astrapay', 'astra pay'], badgeText: 'Astra' },
	{ id: 'isaku', name: 'i.saku', aliases: ['isaku', 'i saku'], badgeText: 'isaku' },
	// Ride-hailing and food delivery
	{ id: 'gojek', name: 'Gojek', aliases: ['gojek', 'go jek'], badgeText: 'Gojek' },
	{ id: 'gofood', name: 'GoFood', aliases: ['gofood', 'go food'], badgeText: 'GoFd' },
	{
		id: 'grab',
		name: 'Grab',
		aliases: ['grab', 'grabfood', 'grabcar', 'grabbike', 'grabexpress', 'grabunlimited'],
		badgeText: 'Grab'
	},
	{ id: 'maxim', name: 'Maxim', aliases: ['maxim'], badgeText: 'Maxim' },
	{
		id: 'shopeefood',
		name: 'ShopeeFood',
		aliases: ['shopeefood', 'shopee food'],
		badgeText: 'SFood'
	},
	{ id: 'indrive', name: 'inDrive', aliases: ['indrive', 'indriver'], badgeText: 'inDr' }
];

/** Longer than any wallet or subscription name (60); a longer input is cut before any work. */
const NAME_MAX = 80;

/** A name's lower-case letter-and-digit words. */
function words(name: string): string[] {
	return asciiLowerKey(cleanText(name, NAME_MAX))
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w !== '');
}

/**
 * FN-43 L2: words that, right before a brand, say the brand is only mentioned ("Bayar ke BCA teman", "Transfer
 * ke OVO"): such a mention never gets the badge, wherever it sits.
 */
const MENTION_WORDS: ReadonlySet<string> = new Set([
	'ke',
	'dari',
	'via',
	'lewat',
	'untuk',
	'buat',
	'kepada',
	'bayar',
	'transfer',
	'kirim',
	'pakai',
	'to',
	'from',
	'for',
	'pay'
]);

/** Words that, right before a brand, say the name is that account or plan ("Rekening BCA utama"). */
const ACCOUNT_WORDS: ReadonlySet<string> = new Set([
	'tabungan',
	'rekening',
	'dompet',
	'kartu',
	'kredit',
	'debit',
	'akun',
	'bank',
	'saldo',
	'giro',
	'deposito',
	'wallet',
	'ewallet',
	'langganan',
	'account',
	'card',
	'savings'
]);

/**
 * True when `run` (an alias as words) appears as consecutive words of `list` where it names the account: at the
 * start, at the end, or right after an account word, and never right after a mention word. A brand word in the
 * middle of other words ("Patungan kado BRI teman") is an incidental mention (FN-43 L2).
 */
function namesRun(list: readonly string[], run: readonly string[]): boolean {
	for (let i = 0; i + run.length <= list.length; i++) {
		if (!run.every((w, j) => list[i + j] === w)) continue;
		const before = i > 0 ? list[i - 1]! : null;
		if (before !== null && MENTION_WORDS.has(before)) continue;
		if (before === null || i + run.length === list.length || ACCOUNT_WORDS.has(before)) return true;
	}
	return false;
}

/**
 * The registry entry a wallet or subscription name names, or null. In registry order: the whole name against
 * `wholeNames`, then multi-word aliases as a run of whole words ("Rekening Bank Central Asia"), then single-word
 * aliases as a whole word ("Tabungan BCA"). An alias counts only where it names the account (`namesRun`), not
 * where it is mentioned ("Bayar ke BCA teman"). Case, spacing and punctuation never matter; "gojek", "gopay" and
 * "gofood" never match each other.
 */
export function matchBrand(name: string): BrandEntry | null {
	const list = words(name);
	if (list.length === 0) return null;
	const whole = list.join(' ');
	for (const entry of BRANDS) if (entry.wholeNames?.includes(whole)) return entry;
	for (const entry of BRANDS)
		for (const alias of entry.aliases)
			if (alias.includes(' ') && namesRun(list, alias.split(' '))) return entry;
	for (const entry of BRANDS)
		for (const alias of entry.aliases)
			if (!alias.includes(' ') && namesRun(list, [alias])) return entry;
	return null;
}

/** The entry with this registry id (a statement parser's own id), never alias-matched. */
export function brandById(id: string): BrandEntry | null {
	return BRANDS.find((entry) => entry.id === id) ?? null;
}

/**
 * A statement institution as an Impor picker row: a parser whose id is in the registry carries its badge, so a
 * new parser (BNI, BRI, Mandiri, …) shows one with no change here.
 */
export function institutionOption<T extends string>(institution: {
	id: T;
	label: string;
}): { value: T; label: string; brand?: string } {
	const brand = brandById(institution.id);
	return brand
		? { value: institution.id, label: institution.label, brand: brand.id }
		: { value: institution.id, label: institution.label };
}

/**
 * A wallet's chart series (Alur uang): `brand-<id>` (its badge hue, `series.css`) when the name names a registry
 * entry, else the flat `accent`.
 */
export function walletSeries(name: string): string {
	const brand = matchBrand(name);
	return brand ? `brand-${brand.id}` : 'accent';
}
