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
}
