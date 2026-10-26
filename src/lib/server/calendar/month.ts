import { monthRange } from '#lib/shared/dates';
import type { DueSeries, DueSubscription } from '#lib/shared/calendar';
import type { Db } from '../db';
import { listSeries } from '../recurring/repo';
import { heatmapDays, type HeatDay } from '../reports/laporan';
import { closedDatesIn } from '../streak/repo';
import { listSubscriptions } from '../subscriptions/repo';
import {
	dailyTotals,
	listTransactionsByDay,
	PAGE_SIZE,
	type DayGroup,
	type TransactionFilter
} from '../transactions/aggregate';
import { listWallets } from '../wallets/repo';

/**
 * FN-54 /kalender reads. Each takes the space id the route admitted through `currentSpaceScope` (or, for closures,
 * the signed-in user's own id) and is bounded: one month of day totals, one day's first list page, at most 31
 * closures, at most 100 subscriptions and the space's series list (capped at 100). No read takes an id from the
 * request. The figures go through the FN-05 aggregates unchanged, so a day's figure equals Riwayat's for that day.
 */

const filter = (from: string, to: string, type: TransactionFilter['type']): TransactionFilter => ({
	from,
	to,
	type,
	categoryId: null,
	walletId: null,
	q: null
});

export interface CalendarSpending {
	/** The favourite wallet's currency (Beranda's hero currency), IDR without wallets. */
	currency: string;
	days: HeatDay[];
	/** Some day of the month has money in another currency (not counted in the cells). */
	otherCurrencies: boolean;
}

/** Expense per WIB day of `month` in the favourite wallet's currency (demo rows never count). */
export async function calendarSpending(
	db: Db,
	spaceId: string,
	month: string,
	today: string
): Promise<CalendarSpending> {
	const { from, to } = monthRange(month);
	const [wallets, daily] = await Promise.all([
		listWallets(db, spaceId),
		dailyTotals(db, spaceId, filter(from, to, 'expense'))
	]);
	const currency = wallets.find((w) => w.isFavourite)?.currency ?? 'IDR';
	return {
		currency,
		days: heatmapDays(daily, month, today, currency, 'outMinor'),
		otherCurrencies: daily.some((d) =>
			d.totals.some((t) => t.currency !== currency && t.outMinor !== 0)
		)
	};
}

/** The signed-in account's own closed days in `month` (never another member's). */
export function calendarClosures(db: Db, userId: string, month: string): Promise<string[]> {
	const { from, to } = monthRange(month);
	return closedDatesIn(db, userId, from, to);
}

/** The space's live subscriptions and recurring series, read once (no per-item query). */
export async function calendarSchedules(
	db: Db,
	spaceId: string,
	today: string
): Promise<{ subscriptions: DueSubscription[]; series: DueSeries[] }> {
	const [subscriptions, series] = await Promise.all([
		listSubscriptions(db, spaceId, today),
		listSeries(db, spaceId)
	]);
	return {
		subscriptions: subscriptions.map((s) => ({
			id: s.id,
			name: s.name,
			amountMinor: s.amountMinor,
			currency: s.currency,
			schedule: s.schedule,
			nextChargeOn: s.nextChargeOn,
			walletName: s.walletName,
			isDemo: s.isDemo
		})),
		series: series.map((r) => ({
			id: r.id,
			type: r.type,
			title: r.title,
			category: r.category && { name: r.category.name, isPreset: r.category.isPreset },
			amountMinor: r.amountMinor,
			currency: r.currency,
			schedule: r.schedule,
			startOn: r.startOn,
			endOn: r.endOn,
			nextRunOn: r.nextRunOn,
			status: r.status,
			walletName: r.walletName
		}))
	};
}

/** The day's rows: Riwayat's one-day view (every type, first page, same order), and whether more pages follow. */
export async function calendarDayRows(
	db: Db,
	spaceId: string,
	day: string
): Promise<{ group: DayGroup | null; hasMore: boolean }> {
	const page = await listTransactionsByDay(db, spaceId, filter(day, day, null), {
		limit: PAGE_SIZE
	});
	return { group: page.days[0] ?? null, hasMore: page.nextCursor !== null };
}
