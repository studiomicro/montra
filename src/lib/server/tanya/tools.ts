import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import {
	addDays,
	daysBetween,
	formatShortMonth,
	monthOf,
	monthRange,
	monthsBetween,
	shiftMonth,
	yearToDateRange
} from '#lib/shared/dates';
import { msg, type Locale } from '#lib/shared/i18n';
import { monthlyTotals as subscriptionMonthlyTotals } from '#lib/shared/subscriptions';
import { TANYA_CARD_ROWS_MAX, type TanyaCard, type TanyaCardRow } from '#lib/shared/tanya';
import { cleanText } from '#lib/shared/text';
import { anggaranSummary } from '../budgets/anggaran';
import type { Db } from '../db';
import { listSeries } from '../recurring/repo';
import { floorPercent } from '../reports/laporan';
import { listSubscriptions } from '../subscriptions/repo';
import {
	categoryTotals,
	MAX_FILTER_DAYS,
	MAX_MERCHANTS,
	merchantTotals,
	monthlyTotals,
	periodTotals,
	safeMinor,
	type CurrencyTotals,
	type TransactionFilter
} from '../transactions/aggregate';
import { walletTransactionsSums } from '../transactions/wallet-sum';
import { balanceTotals, shownBalance } from '../wallets/balance';
import { listWallets } from '../wallets/repo';
import type { ToolDefinition } from './anthropic';
import { DEFINITIONS, NAME_MAX, PERIOD_PATTERN, TOOL_DEFINITIONS } from './definitions';
import { dataText } from './data-text.ts';
import { forModel, type Figure, type FigureBook } from './figures';

/**
 * Tanya's read-only tools (FN-22). `makeTools` closes over the session's space id: no tool takes a space id, a
 * user id or SQL from the model, and every input is checked by a strict zod schema (an extra field such as
 * `spaceId` refuses the call). Every figure is computed by the same helpers Beranda, Riwayat, Laporan, Dompet,
 * Anggaran and Langganan use (so they reconcile), aggregated in SQL over a bounded WIB period, and entered in the
 * question's FigureBook; the model receives figure ids and formatted text only. Stored text (merchant titles,
 * category, wallet and subscription names) is cleaned and capped before it reaches a tool result.
 */

/** A tool's answer: JSON for the model (a `tool_result`) and the card the page shows, if any. */
interface ToolResult {
	isError: boolean;
	content: string;
	card: TanyaCard | null;
}

export interface ToolSet {
	definitions: readonly ToolDefinition[];
	run(name: string, input: unknown): Promise<ToolResult>;
}

/** Query builders that can only read: `select` returns a builder with no write method. */
const READ_BUILDERS = new Set(['select', 'selectDistinct', '$count']);
/** Raw-SQL methods: allowed only for one statement that starts with SELECT. */
const RAW_READS = new Set(['all', 'get', 'values']);
const READ_STATEMENT = /^\s*select\b[^;]*;?\s*$/i;

/**
 * The database as the tools see it: an allowlist of reads (criterion 3). The query builders above, and `all`/`get`/
 * `values` with a single SELECT statement; every other property (`insert`, `update`, `delete`, `batch`, `run`,
 * `transaction`, `with`, `$client`, the raw D1 binding …) throws, so a tool (or a helper it calls) cannot change a
 * row even by mistake.
 */
export function readOnlyDb(db: Db): Db {
	const refuse = () => {
		throw new Error('read-only');
	};
	return new Proxy(db, {
		get(target, prop) {
			if (typeof prop === 'string' && READ_BUILDERS.has(prop))
				return (Reflect.get(target, prop) as (...a: unknown[]) => unknown).bind(target);
			if (typeof prop === 'string' && RAW_READS.has(prop)) {
				const method = Reflect.get(target, prop) as (q: SQL) => unknown;
				return (query: SQL) => {
					const text = (target as unknown as { dialect: SQLiteDialect }).dialect.sqlToQuery(
						query
					).sql;
					if (!READ_STATEMENT.test(text)) refuse();
					return method.call(target, query);
				};
			}
			return refuse();
		}
	});
}

/** Longest merchant title in a tool result (criterion 11). */
const TITLE_MAX = 80;

export { dataText } from './data-text.ts';

const periodInput = z.string().regex(new RegExp(PERIOD_PATTERN));
const categoryInput = z.string().min(1).max(NAME_MAX);

export interface PeriodRange {
	from: string;
	to: string;
}

/**
 * A period input → its WIB date range on `today`, or null when it is not one Tanya can scan: never longer than
 * MAX_FILTER_DAYS (criterion 4).
 */
export function resolvePeriod(period: string, today: string): PeriodRange | null {
	const month = monthOf(today);
	let range: PeriodRange;
	if (period === 'this_month') range = monthRange(month);
	else if (period === 'last_month') range = monthRange(shiftMonth(month, -1));
	else if (period === 'last_3_months')
		range = { from: monthRange(shiftMonth(month, -2)).from, to: monthRange(month).to };
	else if (period === 'this_year') range = yearToDateRange(today);
	else if (/^month:\d{4}-(0[1-9]|1[0-2])$/.test(period)) range = monthRange(period.slice(6));
	else return null;
	return boundedRange(range.from, range.to);
}

/** The range when it spans at most MAX_FILTER_DAYS days, else null. */
export function boundedRange(from: string, to: string): PeriodRange | null {
	const span = daysBetween(from, to);
	return span >= 0 && span < MAX_FILTER_DAYS ? { from, to } : null;
}

const filterOf = (
	range: PeriodRange,
	type: TransactionFilter['type'],
	categoryId: string | null = null
): TransactionFilter => ({
	from: range.from,
	to: range.to,
	type,
	categoryId,
	walletId: null,
	q: null
});

/** `in − out` exactly, or null when either is unknown or the difference is too large. */
function difference(a: number | null, b: number | null): number | null {
	return a === null || b === null ? null : safeMinor(BigInt(a) - BigInt(b));
}

const row = (label: string, figure: Figure | null, raw = false): TanyaCardRow[] =>
	figure ? [{ label, ...(raw ? { raw: true } : {}), value: figure.formatted }] : [];

const result = (model: unknown, card: TanyaCard | null = null): ToolResult => ({
	isError: false,
	content: JSON.stringify(model),
	card
});
const refuse = (error: string): ToolResult => ({
	isError: true,
	content: JSON.stringify({ error }),
	card: null
});

/** Most currencies one tool reports separately (each is its own figure; never summed across currencies). */
const MAX_CURRENCIES = 3;

/** Expense in `currency` (0 without rows; null, never 0, when it is too large to show). */
function outOf(totals: readonly CurrencyTotals[], currency: string): number | null {
	const t = totals.find((x) => x.currency === currency);
	return t ? t.outMinor : 0;
}

interface Context {
	db: Db;
	spaceId: string;
	today: string;
	locale: Locale;
	book: FigureBook;
}

/**
 * A category of the space by name: an exact case-insensitive (ASCII) match first, else the shortest name that
 * contains the words. Bound once, `instr` never LIKE; null when nothing matches (never a guess).
 */
async function findCategory(ctx: Context, name: string) {
	const needle = cleanText(name, NAME_MAX).toLowerCase();
	if (!needle) return null;
	const [found] = await ctx.db.all<{ id: string; name: string }>(sql`select id, name
		from categories
		where space_id = ${ctx.spaceId} and deleted_at is null and instr(lower(name), ${needle}) > 0
		order by lower(name) = ${needle} desc, length(name), id
		limit 1`);
	return found ?? null;
}

type Handler = (ctx: Context, input: never) => Promise<ToolResult>;

interface Tool {
	definition: ToolDefinition;
	schema: z.ZodType;
	handler: Handler;
}

function tool<S extends z.ZodType>(
	definition: ToolDefinition,
	schema: S,
	handler: (ctx: Context, input: z.infer<S>) => Promise<ToolResult>
): Tool {
	return { definition, schema, handler: handler as Handler };
}

const noInput = z.object({}).strict();

const TOOLS: readonly Tool[] = [
	tool(
		DEFINITIONS.spending_summary,
		z.object({ period: periodInput, category: categoryInput.optional() }).strict(),
		async (ctx, input) => {
			const range = resolvePeriod(input.period, ctx.today);
			if (!range) return refuse('period out of range');
			const category = input.category ? await findCategory(ctx, input.category) : null;
			if (input.category && !category)
				return result({ found: false, category: dataText(input.category, NAME_MAX) });
			const totals = await periodTotals(ctx.db, ctx.spaceId, filterOf(range, null, category?.id));
			const rows: TanyaCardRow[] = [];
			const currencies = totals.totals.slice(0, MAX_CURRENCIES).map((t) => {
				const income = ctx.book.money(`income ${t.currency}`, t.inMinor, t.currency);
				const expense = ctx.book.money(`expense ${t.currency}`, t.outMinor, t.currency);
				const net = ctx.book.money(
					`net ${t.currency}`,
					difference(t.inMinor, t.outMinor),
					t.currency
				);
				rows.push(
					...row(msg('Pemasukan'), income),
					...row(msg('Pengeluaran'), expense),
					...row(msg('Selisih'), net)
				);
				return {
					currency: t.currency,
					income: forModel(income),
					expense: forModel(expense),
					net: forModel(net)
				};
			});
			const name = category ? dataText(category.name, NAME_MAX) : null;
			return result(
				{
					period: range,
					category: name,
					expense_count: totals.expenseCount,
					income_count: totals.incomeCount,
					currencies
				},
				{
					title: msg('Ringkasan'),
					period: range,
					rows: name ? [{ label: name, raw: true, value: '' }, ...rows] : rows,
					chart: null
				}
			);
		}
	),
	tool(
		DEFINITIONS.spending_by_category,
		z.object({ period: periodInput, top: z.number().int().min(1).max(8).optional() }).strict(),
		async (ctx, input) => {
			const range = resolvePeriod(input.period, ctx.today);
			if (!range) return refuse('period out of range');
			const top = input.top ?? 5;
			const groups = await categoryTotals(ctx.db, ctx.spaceId, filterOf(range, 'expense'));
			const currencies = [...new Set(groups.flatMap((g) => g.totals.map((t) => t.currency)))].sort(
				(a, b) => (a === 'IDR' ? -1 : b === 'IDR' ? 1 : a < b ? -1 : 1)
			);
			const rows: TanyaCardRow[] = [];
			let chart: TanyaCard['chart'] = null;
			const model = currencies.slice(0, MAX_CURRENCIES).map((currency, index) => {
				const entries = groups
					.map((g) => ({ category: g.category, out: outOf(g.totals, currency) }))
					.filter((e) => e.out === null || e.out > 0)
					.sort((a, b) => (a.out === null ? -1 : b.out === null ? 1 : b.out - a.out));
				const shown = entries.slice(0, top);
				const rest = entries.slice(top);
				const restSum = rest.some((e) => e.out === null)
					? null
					: safeMinor(rest.reduce((s, e) => s + BigInt(e.out ?? 0), 0n));
				const items = shown.map((e) => {
					const name = e.category ? dataText(e.category.name, NAME_MAX) : null;
					const figure = ctx.book.money(`category ${currency}`, e.out, currency);
					rows.push(...row(name ?? msg('Tanpa kategori'), figure, name !== null));
					return { name, figure: forModel(figure), series: e.category?.tileKey ?? 'other' };
				});
				const other =
					rest.length > 0 ? ctx.book.money(`other ${currency}`, restSum, currency) : null;
				rows.push(...row(msg('Lainnya'), other));
				if (index === 0 && shown.every((e) => e.out !== null) && (other || rest.length === 0))
					chart = {
						type: 'donut',
						currency,
						slices: [
							...shown.map((e, i) => ({
								series: items[i]?.series ?? 'other',
								label: items[i]?.name ?? '',
								minor: e.out ?? 0
							})),
							...(restSum ? [{ series: 'other', label: '', minor: restSum }] : [])
						]
					};
				return {
					currency,
					categories: items.map(({ name, figure }) => ({ name, total: figure })),
					other: forModel(other)
				};
			});
			return result(
				{ period: range, currencies: model },
				{ title: msg('Pengeluaran per kategori'), period: range, rows, chart }
			);
		}
	),
	tool(
		DEFINITIONS.top_merchants,
		z
			.object({ period: periodInput, limit: z.number().int().min(1).max(MAX_MERCHANTS).optional() })
			.strict(),
		async (ctx, input) => {
			const range = resolvePeriod(input.period, ctx.today);
			if (!range) return refuse('period out of range');
			const filter = filterOf(range, 'expense');
			const totals = await periodTotals(ctx.db, ctx.spaceId, filter);
			const rows: TanyaCardRow[] = [];
			const currencies = [];
			for (const t of totals.totals.slice(0, MAX_CURRENCIES)) {
				const merchants = await merchantTotals(
					ctx.db,
					ctx.spaceId,
					filter,
					t.currency,
					input.limit ?? 5
				);
				currencies.push({
					currency: t.currency,
					merchants: merchants.map((m) => {
						const name = m.title ? dataText(m.title, TITLE_MAX) : null;
						const figure = ctx.book.money(`merchant ${t.currency}`, m.amountMinor, t.currency);
						rows.push(...row(name ?? msg('Tanpa judul'), figure, name !== null));
						return { name, count: m.count, total: forModel(figure) };
					})
				});
			}
			return result(
				{ period: range, currencies },
				{ title: msg('Tempat belanja teratas'), period: range, rows, chart: null }
			);
		}
	),
	tool(
		DEFINITIONS.compare_periods,
		z
			.object({
				period: periodInput,
				compare_to: periodInput,
				category: categoryInput.optional()
			})
			.strict(),
		async (ctx, input) => {
			const current = resolvePeriod(input.period, ctx.today);
			const previous = resolvePeriod(input.compare_to, ctx.today);
			if (!current || !previous) return refuse('period out of range');
			const category = input.category ? await findCategory(ctx, input.category) : null;
			if (input.category && !category)
				return result({ found: false, category: dataText(input.category, NAME_MAX) });
			const [a, b] = await Promise.all([
				periodTotals(ctx.db, ctx.spaceId, filterOf(current, 'expense', category?.id)),
				periodTotals(ctx.db, ctx.spaceId, filterOf(previous, 'expense', category?.id))
			]);
			const currencies = [...new Set([...a.totals, ...b.totals].map((t) => t.currency))]
				.sort((x, y) => (x === 'IDR' ? -1 : y === 'IDR' ? 1 : x < y ? -1 : 1))
				.slice(0, MAX_CURRENCIES);
			const rows: TanyaCardRow[] = [];
			let chart: TanyaCard['chart'] = null;
			const model = currencies.map((currency, index) => {
				const now = outOf(a.totals, currency);
				const then = outOf(b.totals, currency);
				const diff = difference(now, then);
				const fNow = ctx.book.money(`period ${currency}`, now, currency);
				const fThen = ctx.book.money(`compare_to ${currency}`, then, currency);
				const fDiff = ctx.book.money(`difference ${currency}`, diff, currency);
				const fPct = ctx.book.percent(`change ${currency}`, floorPercent(diff, then));
				rows.push(
					...row(msg('Periode ini'), fNow),
					...row(msg('Periode pembanding'), fThen),
					...row(msg('Selisih'), fDiff),
					...row(msg('Perubahan'), fPct)
				);
				if (index === 0 && now !== null && then !== null)
					chart = {
						type: 'bars',
						currency,
						bars: [
							{ label: shortLabel(previous, ctx.locale), minor: then },
							{ label: shortLabel(current, ctx.locale), minor: now }
						]
					};
				return {
					currency,
					period_total: forModel(fNow),
					compare_to_total: forModel(fThen),
					difference: forModel(fDiff),
					percent_change: forModel(fPct)
				};
			});
			return result(
				{
					period: current,
					compare_to: previous,
					category: category ? dataText(category.name, NAME_MAX) : null,
					currencies: model
				},
				{ title: msg('Perbandingan'), period: null, rows, chart }
			);
		}
	),
	tool(
		DEFINITIONS.monthly_trend,
		z.object({ months: z.number().int().min(1).max(6).optional() }).strict(),
		async (ctx, input) => {
			const last = monthOf(ctx.today);
			const first = shiftMonth(last, -((input.months ?? 3) - 1));
			const range = boundedRange(monthRange(first).from, monthRange(last).to);
			if (!range) return refuse('period out of range');
			const months = await monthlyTotals(ctx.db, ctx.spaceId, filterOf(range, null));
			const currencies = [...new Set(months.flatMap((m) => m.totals.map((t) => t.currency)))]
				.sort((x, y) => (x === 'IDR' ? -1 : y === 'IDR' ? 1 : x < y ? -1 : 1))
				.slice(0, MAX_CURRENCIES);
			const rows: TanyaCardRow[] = [];
			let chart: TanyaCard['chart'] = null;
			const model = currencies.map((currency, index) => {
				const series = monthsBetween(first, last).map((month) => {
					const t = months
						.find((m) => m.month === month)
						?.totals.find((x) => x.currency === currency);
					const out = t ? t.outMinor : 0;
					const expense = ctx.book.money(`expense ${month} ${currency}`, out, currency);
					const income = ctx.book.money(`income ${month} ${currency}`, t ? t.inMinor : 0, currency);
					rows.push(...row(formatShortMonth(month, ctx.locale), expense, true));
					return { month, out, expense, income };
				});
				if (index === 0 && series.every((s) => s.out !== null))
					chart = {
						type: 'bars',
						currency,
						bars: series.map((s) => ({
							label: formatShortMonth(s.month, ctx.locale),
							minor: s.out ?? 0
						}))
					};
				return {
					currency,
					months: series.map((s) => ({
						month: s.month,
						expense: forModel(s.expense),
						income: forModel(s.income)
					}))
				};
			});
			return result(
				{ from: first, to: last, currencies: model },
				{ title: msg('Pengeluaran per bulan'), period: range, rows, chart }
			);
		}
	),
	tool(DEFINITIONS.list_subscriptions, noInput, async (ctx) => {
		const [subscriptions, series] = await Promise.all([
			listSubscriptions(ctx.db, ctx.spaceId, ctx.today),
			listSeries(ctx.db, ctx.spaceId)
		]);
		// Fixture rows ("Data demo") are left out, as the Langganan monthly total leaves them out.
		const real = subscriptions.filter((s) => !s.isDemo);
		const perMonth = (s: (typeof real)[number]) =>
			(BigInt(s.amountMinor) *
				(s.schedule.cycle === 'monthly' ? 12n : s.schedule.cycle === 'yearly' ? 1n : 52n)) /
			12n;
		const sorted = [...real].sort((a, b) => {
			const d = perMonth(b) - perMonth(a);
			return d > 0n ? 1 : d < 0n ? -1 : a.name.localeCompare(b.name, 'id');
		});
		const rows: TanyaCardRow[] = [];
		const items = sorted.slice(0, 10).map((s) => {
			const name = dataText(s.name, NAME_MAX);
			const amount = ctx.book.money(`subscription ${s.currency}`, s.amountMinor, s.currency);
			const monthly = ctx.book.money(
				`subscription per month ${s.currency}`,
				safeMinor(perMonth(s)),
				s.currency
			);
			rows.push(...row(name, monthly, true));
			return {
				name,
				cycle: s.schedule.cycle,
				amount: forModel(amount),
				per_month: forModel(monthly),
				next_charge_on: s.nextChargeOn
			};
		});
		const totals = subscriptionMonthlyTotals(
			real.map((s) => ({
				amountMinor: s.amountMinor,
				currency: s.currency,
				cycle: s.schedule.cycle
			}))
		)
			.slice(0, MAX_CURRENCIES)
			.map((t) => {
				const f = ctx.book.money(`subscriptions per month ${t.currency}`, t.totalMinor, t.currency);
				rows.push(...row(msg('Perkiraan per bulan'), f));
				return { currency: t.currency, per_month: forModel(f) };
			});
		const horizon = addDays(ctx.today, 30);
		const upcoming = series
			.filter((r) => r.status === 'active' && r.type === 'expense' && r.nextRunOn <= horizon)
			.slice(0, 5)
			.map((r) => {
				const name = dataText(r.title ?? r.category?.name ?? '', NAME_MAX) || null;
				const amount = ctx.book.money(`recurring ${r.currency}`, r.amountMinor, r.currency);
				rows.push(...row(name ?? msg('Tagihan berulang'), amount, name !== null));
				return { name, amount: forModel(amount), next_run_on: r.nextRunOn };
			});
		return result(
			{ subscriptions: items, monthly_estimate: totals, upcoming_recurring: upcoming },
			{ title: msg('Langganan'), period: null, rows, chart: null }
		);
	}),
	tool(DEFINITIONS.wallet_balances, noInput, async (ctx) => {
		const [wallets, sums] = await Promise.all([
			listWallets(ctx.db, ctx.spaceId),
			walletTransactionsSums(ctx.db, ctx.spaceId)
		]);
		const live = wallets.map((w) => ({ ...w, balanceMinor: shownBalance(w, sums.get(w.id)) }));
		const hero = live.find((w) => w.isFavourite)?.currency ?? 'IDR';
		const walletRows: TanyaCardRow[] = [];
		const items = live.map((w) => {
			const name = dataText(w.name, NAME_MAX);
			const balance = ctx.book.money(`wallet ${w.currency}`, w.balanceMinor, w.currency);
			walletRows.push(...row(name, balance, true));
			return { name, currency: w.currency, balance: forModel(balance) };
		});
		const totalRows: TanyaCardRow[] = [];
		const totals = balanceTotals(live, hero).map((t) => {
			const f = ctx.book.money(`total ${t.currency}`, t.totalMinor, t.currency);
			totalRows.push(...row(msg('Total saldo'), f));
			return { currency: t.currency, total: forModel(f) };
		});
		// The card keeps every total and as many wallets as fit (up to 50 wallets + 3 totals would break the card
		// schema and lose the card); the model still receives every wallet.
		const rows = [...walletRows.slice(0, TANYA_CARD_ROWS_MAX - totalRows.length), ...totalRows];
		return result(
			{ wallets: items, totals },
			{ title: msg('Saldo dompet'), period: null, rows, chart: null }
		);
	}),
	tool(DEFINITIONS.budget_status, noInput, async (ctx) => {
		const figures = await anggaranSummary(ctx.db, ctx.spaceId, ctx.today);
		const range = { from: figures.from, to: figures.to };
		const rows: TanyaCardRow[] = [];
		const total =
			figures.budget && figures.total
				? (() => {
						const c = figures.budget.currency;
						const p = figures.total;
						const budget = ctx.book.money(`budget ${c}`, p.budgetMinor, c);
						const spent = ctx.book.money(`spent ${c}`, p.spentMinor, c);
						const left = ctx.book.money(`left ${c}`, p.remainingMinor, c);
						const used = ctx.book.percent(`used ${c}`, p.usedPercent);
						rows.push(
							...(budget && spent
								? [
										{
											label: msg('Total anggaran'),
											value: `${spent.formatted} / ${budget.formatted}`
										}
									]
								: [])
						);
						return {
							budget: forModel(budget),
							spent: forModel(spent),
							left: forModel(left),
							used_percent: forModel(used)
						};
					})()
				: null;
		const categories = [...figures.categories]
			.sort((a, b) => b.progress.usedPercent - a.progress.usedPercent)
			.slice(0, 20)
			.map((c) => {
				const name = dataText(c.name, NAME_MAX);
				const cur = c.budget.currency;
				const budget = ctx.book.money(`category budget ${cur}`, c.progress.budgetMinor, cur);
				const spent = ctx.book.money(`category spent ${cur}`, c.progress.spentMinor, cur);
				const left = ctx.book.money(`category left ${cur}`, c.progress.remainingMinor, cur);
				const used = ctx.book.percent(`category used ${cur}`, c.progress.usedPercent);
				if (budget && spent)
					rows.push({ label: name, raw: true, value: `${spent.formatted} / ${budget.formatted}` });
				return {
					name,
					budget: forModel(budget),
					spent: forModel(spent),
					left: forModel(left),
					used_percent: forModel(used)
				};
			});
		return result(
			{ period: range, has_budget: total !== null || categories.length > 0, total, categories },
			{ title: msg('Anggaran bulan ini'), period: range, rows, chart: null }
		);
	})
];

/** A short bar label for a range: the month name for a whole month, else the first date. */
function shortLabel(range: PeriodRange, locale: Locale): string {
	const month = monthOf(range.from);
	const whole = monthRange(month);
	return whole.from === range.from && whole.to === range.to
		? formatShortMonth(month, locale)
		: range.from.slice(5);
}

/** The toolset of one question, bound to the session's space (never one the model names). */
export function makeTools(options: {
	db: Db;
	spaceId: string;
	today: string;
	locale: Locale;
	book: FigureBook;
}): ToolSet {
	const ctx: Context = { ...options, db: readOnlyDb(options.db) };
	return {
		definitions: TOOL_DEFINITIONS,
		async run(name, input) {
			const found = TOOLS.find((t) => t.definition.name === name);
			if (!found) return refuse('unknown tool');
			const parsed = found.schema.safeParse(input);
			if (!parsed.success) return refuse('invalid input');
			try {
				return await found.handler(ctx, parsed.data as never);
			} catch {
				return refuse('could not read the records');
			}
		}
	};
}
