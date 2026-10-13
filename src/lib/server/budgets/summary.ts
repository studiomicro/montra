import { addDays, daysBetween, monthOf, monthRange, shiftMonth } from '#lib/shared/dates';
import type { Db } from '../db';
import {
	categoryTotals,
	dailyTotals,
	listTransactionsByDay,
	MAX_FILTER_DAYS,
	PAGE_SIZE,
	periodTotals,
	type DayGroup,
	type TransactionFilter,
	type TransactionListRow
} from '../transactions/aggregate';
import { listSubscriptions, type SubscriptionSummary } from '../subscriptions/repo';
import { listWallets } from '../wallets/repo';
import { berandaFigures, type BerandaFigures } from './math';
import { getActiveBudget } from './repo';

export interface BerandaSummary extends BerandaFigures {
	/** Today's rows and whole-day totals: the same group Riwayat shows for today. Null when none. */
	todayGroup: DayGroup | null;
	/** Today has more rows than one page: the full list is on Riwayat. */
	todayHasMore: boolean;
	/** The space's wallets (not deleted): 0 shows the first-wallet card (FN-40). */
	walletCount: number;
}

const filter = (from: string, to: string, type: TransactionFilter['type']): TransactionFilter => ({
	from,
	to,
	type,
	categoryId: null,
	walletId: null,
	q: null
});

/**
 * Everything Beranda shows for `spaceId` (already admitted by the access gate) on the WIB date `today`, read
 * through the FN-05 aggregates only: the month total is `periodTotals` with Riwayat's month filter, today's
 * list is `listTransactionsByDay` with Riwayat's one-day filter, so both equal what Riwayat shows.
 */
export async function berandaSummary(
	db: Db,
	spaceId: string,
	today: string
): Promise<BerandaSummary> {
	const month = monthOf(today);
	const thisMonth = monthRange(month);
	const lastMonth = monthRange(shiftMonth(month, -1));
	const [wallets, budget, monthTotals, daily, categories, todayPage] = await Promise.all([
		listWallets(db, spaceId),
		getActiveBudget(db, spaceId),
		periodTotals(db, spaceId, filter(thisMonth.from, thisMonth.to, 'expense')),
		dailyTotals(db, spaceId, filter(lastMonth.from, thisMonth.to, 'expense')),
		categoryTotals(db, spaceId, filter(thisMonth.from, thisMonth.to, 'expense')),
		listTransactionsByDay(db, spaceId, filter(today, today, null), { limit: PAGE_SIZE })
	]);
	const currency = wallets.find((w) => w.isFavourite)?.currency ?? 'IDR';
	return {
		...berandaFigures({ today, currency, budget, monthTotals, daily, categories }),
		todayGroup: todayPage.days[0] ?? null,
		todayHasMore: todayPage.nextCursor !== null,
		walletCount: wallets.length
	};
}

/** Rows in Beranda's "Terbaru" list. */
export const RECENT_ROWS = 3;
/** "Akan datang": bills due within this many days (today included), at most UPCOMING_ROWS of them. */
export const UPCOMING_DAYS = 7;
export const UPCOMING_ROWS = 3;

export interface UpcomingBill {
	id: string;
	name: string;
	amountMinor: number;
	currency: string;
	/** WIB date of the next charge and how many days away it is (0 = today). */
	nextChargeOn: string;
	inDays: number;
	isDemo: boolean;
}

/** The subscriptions charging within `days` of `today` (inclusive), soonest first, at most `limit`. */
export function billsDueWithin(
	subscriptions: readonly SubscriptionSummary[],
	today: string,
	days: number,
	limit: number
): UpcomingBill[] {
	return subscriptions
		.map((s) => ({ s, inDays: daysBetween(today, s.nextChargeOn) }))
		.filter(({ inDays }) => inDays >= 0 && inDays < days)
		.sort((a, b) => a.inDays - b.inDays || (a.s.id < b.s.id ? -1 : 1))
		.slice(0, limit)
		.map(({ s, inDays }) => ({
			id: s.id,
			name: s.name,
			amountMinor: s.amountMinor,
			currency: s.currency,
			nextChargeOn: s.nextChargeOn,
			inDays,
			isDemo: s.isDemo
		}));
}

/**
 * Beranda's "Terbaru" and "Akan datang" lists for `spaceId` (already admitted by the access gate), through the
 * existing FN-05 list and FN-26 subscription queries: the newest RECENT_ROWS rows of the last year up to today
 * (the same rows and order Riwayat shows) and the bills charging in the next UPCOMING_DAYS days.
 */
export async function berandaLists(
	db: Db,
	spaceId: string,
	today: string
): Promise<{ recent: TransactionListRow[]; upcoming: UpcomingBill[] }> {
	const [page, subscriptions] = await Promise.all([
		listTransactionsByDay(
			db,
			spaceId,
			filter(addDays(today, -(MAX_FILTER_DAYS - 1)), today, null),
			{
				limit: RECENT_ROWS
			}
		),
		listSubscriptions(db, spaceId, today)
	]);
	return {
		recent: page.days.flatMap((d) => d.rows),
		upcoming: billsDueWithin(subscriptions, today, UPCOMING_DAYS, UPCOMING_ROWS)
	};
}
