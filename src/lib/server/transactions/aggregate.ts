import { sql, type SQL } from 'drizzle-orm';
import type { ExportRow } from '#lib/shared/csv';
import { addDays, daysBetween, isDateString } from '#lib/shared/dates';
import type {
	AdjustmentDirection,
	TileKey,
	TransactionSource,
	TransactionType
} from '#lib/shared/transactions';
import type { Db } from '../db';
import { isLiveMember, type SpaceScope } from '../spaces/access';

/**
 * The totals contract (FN-05). `periodTotals` and `listTransactionsByDay` are the only functions that sum or
 * list `transactions`: Riwayat calls them, and Beranda (FN-08), Laporan (FN-09) and budgets (FN-07) must call
 * them unchanged with the same filter, so a figure always equals the list it links to. `dailyTotals` and
 * `categoryTotals` (added for Beranda's charts, FN-08) are the same sum split by day or category, built on
 * the same WHERE clause and fold; Laporan (FN-09) adds `monthlyTotals` (split by WIB month) and
 * `merchantTotals` (top merchants), on the same clause too; the money-flow chart (FN-35) adds `moneyFlowTotals`
 * (split by category and wallet).
 *
 * Rules, applied in SQL: only live rows of the one space; `Data demo` rows are listed (badged) but never
 * counted or summed; bucketed by `occurred_on` (the WIB date), never a UTC
 * date; only expense and income rows are money in or out — transfers and balance adjustments (FN-37) are
 * listed and counted, never summed (an adjustment moves its wallet's balance only: wallet-sum.ts); money is
 * summed per currency, never across currencies; a row linked to a split (FN-49 Patungan) counts only the payer's
 * own share (`EFFECTIVE_AMOUNT`), never its full stored amount.
 */
export interface TransactionFilter {
	/** First and last WIB date (inclusive); at most MAX_FILTER_DAYS apart, so every scan has a period. */
	from: string;
	to: string;
	/**
	 * Only expense, income, transfer or balance-adjustment rows; null for every row. Transfers and adjustments
	 * never count as money in or out, so a filter on either has a count and no money totals.
	 */
	type: TransactionType | null;
	categoryId: string | null;
	/** Rows paid from, received into, or transferred from or to this wallet. */
	walletId: string | null;
	/** Substring of the title or note (case-insensitive for ASCII); null or '' for no search. */
	q: string | null;
	/** "Aktif berulang" (FN-36): only rows created by a live series of the space that is still active. */
	recurringOnly?: boolean;
}

/** Longest period one filter covers (a year, leap day included). */
export const MAX_FILTER_DAYS = 366;
/** Riwayat page size (owner decision A). */
export const PAGE_SIZE = 50;

/** Money in and out in one currency. Both are positive magnitudes. */
/**
 * Money in and out in one currency, both positive magnitudes. `null` when the exact sum is past
 * Number.MAX_SAFE_INTEGER: shown as "too large", never rounded and never a failed page.
 */
export interface CurrencyTotals {
	currency: string;
	inMinor: number | null;
	outMinor: number | null;
}

export interface PeriodTotals {
	/** Rows matching the filter (transfers and adjustments included when the filter does not pick a type). */
	count: number;
	expenseCount: number;
	incomeCount: number;
	transferCount: number;
	adjustmentCount: number;
	/** IDR first, then by currency code; a currency appears only when it has income or expense. */
	totals: CurrencyTotals[];
}

export interface TransactionListRow {
	id: string;
	type: TransactionType;
	amountMinor: number;
	currency: string;
	title: string | null;
	occurredOn: string;
	occurredAt: number;
	source: TransactionSource;
	/** Fictional local-review row: listed with a "Data demo" badge, never counted in a total. */
	isDemo: boolean;
	category: { id: string; name: string; tileKey: TileKey; isPreset: boolean } | null;
	wallet: { id: string; name: string };
	toWallet: { id: string; name: string } | null;
	/** Set exactly on a balance adjustment (FN-37): which way it moved the wallet. */
	adjustmentDirection: AdjustmentDirection | null;
	/** The recurring series that created the row (FN-36), for its "Berulang" badge; null otherwise. */
	recurringSeriesId: string | null;
	/**
	 * FN-49: the split this row is the bill (or the payer's own share) of, and what it counts in every total
	 * (`effectiveAmountMinor`; `amountMinor` above stays the stored amount). Null for every other row.
	 */
	patungan: { splitId: string; effectiveAmountMinor: number } | null;
}

export interface DayGroup {
	/** WIB date `YYYY-MM-DD`. */
	date: string;
	/** The whole day's money in and out for the same filter (not just the rows on this page). */
	totals: CurrencyTotals[];
	rows: TransactionListRow[];
}

export interface TransactionPage {
	days: DayGroup[];
	/** Pass back as `cursor` for the next page; null on the last page. */
	nextCursor: string | null;
}

/** Throws unless the filter names a real, bounded period: a programming error, never user input (routes clamp). */
function assertBounded(filter: TransactionFilter) {
	if (!isDateString(filter.from) || !isDateString(filter.to)) throw new RangeError('bad period');
	const span = daysBetween(filter.from, filter.to);
	if (span < 0 || span >= MAX_FILTER_DAYS) throw new RangeError('period out of range');
}

/** The one WHERE clause for both functions (table alias `t`). Substring search uses instr(), never LIKE. */
function filterWhere(spaceId: string, filter: TransactionFilter): SQL {
	assertBounded(filter);
	const parts: SQL[] = [
		sql`t.space_id = ${spaceId}`,
		sql`t.deleted_at is null`,
		sql`t.occurred_on >= ${filter.from}`,
		sql`t.occurred_on <= ${filter.to}`
	];
	if (filter.type) parts.push(sql`t.type = ${filter.type}`);
	if (filter.categoryId) parts.push(sql`t.category_id = ${filter.categoryId}`);
	if (filter.walletId)
		parts.push(
			sql`(t.wallet_id = ${filter.walletId} or t.transfer_to_wallet_id = ${filter.walletId})`
		);
	if (filter.recurringOnly)
		parts.push(sql`t.recurring_series_id in (select r.id from recurring_transactions r
			where r.space_id = ${spaceId} and r.status = 'active' and r.deleted_at is null)`);
	const q = filter.q?.toLowerCase();
	if (q)
		parts.push(
			sql`(instr(lower(coalesce(t.title, '')), ${q}) > 0 or instr(lower(coalesce(t.note, '')), ${q}) > 0)`
		);
	return sql.join(parts, sql` and `);
}

/**
 * SQL (alias `t`): the rows that are money in or out. Every sum below uses it, so a transfer or a balance
 * adjustment (FN-37) — and any type added later — is never counted as spending or income by default.
 */
const MONEY_ROWS = sql`t.type in ('expense', 'income')`;

/**
 * SQL (alias `t`): what a row adds to a sum or ranks by. FN-49: a bill linked to a split counts only the payer's
 * own share (`patungan_effective_amount_minor`); every other row (no link: null) its stored `amount_minor`. Used
 * by every sum and money ordering in this file — never for display (a listed row still shows `amount_minor`) and
 * deliberately not by `frequentManualTransactions` ("Catat lagi" copies a real row) or
 * `listTransactionsForExport` (the CSV is the literal ledger). Wallet balances (wallet-sum.ts) keep the stored
 * amount too: the wallet really paid the whole bill.
 */
const EFFECTIVE_AMOUNT = sql`coalesce(t.patungan_effective_amount_minor, t.amount_minor)`;

/** An exact SQL sum (sent as text, so no digit is lost on the way) as a number; null past the safe range. */
export function safeMinor(total: bigint): number | null {
	return total <= BigInt(Number.MAX_SAFE_INTEGER) && total >= -BigInt(Number.MAX_SAFE_INTEGER)
		? Number(total)
		: null;
}

const byCurrency = (a: CurrencyTotals, b: CurrencyTotals) =>
	a.currency === b.currency
		? 0
		: a.currency === 'IDR'
			? -1
			: b.currency === 'IDR'
				? 1
				: a.currency < b.currency
					? -1
					: 1;

interface SumRow {
	type: TransactionType;
	currency: string;
	n: number;
	/** `CAST(SUM(...) AS TEXT)`: exact even past 2^53. */
	total: string;
}

/**
 * Folds `(type, currency) → n, sum` rows into per-currency in/out totals: only income and expense are summed;
 * transfers and balance adjustments (FN-37) are counted by the callers, never summed.
 */
function foldTotals(rows: SumRow[]): CurrencyTotals[] {
	const map = new Map<string, { inMinor: bigint; outMinor: bigint }>();
	for (const r of rows) {
		if (r.type !== 'expense' && r.type !== 'income') continue;
		const t = map.get(r.currency) ?? { inMinor: 0n, outMinor: 0n };
		if (r.type === 'income') t.inMinor += BigInt(r.total);
		else t.outMinor += BigInt(r.total);
		map.set(r.currency, t);
	}
	return [...map]
		.map(([currency, t]) => ({
			currency,
			inMinor: safeMinor(t.inMinor),
			outMinor: safeMinor(t.outMinor)
		}))
		.sort(byCurrency);
}

/** Count and money in/out per currency of every row matching `filter`, aggregated in SQL. */
export async function periodTotals(
	db: Db,
	spaceId: string,
	filter: TransactionFilter
): Promise<PeriodTotals> {
	const rows = await db.all<SumRow>(sql`select t.type as type, t.currency as currency,
			count(*) as n, cast(sum(${EFFECTIVE_AMOUNT}) as text) as total
		from transactions t
		where ${filterWhere(spaceId, filter)} and t.is_demo = 0
		group by t.type, t.currency`);
	const count = (type: TransactionType) =>
		rows.filter((r) => r.type === type).reduce((n, r) => n + r.n, 0);
	const expenseCount = count('expense');
	const incomeCount = count('income');
	const transferCount = count('transfer');
	const adjustmentCount = count('adjustment');
	return {
		count: expenseCount + incomeCount + transferCount + adjustmentCount,
		expenseCount,
		incomeCount,
		transferCount,
		adjustmentCount,
		totals: foldTotals(rows)
	};
}

/** `occurred_on.occurred_at.id` of the last row shown: the keyset the next page continues after. */
const CURSOR = /^(\d{4}-\d{2}-\d{2})\.(\d{1,15})\.([0-9A-Za-z-]{1,64})$/;

function encodeCursor(row: { occurredOn: string; occurredAt: number; id: string }): string {
	return `${row.occurredOn}.${row.occurredAt}.${row.id}`;
}

/** A cursor from the URL; null when absent or malformed (the list then starts from the top). */
export function parseCursor(
	value: string | null
): { occurredOn: string; occurredAt: number; id: string } | null {
	const m = value ? CURSOR.exec(value) : null;
	if (!m) return null;
	return { occurredOn: m[1] as string, occurredAt: Number(m[2]), id: m[3] as string };
}

/** SQL (alias `t`): rows after `cursor` in newest-first order; empty for no or a malformed cursor. */
function keysetAfter(cursor: string | null): SQL {
	const after = parseCursor(cursor);
	return after
		? sql` and (t.occurred_on < ${after.occurredOn} or (t.occurred_on = ${after.occurredOn}
			and (t.occurred_at < ${after.occurredAt} or (t.occurred_at = ${after.occurredAt}
			and t.id < ${after.id}))))`
		: sql``;
}

interface ListRow {
	id: string;
	type: TransactionType;
	amount_minor: number;
	currency: string;
	title: string | null;
	occurred_on: string;
	occurred_at: number;
	source: TransactionSource;
	is_demo: number;
	category_id: string | null;
	category_name: string | null;
	category_tile: TileKey | null;
	category_preset: number | null;
	wallet_id: string;
	wallet_name: string | null;
	to_wallet_id: string | null;
	to_wallet_name: string | null;
	adjustment_direction: AdjustmentDirection | null;
	recurring_series_id: string | null;
	patungan_split_id: string | null;
	patungan_effective_amount_minor: number | null;
}

/** The columns and joins of one listed row (table alias `t`); every join stays inside the row's space. */
const LIST_SELECT = sql`select t.id, t.type, t.amount_minor, t.currency, t.title,
			t.occurred_on, t.occurred_at, t.source, t.is_demo,
			c.id as category_id, c.name as category_name, c.tile_key as category_tile,
			c.is_preset as category_preset,
			t.wallet_id, w.name as wallet_name,
			t.transfer_to_wallet_id as to_wallet_id, tw.name as to_wallet_name,
			t.adjustment_direction, t.recurring_series_id,
			t.patungan_split_id, t.patungan_effective_amount_minor
		from transactions t
		left join categories c on c.id = t.category_id and c.space_id = t.space_id
		left join wallets w on w.id = t.wallet_id and w.space_id = t.space_id
		left join wallets tw on tw.id = t.transfer_to_wallet_id and tw.space_id = t.space_id`;

function listRow(r: ListRow): TransactionListRow {
	return {
		id: r.id,
		type: r.type,
		amountMinor: r.amount_minor,
		currency: r.currency,
		title: r.title,
		occurredOn: r.occurred_on,
		occurredAt: r.occurred_at,
		source: r.source,
		isDemo: r.is_demo === 1,
		category:
			r.category_id && r.category_name !== null && r.category_tile
				? {
						id: r.category_id,
						name: r.category_name,
						tileKey: r.category_tile,
						isPreset: r.category_preset === 1
					}
				: null,
		wallet: { id: r.wallet_id, name: r.wallet_name ?? '' },
		toWallet: r.to_wallet_id ? { id: r.to_wallet_id, name: r.to_wallet_name ?? '' } : null,
		adjustmentDirection: r.adjustment_direction,
		recurringSeriesId: r.recurring_series_id,
		patungan:
			r.patungan_split_id !== null && r.patungan_effective_amount_minor !== null
				? { splitId: r.patungan_split_id, effectiveAmountMinor: r.patungan_effective_amount_minor }
				: null
	};
}

/**
 * One page (at most `limit` rows, newest first: WIB date, then time, then id) of the rows matching `filter`,
 * grouped by WIB date. Pages continue with a keyset cursor, so "Muat lebih banyak" never repeats or skips a
 * row. Each day carries its whole-day totals for the same filter, so a day split over two pages shows the
 * same header on both.
 */
export async function listTransactionsByDay(
	db: Db,
	spaceId: string,
	filter: TransactionFilter,
	opts: { cursor?: string | null; limit?: number } = {}
): Promise<TransactionPage> {
	const limit = Math.min(Math.max(1, opts.limit ?? PAGE_SIZE), PAGE_SIZE);
	const where = filterWhere(spaceId, filter);
	const keyset = keysetAfter(opts.cursor ?? null);
	const rows = await db.all<ListRow>(sql`${LIST_SELECT}
		where ${where}${keyset}
		order by t.occurred_on desc, t.occurred_at desc, t.id desc
		limit ${limit + 1}`);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const nextCursor =
		rows.length > limit && last
			? encodeCursor({ occurredOn: last.occurred_on, occurredAt: last.occurred_at, id: last.id })
			: null;

	const dates = [...new Set(page.map((r) => r.occurred_on))];
	const dayRows =
		dates.length === 0
			? []
			: await db.all<SumRow & { day: string }>(sql`select t.occurred_on as day, t.type as type,
					t.currency as currency, count(*) as n, cast(sum(${EFFECTIVE_AMOUNT}) as text) as total
				from transactions t
				where ${where} and ${MONEY_ROWS} and t.is_demo = 0
					and t.occurred_on in (select value from json_each(${JSON.stringify(dates)}))
				group by t.occurred_on, t.type, t.currency`);

	const days: DayGroup[] = dates.map((date) => ({
		date,
		totals: foldTotals(dayRows.filter((r) => r.day === date)),
		rows: []
	}));
	const byDate = new Map(days.map((d) => [d.date, d]));
	for (const r of page) byDate.get(r.occurred_on)?.rows.push(listRow(r));
	return { days, nextCursor };
}

/** Money in and out per currency on one WIB date. */
export interface DayTotals {
	date: string;
	totals: CurrencyTotals[];
}

/**
 * `periodTotals` split by WIB date (`occurred_on`), oldest first, for the same filter (demo rows never count): only dates with income
 * or expense appear (transfers never count). Grouped in SQL, at most MAX_FILTER_DAYS dates.
 */
export async function dailyTotals(
	db: Db,
	spaceId: string,
	filter: TransactionFilter
): Promise<DayTotals[]> {
	const rows = await db.all<SumRow & { day: string }>(sql`select t.occurred_on as day,
			t.type as type, t.currency as currency, count(*) as n, cast(sum(${EFFECTIVE_AMOUNT}) as text) as total
		from transactions t
		where ${filterWhere(spaceId, filter)} and ${MONEY_ROWS} and t.is_demo = 0
		group by t.occurred_on, t.type, t.currency
		order by t.occurred_on`);
	const byDay = new Map<string, SumRow[]>();
	for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
	return [...byDay].map(([date, dayRows]) => ({ date, totals: foldTotals(dayRows) }));
}

/** Money in and out per currency of one category (null: rows without a category). */
export interface CategoryTotals {
	category: { id: string; name: string; tileKey: TileKey; isPreset: boolean } | null;
	totals: CurrencyTotals[];
}

interface CategorySumRow extends SumRow {
	category_id: string | null;
	category_name: string | null;
	category_tile: TileKey | null;
	category_preset: number | null;
}

function categoryOf(r: CategorySumRow): CategoryTotals['category'] {
	return r.category_id && r.category_name !== null && r.category_tile
		? {
				id: r.category_id,
				name: r.category_name,
				tileKey: r.category_tile,
				isPreset: r.category_preset === 1
			}
		: null;
}

/**
 * `periodTotals` split by category for the same filter (transfers and demo rows never count). Grouped in SQL; at most one
 * entry per category of the space (capped at 100) plus one for rows without a category.
 */
export async function categoryTotals(
	db: Db,
	spaceId: string,
	filter: TransactionFilter
): Promise<CategoryTotals[]> {
	const rows = await db.all<CategorySumRow>(sql`select t.category_id as category_id,
			c.name as category_name, c.tile_key as category_tile, c.is_preset as category_preset,
			t.type as type, t.currency as currency, count(*) as n, cast(sum(${EFFECTIVE_AMOUNT}) as text) as total
		from transactions t
		left join categories c on c.id = t.category_id and c.space_id = t.space_id
		where ${filterWhere(spaceId, filter)} and ${MONEY_ROWS} and t.is_demo = 0
		group by t.category_id, t.type, t.currency`);
	const byCategory = new Map<string, CategorySumRow[]>();
	for (const r of rows) {
		const key = r.category_id ?? '';
		byCategory.set(key, [...(byCategory.get(key) ?? []), r]);
	}
	return [...byCategory.values()].map((group) => {
		const first = group[0] as CategorySumRow;
		return { category: categoryOf(first), totals: foldTotals(group) };
	});
}

/** Money in and out per currency in one WIB month. */
export interface MonthTotals {
	/** `YYYY-MM` of `occurred_on`. */
	month: string;
	totals: CurrencyTotals[];
}

/**
 * `periodTotals` split by WIB month (`substr(occurred_on, 1, 7)`), oldest first, for the same filter (transfers
 * and demo rows never count): only months with income or expense appear. Grouped in SQL; a filter spans at
 * most MAX_FILTER_DAYS, so at most 13 months.
 */
export async function monthlyTotals(
	db: Db,
	spaceId: string,
	filter: TransactionFilter
): Promise<MonthTotals[]> {
	const rows = await db.all<SumRow & { month: string }>(sql`select
			substr(t.occurred_on, 1, 7) as month, t.type as type, t.currency as currency, count(*) as n,
			cast(sum(${EFFECTIVE_AMOUNT}) as text) as total
		from transactions t
		where ${filterWhere(spaceId, filter)} and ${MONEY_ROWS} and t.is_demo = 0
		group by month, t.type, t.currency
		order by month`);
	const byMonth = new Map<string, SumRow[]>();
	for (const r of rows) byMonth.set(r.month, [...(byMonth.get(r.month) ?? []), r]);
	return [...byMonth].map(([month, monthRows]) => ({ month, totals: foldTotals(monthRows) }));
}

/** Most merchants one call returns (owner decision C: a top 10, never an exhaustive list). */
export const MAX_MERCHANTS = 10;

/** One merchant group of `merchantTotals`. */
export interface MerchantTotal {
	/** The smallest raw title of the group, trimmed; null for rows without a title ("Tanpa judul"). */
	title: string | null;
	count: number;
	/** Exact sum; null when past Number.MAX_SAFE_INTEGER ("too large to show"). */
	amountMinor: number | null;
}

/**
 * The top `limit` merchants (at most MAX_MERCHANTS) of one direction in one currency, largest first, for the
 * same filter as `periodTotals` (`filter.type` must be expense or income; demo rows never count). A merchant
 * is the title compared case-insensitively (ASCII) with surrounding whitespace (space, tab, CR, LF) ignored,
 * by equality, never a LIKE pattern; blank and missing titles form one group. Grouped, ordered and cut in SQL.
 */
export async function merchantTotals(
	db: Db,
	spaceId: string,
	filter: TransactionFilter,
	currency: string,
	limit = MAX_MERCHANTS
): Promise<MerchantTotal[]> {
	if (filter.type !== 'expense' && filter.type !== 'income')
		throw new RangeError('direction needed');
	const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_MERCHANTS);
	const rows = await db.all<{ title: string | null; n: number; total: string }>(sql`select
			min(m.title) as title, count(*) as n, cast(sum(m.amount_minor) as text) as total
		from (select trim(coalesce(t.title, ''), ' ' || char(9, 10, 13)) as title,
				${EFFECTIVE_AMOUNT} as amount_minor
			from transactions t
			where ${filterWhere(spaceId, filter)} and t.is_demo = 0 and t.currency = ${currency}) m
		group by lower(m.title)
		order by sum(m.amount_minor) desc, lower(m.title)
		limit ${cap}`);
	return rows.map((r) => ({
		title: r.title ? r.title : null,
		count: r.n,
		amountMinor: safeMinor(BigInt(r.total))
	}));
}

/** Money in and out per currency of one category in one WIB month. */
export interface CategoryMonthTotals {
	month: string;
	category: CategoryTotals['category'];
	totals: CurrencyTotals[];
}

/**
 * `categoryTotals` split again by WIB month (Laporan's yearly charts): the same WHERE clause and fold, transfers
 * and demo rows never count. Grouped in SQL; at most (100 categories + 1) × 13 months entries.
 */
export async function categoryMonthlyTotals(
	db: Db,
	spaceId: string,
	filter: TransactionFilter
): Promise<CategoryMonthTotals[]> {
	const rows = await db.all<CategorySumRow & { month: string }>(sql`select
			substr(t.occurred_on, 1, 7) as month, t.category_id as category_id,
			c.name as category_name, c.tile_key as category_tile, c.is_preset as category_preset,
			t.type as type, t.currency as currency, count(*) as n, cast(sum(${EFFECTIVE_AMOUNT}) as text) as total
		from transactions t
		left join categories c on c.id = t.category_id and c.space_id = t.space_id
		where ${filterWhere(spaceId, filter)} and ${MONEY_ROWS} and t.is_demo = 0
		group by month, t.category_id, t.type, t.currency
		order by month`);
	const groups = new Map<string, (CategorySumRow & { month: string })[]>();
	for (const r of rows) {
		const key = `${r.month}|${r.category_id ?? ''}`;
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	return [...groups.values()].map((group) => {
		const first = group[0] as CategorySumRow & { month: string };
		return { month: first.month, category: categoryOf(first), totals: foldTotals(group) };
	});
}

/** Most rows `largestTransactions` returns. */
const MAX_LARGEST = 5;

/**
 * The `limit` (at most MAX_LARGEST) largest single rows of one direction in one currency, for the same filter
 * as `periodTotals` (demo rows never count). Largest first, then newest, then id; ordered and cut in SQL.
 */
export async function largestTransactions(
	db: Db,
	spaceId: string,
	filter: TransactionFilter,
	currency: string,
	limit = MAX_LARGEST
): Promise<TransactionListRow[]> {
	if (filter.type !== 'expense' && filter.type !== 'income')
		throw new RangeError('direction needed');
	const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_LARGEST);
	const rows = await db.all<ListRow>(sql`${LIST_SELECT}
		where ${filterWhere(spaceId, filter)} and t.is_demo = 0 and t.currency = ${currency}
		order by ${EFFECTIVE_AMOUNT} desc, t.occurred_on desc, t.occurred_at desc, t.id desc
		limit ${cap}`);
	return rows.map(listRow);
}

/** Days "Catat lagi" looks back (FN-14): a bounded period, like every other scan here. */
const FREQUENT_LOOKBACK_DAYS = 90;
/** Most "Catat lagi" buttons (FN-14). */
export const MAX_FREQUENT = 5;

/** One "Catat lagi" button: a repeated manual or voice expense/income and its most recent row. */
export interface FrequentTransaction {
	/** The group's most recent transaction (what "Catat lagi" copies). */
	id: string;
	type: 'expense' | 'income';
	amountMinor: number;
	currency: string;
	title: string | null;
	count: number;
	category: { name: string; tileKey: TileKey; isPreset: boolean };
	walletName: string;
}

/**
 * The top `limit` (at most MAX_FREQUENT) groups of identical (title, category, wallet, amount, currency, type)
 * among live, real (never `Data demo`) `manual`/`voice` expense and income rows of the last
 * FREQUENT_LOOKBACK_DAYS WIB days up to `today`, most frequent first, then most recent. Only groups whose wallet
 * is still live and whose category is still visible appear, so a button never copies a row it cannot save.
 * Grouped, ordered and cut in SQL; the bare `id` column comes from the group's latest row (SQLite's documented
 * bare-column rule for a query with a single max()).
 */
export async function frequentManualTransactions(
	db: Db,
	spaceId: string,
	{ limit, today }: { limit: number; today: string }
): Promise<FrequentTransaction[]> {
	const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_FREQUENT);
	const filter: TransactionFilter = {
		from: addDays(today, -(FREQUENT_LOOKBACK_DAYS - 1)),
		to: today,
		type: null,
		categoryId: null,
		walletId: null,
		q: null
	};
	const rows = await db.all<{
		id: string;
		type: 'expense' | 'income';
		amountMinor: number;
		currency: string;
		title: string | null;
		n: number;
		categoryName: string;
		tileKey: TileKey;
		isPreset: number;
		walletName: string;
	}>(sql`select t.id as id, t.type as type, t.amount_minor as amountMinor, t.currency as currency,
			t.title as title, count(*) as n, max(t.occurred_at) as lastAt, c.name as categoryName,
			c.tile_key as tileKey, c.is_preset as isPreset, w.name as walletName
		from transactions t
		join wallets w on w.id = t.wallet_id and w.space_id = t.space_id and w.deleted_at is null
		join categories c on c.id = t.category_id and c.space_id = t.space_id and c.deleted_at is null
			and c.is_hidden = 0 and c.kind = t.type
		where ${filterWhere(spaceId, filter)} and ${MONEY_ROWS} and t.is_demo = 0
			and t.source in ('manual', 'voice')
		group by t.title, t.category_id, t.wallet_id, t.amount_minor, t.currency, t.type
		order by n desc, lastAt desc
		limit ${cap}`);
	return rows.map((r) => ({
		id: r.id,
		type: r.type,
		amountMinor: r.amountMinor,
		currency: r.currency,
		title: r.title,
		count: r.n,
		category: { name: r.categoryName, tileKey: r.tileKey, isPreset: Boolean(r.isPreset) },
		walletName: r.walletName
	}));
}

/** Rows one export page reads (FN-18): a one-year export of a full space is at most 100 pages. */
const EXPORT_PAGE_SIZE = 1000;

interface ExportSqlRow {
	id: string;
	type: 'expense' | 'income';
	amount_minor: number;
	currency: string;
	title: string | null;
	note: string | null;
	occurred_on: string;
	occurred_at: number;
	category_name: string | null;
	wallet_name: string | null;
	payment_method: string | null;
	recurrence: string | null;
	tag: string | null;
	reference: string | null;
}

/**
 * One page (at most EXPORT_PAGE_SIZE rows) of the export (FN-18): the same WHERE clause and newest-first keyset
 * as `listTransactionsByDay`, only expense and income rows (the template has no transfer or balance-adjustment
 * rows, FN-37) and without `Data demo`
 * rows (fictional rows never leave as real data). Every page re-checks that `scope.userId` is still a live member
 * (red team L5): once removed, a page is empty and the export ends. Continue with `nextCursor` until null.
 */
export async function listTransactionsForExport(
	db: Db,
	scope: SpaceScope,
	filter: TransactionFilter,
	cursor: string | null
): Promise<{ rows: ExportRow[]; nextCursor: string | null }> {
	const { spaceId, userId } = scope;
	const keyset = keysetAfter(cursor);
	const rows =
		await db.all<ExportSqlRow>(sql`select t.id, t.type, t.amount_minor, t.currency, t.title,
			t.note, t.occurred_on, t.occurred_at, c.name as category_name, w.name as wallet_name,
			t.payment_method, t.recurrence, t.tag, t.reference
		from transactions t
		left join categories c on c.id = t.category_id and c.space_id = t.space_id
		left join wallets w on w.id = t.wallet_id and w.space_id = t.space_id
		where ${filterWhere(spaceId, filter)} and ${MONEY_ROWS} and t.is_demo = 0
			and ${isLiveMember(spaceId, userId)}${keyset}
		order by t.occurred_on desc, t.occurred_at desc, t.id desc
		limit ${EXPORT_PAGE_SIZE + 1}`);
	const page = rows.slice(0, EXPORT_PAGE_SIZE);
	const last = page.at(-1);
	return {
		rows: page.map((r) => ({
			id: r.id,
			type: r.type,
			amountMinor: r.amount_minor,
			currency: r.currency,
			title: r.title,
			note: r.note,
			occurredOn: r.occurred_on,
			occurredAt: r.occurred_at,
			categoryName: r.category_name,
			walletName: r.wallet_name,
			paymentMethod: r.payment_method,
			recurrence: r.recurrence,
			tag: r.tag,
			reference: r.reference
		})),
		nextCursor:
			rows.length > EXPORT_PAGE_SIZE && last
				? encodeCursor({ occurredOn: last.occurred_on, occurredAt: last.occurred_at, id: last.id })
				: null
	};
}

/** Most groups `moneyFlowTotals` returns (far above what (categories + 1) × wallets reach in practice). */
export const MONEY_FLOW_MAX_GROUPS = 1000;

/** One group of `moneyFlowTotals`: money of one type between one category and one wallet, in one currency. */
export interface MoneyFlowRow {
	type: 'income' | 'expense';
	category: CategoryTotals['category'];
	wallet: { id: string; name: string };
	currency: string;
	count: number;
	/** Exact sum; null when past Number.MAX_SAFE_INTEGER ("too large to show"). */
	amountMinor: number | null;
}

/**
 * The money-flow split (FN-35): income rows grouped by (category, wallet) and expense rows grouped by (wallet,
 * category), summed per currency, for the same WHERE clause as `periodTotals`. Only the money types are
 * selected by name (`type in ('income', 'expense')`), so a transfer, or any type added later (a balance
 * adjustment), never enters a flow; demo rows never count. Grouped in SQL: at most (categories + 1) × wallets ×
 * currencies groups per type, and never more than MONEY_FLOW_MAX_GROUPS (the largest sums are kept and
 * `truncated` says some were left out, so a caller never shows a partial total as the whole).
 */
export async function moneyFlowTotals(
	db: Db,
	spaceId: string,
	filter: TransactionFilter
): Promise<{ rows: MoneyFlowRow[]; truncated: boolean }> {
	const rows = await db.all<
		CategorySumRow & { wallet_id: string; wallet_name: string | null }
	>(sql`select t.type as type, t.category_id as category_id,
			c.name as category_name, c.tile_key as category_tile, c.is_preset as category_preset,
			t.wallet_id as wallet_id, w.name as wallet_name,
			t.currency as currency, count(*) as n, cast(sum(${EFFECTIVE_AMOUNT}) as text) as total
		from transactions t
		left join categories c on c.id = t.category_id and c.space_id = t.space_id
		left join wallets w on w.id = t.wallet_id and w.space_id = t.space_id
		where ${filterWhere(spaceId, filter)} and t.type in ('income', 'expense') and t.is_demo = 0
		group by t.type, t.category_id, t.wallet_id, t.currency
		order by sum(${EFFECTIVE_AMOUNT}) desc, t.type, t.category_id, t.wallet_id, t.currency
		limit ${MONEY_FLOW_MAX_GROUPS + 1}`);
	const truncated = rows.length > MONEY_FLOW_MAX_GROUPS;
	return {
		rows: rows.slice(0, MONEY_FLOW_MAX_GROUPS).map((r) => ({
			type: r.type === 'income' ? 'income' : 'expense',
			category: categoryOf(r),
			wallet: { id: r.wallet_id, name: r.wallet_name ?? '' },
			currency: r.currency,
			count: r.n,
			amountMinor: safeMinor(BigInt(r.total))
		})),
		truncated
	};
}

/** One wallet's expense sum in one currency (`walletExpenseTotals`). */
export interface WalletExpenseTotal {
	walletId: string;
	currency: string;
	/** Exact sum, a positive magnitude; null when past Number.MAX_SAFE_INTEGER ("too large to show"). */
	outMinor: number | null;
}

/**
 * The expense rows paid from each of `walletIds` between `from` and `to` (WIB dates, inclusive), summed per
 * wallet and currency (FN-25b's credit-card "spent in the last 30 days"). The same WHERE clause as
 * `periodTotals` with `type: 'expense'`, so each figure equals Riwayat's list filtered to that wallet, type and
 * period; demo rows never count. The ids are bound once as JSON (no bound-parameter limit).
 */
export async function walletExpenseTotals(
	db: Db,
	spaceId: string,
	period: { from: string; to: string },
	walletIds: readonly string[]
): Promise<WalletExpenseTotal[]> {
	if (walletIds.length === 0) return [];
	const filter: TransactionFilter = {
		from: period.from,
		to: period.to,
		type: 'expense',
		categoryId: null,
		walletId: null,
		q: null
	};
	const rows = await db.all<{ wallet_id: string; currency: string; total: string }>(sql`select
			t.wallet_id as wallet_id, t.currency as currency, cast(sum(t.amount_minor) as text) as total
		from transactions t
		where ${filterWhere(spaceId, filter)} and t.is_demo = 0
			and t.wallet_id in (select value from json_each(${JSON.stringify(walletIds)}))
		group by t.wallet_id, t.currency
		order by t.wallet_id, t.currency`);
	return rows.map((r) => ({
		walletId: r.wallet_id,
		currency: r.currency,
		outMinor: safeMinor(BigInt(r.total))
	}));
}
