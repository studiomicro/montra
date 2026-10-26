import { msg } from './i18n';

/** Wallet kinds (FN-04; no `investasi`, owner decision E). Same list as the `wallets_type_check` constraint. */
export const WALLET_TYPES = ['tunai', 'bank', 'e_wallet', 'kartu_kredit', 'lainnya'] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

/** Label of each type, translated with tr() where shown. */
export const WALLET_TYPE_LABELS: Readonly<Record<WalletType, string>> = {
	tunai: msg('Tunai'),
	bank: msg('Bank'),
	e_wallet: msg('E-wallet'),
	kartu_kredit: msg('Kartu kredit'),
	lainnya: msg('Lainnya')
};

/**
 * FN-58 pass 1: the issuers of the contactless e-money cards a "Kartu e-money" wallet can be. Same list as the
 * `wallets_emoney_issuer_check` constraint (migration 0049). The card is stored as an `e_wallet` wallet with its
 * issuer in `wallets.emoney_issuer`, so its balance, top-ups and net worth work like any e-wallet's.
 */
export const EMONEY_ISSUERS = [
	'mandiri_emoney',
	'bca_flazz',
	'bri_brizzi',
	'bni_tapcash',
	'kmt',
	'jakcard',
	'megacash'
] as const;
export type EmoneyIssuer = (typeof EMONEY_ISSUERS)[number];

/** Each issuer's card name: proper names, never translated; no logos. */
export const EMONEY_ISSUER_LABELS: Readonly<Record<EmoneyIssuer, string>> = {
	mandiri_emoney: 'Mandiri e-Money',
	bca_flazz: 'BCA Flazz',
	bri_brizzi: 'BRI Brizzi',
	bni_tapcash: 'BNI TapCash',
	kmt: 'KMT (KAI Commuter)',
	jakcard: 'JakCard / JakLingko',
	megacash: 'MegaCash'
};

export const isEmoneyIssuer = (value: string | null): value is EmoneyIssuer =>
	(EMONEY_ISSUERS as readonly string[]).includes(value ?? '');

/**
 * The add/edit form's type choices: the stored types plus `e_money`, "Kartu e-money", which the server saves as
 * an `e_wallet` with the chosen issuer (FN-58 pass 1). Never a stored type.
 */
export const EMONEY_FORM_TYPE = 'e_money';
export const WALLET_FORM_TYPES = [
	'tunai',
	'bank',
	'e_wallet',
	EMONEY_FORM_TYPE,
	'kartu_kredit',
	'lainnya'
] as const;
export type WalletFormType = (typeof WALLET_FORM_TYPES)[number];

export const WALLET_FORM_TYPE_LABELS: Readonly<Record<WalletFormType, string>> = {
	...WALLET_TYPE_LABELS,
	e_money: msg('Kartu e-money')
};

/** A stored wallet that is an e-money card: an `e_wallet` with a known issuer (FN-58 pass 1). */
export function isEmoneyCard(w: {
	type: WalletType;
	emoneyIssuer: string | null;
}): w is { type: 'e_wallet'; emoneyIssuer: EmoneyIssuer } {
	return w.type === 'e_wallet' && isEmoneyIssuer(w.emoneyIssuer);
}

/** The form choice a stored wallet is edited as: an e-money card is a "Kartu e-money", else its own type. */
export function walletFormType(w: {
	type: WalletType;
	emoneyIssuer: string | null;
}): WalletFormType {
	return isEmoneyCard(w) ? EMONEY_FORM_TYPE : w.type;
}

/**
 * Currencies a wallet may hold. An explicit allow-list (validated server-side) so an unknown code never reaches
 * the formatter, whose exponent table knows every code here. IDR first: the default. TWD, HKD, CNY: FN-47.
 */
export const WALLET_CURRENCIES = [
	'IDR',
	'USD',
	'SGD',
	'MYR',
	'EUR',
	'JPY',
	'AUD',
	'GBP',
	'TWD',
	'HKD',
	'CNY'
] as const;
export type WalletCurrency = (typeof WALLET_CURRENCIES)[number];

/**
 * A currency picker's option label: the ISO code itself, except `CNY (RMB)` (owner decision, FN-47). A proper
 * code, never translated; money is still shown with the bare code (formatMoney).
 */
export function walletCurrencyLabel(code: string): string {
	return code === 'CNY' ? 'CNY (RMB)' : code;
}

export const WALLET_NAME_MAX_LENGTH = 60;

/**
 * FN-39 quick picks above the new-wallet name: common e-wallets, each filling the name and the `e_wallet` type
 * (the user can still edit both). Proper names, never translated; no logos. No GrabPay: in Indonesia it is OVO.
 */
export const WALLET_QUICK_PICKS = [
	{ id: 'gopay', name: 'GoPay' },
	{ id: 'ovo', name: 'OVO' },
	{ id: 'shopeepay', name: 'ShopeePay' },
	{ id: 'dana', name: 'DANA' }
] as const satisfies readonly { id: string; name: string }[];
export type WalletQuickPick = (typeof WALLET_QUICK_PICKS)[number];

/** The quick pick with id `id` (`?dompet=<id>`), or null for anything else. */
export function walletQuickPick(id: string | null): WalletQuickPick | null {
	return WALLET_QUICK_PICKS.find((p) => p.id === id) ?? null;
}

/**
 * A wallet's type as its row shows it, translated with `tr`: "Kartu e-money · BCA Flazz" for an e-money card (FN-58
 * pass 1), else the type's label.
 */
export function walletKindLabel(
	w: { type: WalletType; emoneyIssuer: string | null },
	tr: (phrase: string) => string
): string {
	if (isEmoneyCard(w))
		return `${tr(WALLET_FORM_TYPE_LABELS[EMONEY_FORM_TYPE])} · ${EMONEY_ISSUER_LABELS[w.emoneyIssuer]}`;
	return tr(WALLET_TYPE_LABELS[w.type]);
}

/**
 * FN-58 quick picks: one per e-money issuer, each filling the name and the "Kartu e-money" choice with that
 * issuer (`?tambah=1&kartu=<issuer>`). Proper names, never translated; no logos.
 */
export const EMONEY_QUICK_PICKS = EMONEY_ISSUERS.map((issuer) => ({
	issuer,
	name: EMONEY_ISSUER_LABELS[issuer]
}));
export type EmoneyQuickPick = (typeof EMONEY_QUICK_PICKS)[number];

/** The e-money quick pick for issuer `id` (`?kartu=<id>`), or null for anything else. */
export function emoneyQuickPick(id: string | null): EmoneyQuickPick | null {
	return EMONEY_QUICK_PICKS.find((p) => p.issuer === id) ?? null;
}

/** `•••• 1234`: the only way a stored last-4 is shown. */
export function maskedLastFour(lastFour: string): string {
	return `•••• ${lastFour}`;
}

/** The add/edit form's fields as typed (a refused no-JS form echoes them back; never stored as such). */
export interface WalletFormValues {
	name: string;
	type: string;
	currency: string;
	/** Whole units, grouped as typed (`1.250.000`). */
	openingBalance: string;
	/** The balance is owed (negative), e.g. a credit card's bill (owner decision D). */
	negative: boolean;
	isFavourite: boolean;
	lastFour: string;
	/**
	 * FN-55a: which balance wording the form showed. `card`: "Tagihan berjalan" typed as a positive amount owed (stored
	 * negative) with the currency's sen, unless `overpaid`; `plain`: "Saldo awal" with the `negative` box.
	 */
	balanceMode: 'plain' | 'card';
	/** FN-55a, card mode: the card is overpaid (a credit balance, stored positive). */
	overpaid: boolean;
	/** FN-55a, `kartu_kredit` only: the limit as typed (with sen), and the statement and due days ('' = none). */
	creditLimit: string;
	statementDay: string;
	dueDay: string;
	/** FN-58 pass 1, the `e_money` choice only: the issuer key as chosen ('' = none). */
	emoneyIssuer: string;
}

/** FN-55a: a credit-card wallet (the only type with a limit, statement day and due day). */
export const isCardType = (type: string) => type === 'kartu_kredit';
