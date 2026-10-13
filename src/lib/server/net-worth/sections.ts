import { sectionOfKind, type WealthSection } from '#lib/shared/wealth';
import { balanceTotals, type BalanceTotal } from '../wallets/balance';
import type { ValuedNetWorthItem, WalletLine } from './summary';

/** Each grouped section's subtotal per currency (FN-25b), never summed across currencies. */
export type SectionTotals = Record<'wallets' | WealthSection, BalanceTotal[]>;

/**
 * The Dompet, Investasi and Kripto subtotals: exact BigInt sums per currency of the rows each section lists
 * (wallet balances; item values in their own currency). Rows that are not counted stay out: a `Data demo` item
 * and an item without a price or manual value ("Belum ada harga"). A row too large to show makes its
 * currency's subtotal too large, never a rounded figure.
 */
export function sectionTotals(
	wallets: readonly WalletLine[],
	items: readonly ValuedNetWorthItem[]
): SectionTotals {
	const counted = (section: WealthSection) =>
		items
			.filter((i) => sectionOfKind(i.kind) === section && !i.isDemo && i.basis !== null)
			.map((i) => ({ currency: i.currency, balanceMinor: i.valueMinor }));
	return {
		wallets: balanceTotals(wallets, 'IDR'),
		investment: balanceTotals(counted('investment'), 'IDR'),
		crypto: balanceTotals(counted('crypto'), 'IDR')
	};
}
