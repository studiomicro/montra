import type { z } from 'zod';
import type { CategorySummary } from '../categories/repo';
import type { Budget } from '../budgets/repo';
import type { LaporanReport } from '../reports/laporan';
import type { SpaceSummary } from '../spaces/spaces';
import type { PeriodTotals, TransactionListRow } from '../transactions/aggregate';
import type { TransactionDetail } from '../transactions/repo';
import type { WalletSummary } from '../wallets/repo';
import type {
	apiBudget,
	apiCategory,
	apiLaporanSummary,
	apiSpace,
	apiTotals,
	apiTransaction,
	apiTransactionRow,
	apiWallet
} from './schemas';

/**
 * FN-38: stored rows as the public API shows them (snake_case, money as integer minor units with their
 * currency, instants as epoch milliseconds, `occurred_on` the WIB date as stored). Field by field, so a column
 * added to a repo type never leaks into an answer by accident.
 */

export const spaceOut = (s: SpaceSummary): z.infer<typeof apiSpace> => ({
	id: s.id,
	kind: s.kind,
	name: s.name,
	role: s.role
});

export const walletOut = (w: WalletSummary): z.infer<typeof apiWallet> => ({
	id: w.id,
	name: w.name,
	type: w.type,
	currency: w.currency,
	opening_balance_minor: w.openingBalanceMinor,
	is_favourite: w.isFavourite,
	last_four: w.lastFour,
	archived: w.archived,
	created_at: w.createdAt,
	updated_at: w.updatedAt
});

export const categoryOut = (c: CategorySummary): z.infer<typeof apiCategory> => ({
	id: c.id,
	kind: c.kind,
	name: c.name,
	tile_key: c.tileKey,
	is_preset: c.isPreset,
	is_hidden: c.isHidden
});

const patunganOut = (p: TransactionListRow['patungan']) =>
	p ? { split_id: p.splitId, effective_amount_minor: p.effectiveAmountMinor } : null;

export const rowOut = (r: TransactionListRow): z.infer<typeof apiTransactionRow> => ({
	id: r.id,
	type: r.type,
	amount_minor: r.amountMinor,
	currency: r.currency,
	title: r.title,
	occurred_on: r.occurredOn,
	occurred_at: r.occurredAt,
	source: r.source,
	is_demo: r.isDemo,
	category: r.category
		? { id: r.category.id, name: r.category.name, tile_key: r.category.tileKey }
		: null,
	wallet: { id: r.wallet.id, name: r.wallet.name },
	transfer_to_wallet: r.toWallet ? { id: r.toWallet.id, name: r.toWallet.name } : null,
	adjustment_direction: r.adjustmentDirection,
	recurring_series_id: r.recurringSeriesId,
	patungan: patunganOut(r.patungan)
});

export const detailOut = (t: TransactionDetail): z.infer<typeof apiTransaction> => ({
	id: t.id,
	type: t.type,
	amount_minor: t.amountMinor,
	currency: t.currency,
	wallet_id: t.walletId,
	transfer_to_wallet_id: t.transferToWalletId,
	category_id: t.categoryId,
	adjustment_direction: t.adjustmentDirection,
	title: t.title,
	note: t.note,
	occurred_on: t.occurredOn,
	occurred_at: t.occurredAt,
	source: t.source,
	is_demo: t.isDemo,
	recurring_series_id: t.recurringSeriesId,
	patungan: patunganOut(t.patungan),
	updated_at: t.updatedAt
});

export const totalsOut = (t: PeriodTotals): z.infer<typeof apiTotals> => ({
	count: t.count,
	expense_count: t.expenseCount,
	income_count: t.incomeCount,
	transfer_count: t.transferCount,
	adjustment_count: t.adjustmentCount,
	by_currency: t.totals.map((c) => ({
		currency: c.currency,
		in_minor: c.inMinor,
		out_minor: c.outMinor
	}))
});

export const budgetOut = (b: Budget | null): z.infer<typeof apiBudget> | null =>
	b ? { amount_minor: b.amountMinor, currency: b.currency, updated_at: b.updatedAt } : null;

/** One month's Laporan figures: totals, the direction's categories and the month-before comparison. */
export function laporanOut(r: LaporanReport): z.infer<typeof apiLaporanSummary> {
	if (r.detail.mode !== 'bulan') throw new RangeError('month view expected');
	return {
		month: r.detail.month,
		from: r.from,
		to: r.to,
		direction: r.view.direction,
		currency: r.currency,
		totals: r.stats.map((s) => ({
			currency: s.currency,
			in_minor: s.inMinor,
			out_minor: s.outMinor,
			net_minor: s.netMinor
		})),
		direction_total_minor: r.directionMinor,
		categories: r.categories.map((c) => ({
			category_id: c.key === '' ? null : c.key,
			name: c.name,
			tile_key: c.tileKey,
			amount_minor: c.minor,
			percent: c.percent
		})),
		comparison: { previous_month: r.detail.previousMonth, diff_minor: r.detail.lines.diffMinor },
		other_currencies: r.otherCurrencies
	};
}
