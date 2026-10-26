import { addDays } from '#lib/shared/dates';
import type { Db } from '../db';
import { walletExpenseTotals } from '../transactions/aggregate';
import type { WalletLine } from './summary';

/** The window of a card's "spent in the last 30 days": today and the 29 WIB days before it. */
const CARD_SPEND_DAYS = 30;

/** A live credit-card wallet with what was spent from it in the window, per currency (FN-25b). */
export interface CreditCardSpend {
	walletId: string;
	name: string;
	lastFour: string | null;
	/** The wallet's own currency (shown as zero spend when nothing was spent). */
	currency: string;
	/** First and last WIB date of the window, for the Riwayat link the figure reconciles with. */
	from: string;
	to: string;
	/** Expense sums per currency, positive magnitudes; empty when nothing was spent. */
	totals: { currency: string; outMinor: number | null }[];
}

/**
 * The 30-day spend of every `kartu_kredit` wallet in `wallets` (the space's live wallets, already admitted by
 * the caller through `requireSpaceAccess`). One grouped query for all cards; none when there is no card.
 */
export async function creditCardSpend(
	db: Db,
	spaceId: string,
	wallets: readonly WalletLine[],
	today: string
): Promise<CreditCardSpend[]> {
	const cards = wallets.filter((w) => w.type === 'kartu_kredit');
	if (cards.length === 0) return [];
	const period = { from: addDays(today, -(CARD_SPEND_DAYS - 1)), to: today };
	const sums = await walletExpenseTotals(
		db,
		spaceId,
		period,
		cards.map((c) => c.id)
	);
	return cards.map((c) => ({
		walletId: c.id,
		name: c.name,
		lastFour: c.lastFour,
		currency: c.currency,
		...period,
		totals: sums
			.filter((s) => s.walletId === c.id)
			.map((s) => ({ currency: s.currency, outMinor: s.outMinor }))
	}));
}
