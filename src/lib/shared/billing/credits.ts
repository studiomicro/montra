import { msg, type Locale } from '../i18n.ts';

/**
 * FN-30 credits ("kredit", a working name). Credits are NOT money: never formatted with formatMoney /
 * formatMoneyCompact, never summed with an amount, never shown with a currency symbol.
 */

/** Why a ledger row exists. Adding one needs a migration (the `credit_ledger.reason` CHECK). */
export const LEDGER_REASONS = [
	'starter_grant',
	'monthly_grant',
	'voucher_redeemed',
	'gmail_lookback_purchase',
	'admin_adjustment',
	'ai_capture_spend'
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export const LEDGER_REASON_LABELS: Record<LedgerReason, string> = {
	starter_grant: msg('Kredit awal'),
	monthly_grant: msg('Kredit paket'),
	voucher_redeemed: msg('Voucher ditukar'),
	gmail_lookback_purchase: msg('Pembelian lihat ke belakang Gmail'),
	admin_adjustment: msg('Penyesuaian'),
	ai_capture_spend: msg('Pemakaian AI')
};

/**
 * Largest |delta| of one ledger row (a DB CHECK too). With SUM over at most 9,007,199 such rows staying a safe
 * integer, a balance can never leave JavaScript's exact-integer range in practice; creditBalance still checks.
 */
export const MAX_LEDGER_DELTA = 1_000_000_000;

const grouped = (n: number, locale: Locale) =>
	new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'id-ID', { maximumFractionDigits: 0 }).format(
		Math.abs(n)
	);

/** `1.250` (id) / `1,250` (en), `−20` below zero: a whole number of credits, no currency symbol. */
export function formatCredits(n: number, locale: Locale): string {
	return `${n < 0 ? '−' : ''}${grouped(n, locale)}`;
}

/** `+300` / `−50` (U+2212 minus, like money) for a ledger row. */
export function formatCreditDelta(delta: number, locale: Locale): string {
	return `${delta < 0 ? '−' : '+'}${grouped(delta, locale)}`;
}
