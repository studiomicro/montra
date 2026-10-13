import { msg } from '#lib/shared/i18n';
import { CURRENCY_INVALID, WALLET_CHANGED } from '../wallets/messages';

/** Server answers of the budget actions on Beranda (translated by the page with tr()). */
export const BUDGET_AMOUNT_INVALID = msg(
	'Isi anggaran lebih dari 0 dengan angka bulat, tanpa sen.'
);
/** FN-47: the same refusal for a currency with cents (every wallet currency but IDR and JPY). */
export const BUDGET_AMOUNT_INVALID_CENTS = msg(
	'Isi anggaran lebih dari 0, maksimal 2 angka di belakang koma.'
);
/** Past MAX_AMOUNT_MINOR (10^13 minor units, the cap of one transaction). */
export const BUDGET_TOO_LARGE = msg('Anggaran terlalu besar.');
/** Same phrase as the wallet form: the currency must be on the allow-list and a live wallet's. */
export const BUDGET_CURRENCY_INVALID = CURRENCY_INVALID;
/** A stale form (another tab or member changed the budget since the page loaded): FN-04's exact phrase. */
export const BUDGET_CHANGED = WALLET_CHANGED;
export const BERANDA_LOAD_FAILED = msg('Beranda tidak bisa dimuat. Coba lagi sebentar lagi.');
export const ANGGARAN_LOAD_FAILED = msg('Anggaran tidak bisa dimuat. Coba lagi sebentar lagi.');
