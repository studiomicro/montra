import { z } from 'zod';
import { agentRange, AGENT_TYPES, isPartialPeriod, type AgentType } from '#lib/shared/agent';
import { belongingValue } from '#lib/shared/belongings';
import {
	isDateString,
	monthRange,
	monthsBetween,
	shiftMonth,
	wibDateString
} from '#lib/shared/dates';
import { isLiabilityKind } from '#lib/shared/net-worth';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import { listBelongings } from '../belongings/repo';
import { listCollectibles } from '../collectibles/repo';
import type { Db } from '../db';
import { readPriceBook } from '../net-worth/prices';
import { listNetWorthItems } from '../net-worth/repo';
import { summarizeNetWorth } from '../net-worth/summary';
import { floorPercent } from '../reports/laporan';
import { readOnlyDb } from '../tanya/tools';
import {
	categoryTotals,
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

/**
 * The figures of one Agen report (FN-23), built step by step by code from the same helpers Beranda, Riwayat,
 * Laporan, Dompet and Tanya use (so they reconcile), over `readOnlyDb`: no model, no HTTP, no write. Money is
 * integer minor units with its currency (null: past the safe integer range, shown as "terlalu besar", never
 * rounded), dates are WIB strings, at most REPORT_CURRENCIES currencies are reported, each on its own. Names are
 * user data: cleaned, capped and masked (account-number-like digits) here, so the narrative and both files carry
 * the same text.
 */

/** Most currencies a monthly or annual report reports separately (never summed across). */
export const REPORT_CURRENCIES = 3;
/** Categories and merchants listed per currency. */
export const REPORT_TOP = 10;
/** Longest name kept in the facts. */
export const NAME_MAX = 80;

const date = z.string().refine(isDateString);
const month = z.string().regex(/^\d{4}-\d{2}$/);
const minor = z.number().int().nullable();
const currency = z.string().regex(/^[A-Z]{3}$/);
const name = z.string().max(NAME_MAX * 2);
const count = z.number().int().nonnegative();

const asset = z.object({
	name,
	kind: z.string().max(24),
	currency,
	/** Latest known value as of `valuedOn`; null with `unpriced` ("Belum ada harga") or past the safe range. */
	valueMinor: minor,
	unpriced: z.boolean(),
	/** A belonging counted with its depreciation estimate ("Estimasi"). */
	estimated: z.boolean(),
	acquiredOn: date.nullable(),
	acquisitionMinor: minor
});
export type AssetFact = z.infer<typeof asset>;

export const ASSET_GROUPS = ['items', 'debts', 'belongings', 'collectibles'] as const;
export type AssetGroup = (typeof ASSET_GROUPS)[number];

export const agentFacts = z.object({
	version: z.literal(1),
	type: z.enum(AGENT_TYPES),
	period: z.string().max(7),
	/** The WIB range covered: the whole period, cut at `generatedOn` for the current one. */
	from: date,
	to: date,
	/** The WIB date the report was made (every later step uses it, never the clock). */
	generatedOn: date,
	/** The current month or year: "sampai {tanggal}". */
	partial: z.boolean(),
	read: z
		.object({
			count,
			expenseCount: count,
			incomeCount: count,
			transferCount: count,
			adjustmentCount: count,
			currencies: z.array(currency).max(REPORT_CURRENCIES)
		})
		.optional(),
	group: z
		.object({
			categoryCount: count,
			currencies: z
				.array(
					z.object({
						currency,
						categories: z
							.array(z.object({ name: name.nullable(), outMinor: minor }))
							.max(REPORT_TOP),
						otherCount: count,
						otherMinor: minor,
						merchants: z
							.array(z.object({ title: name.nullable(), count, amountMinor: minor }))
							.max(REPORT_TOP)
					})
				)
				.max(REPORT_CURRENCIES)
		})
		.optional(),
	summary: z
		.object({
			previousPeriod: month.nullable(),
			currencies: z
				.array(
					z.object({
						currency,
						inMinor: minor,
						outMinor: minor,
						netMinor: minor,
						previousOutMinor: minor.optional(),
						changePercent: z.number().int().nullable().optional(),
						months: z
							.array(z.object({ month, inMinor: minor, outMinor: minor }))
							.max(12)
							.optional(),
						highestMonth: month.nullable().optional(),
						lowestMonth: month.nullable().optional()
					})
				)
				.max(REPORT_CURRENCIES)
		})
		.optional(),
	inventory: z
		.object({ wallets: count, items: count, belongings: count, collectibles: count })
		.optional(),
	balances: z
		.object({
			asOf: date,
			wallets: z.array(z.object({ name, currency, balanceMinor: minor })).max(50),
			totals: z.array(z.object({ currency, totalMinor: minor })).max(50)
		})
		.optional(),
	assets: z
		.object({
			valuedOn: date,
			items: z.array(asset).max(200),
			debts: z.array(asset).max(200),
			belongings: z.array(asset).max(300),
			collectibles: z.array(asset).max(300),
			subtotals: z
				.array(z.object({ group: z.enum(ASSET_GROUPS), currency, totalMinor: minor }))
				.max(200)
		})
		.optional()
});
export type AgentFacts = z.infer<typeof agentFacts>;

/** Stored text as a report shows it: invisible characters stripped, capped, account-number digits masked. */
export function reportName(text: string): string {
	return maskAccountNumbers(cleanText(text, NAME_MAX));
}

/** The facts a run starts from, made on `now` (its WIB date is the report's date from then on). */
export function startFacts(type: AgentType, period: string, now: number): AgentFacts {
	const generatedOn = wibDateString(now);
	const range = agentRange(type, period, generatedOn);
	return {
		version: 1,
		type,
		period,
		from: range.from,
		to: range.to,
		generatedOn,
		partial: isPartialPeriod(type, period, generatedOn)
	};
}

export interface FactsContext {
	db: Db;
	spaceId: string;
	now: number;
	/** The price cache (FN-25), for net-worth items; absent → every priced item is "Belum ada harga" unless manual. */
	cache?: KVNamespace;
}

const filterOf = (
	range: { from: string; to: string },
	type: TransactionFilter['type']
): TransactionFilter => ({
	from: range.from,
	to: range.to,
	type,
	categoryId: null,
	walletId: null,
	q: null
});

const outOf = (totals: readonly CurrencyTotals[], c: string): number | null => {
	const t = totals.find((x) => x.currency === c);
	return t ? t.outMinor : 0;
};
const inOf = (totals: readonly CurrencyTotals[], c: string): number | null => {
	const t = totals.find((x) => x.currency === c);
	return t ? t.inMinor : 0;
};
const difference = (a: number | null, b: number | null): number | null =>
	a === null || b === null ? null : safeMinor(BigInt(a) - BigInt(b));

const byKey = (a: { key: string }, b: { key: string }) =>
	a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/** Largest first, an unknown (too large) amount first of all; ties by name, so the order never depends on SQL. */
function byAmount<T extends { amount: number | null; key: string }>(a: T, b: T): number {
	if (a.amount === null || b.amount === null)
		return a.amount === b.amount ? byKey(a, b) : a.amount === null ? -1 : 1;
	return b.amount - a.amount || byKey(a, b);
}

/** Step `read` of a monthly or annual report: how many rows the period holds; 'empty' when none. */
export async function readStep(
	ctx: FactsContext,
	facts: AgentFacts
): Promise<AgentFacts | 'empty'> {
	const db = readOnlyDb(ctx.db);
	if (facts.type === 'spt_assets') {
		const [wallets, items, belongings, collectibles] = await Promise.all([
			listWallets(db, ctx.spaceId),
			listNetWorthItems(db, ctx.spaceId),
			listBelongings(db, ctx.spaceId),
			listCollectibles(db, ctx.spaceId)
		]);
		const inventory = {
			wallets: wallets.length,
			items: items.filter((i) => !i.isDemo).length,
			belongings: belongings.filter((i) => !i.isDemo).length,
			collectibles: collectibles.filter((i) => !i.isDemo).length
		};
		if (Object.values(inventory).every((n) => n === 0)) return 'empty';
		return { ...facts, inventory };
	}
	const totals = await periodTotals(db, ctx.spaceId, filterOf(facts, null));
	if (totals.count === 0) return 'empty';
	return {
		...facts,
		read: {
			count: totals.count,
			expenseCount: totals.expenseCount,
			incomeCount: totals.incomeCount,
			transferCount: totals.transferCount,
			adjustmentCount: totals.adjustmentCount,
			currencies: totals.totals.slice(0, REPORT_CURRENCIES).map((t) => t.currency)
		}
	};
}

/** Step `group`: expense per category (top REPORT_TOP + "Lainnya") and the top merchants, per currency. */
export async function groupStep(ctx: FactsContext, facts: AgentFacts): Promise<AgentFacts> {
	const db = readOnlyDb(ctx.db);
	const filter = filterOf(facts, 'expense');
	const groups = await categoryTotals(db, ctx.spaceId, filter);
	const currencies = [];
	for (const c of facts.read?.currencies ?? []) {
		const entries = groups
			.map((g) => ({
				name: g.category ? reportName(g.category.name) : null,
				amount: outOf(g.totals, c),
				key: g.category?.id ?? ''
			}))
			.filter((e) => e.amount === null || e.amount > 0)
			.sort(byAmount);
		const shown = entries.slice(0, REPORT_TOP);
		const rest = entries.slice(REPORT_TOP);
		const otherMinor = rest.some((e) => e.amount === null)
			? null
			: safeMinor(rest.reduce((s, e) => s + BigInt(e.amount ?? 0), 0n));
		const merchants = await merchantTotals(db, ctx.spaceId, filter, c, REPORT_TOP);
		currencies.push({
			currency: c,
			categories: shown.map((e) => ({ name: e.name, outMinor: e.amount })),
			otherCount: rest.length,
			otherMinor,
			merchants: merchants.map((m) => ({
				title: m.title ? reportName(m.title) : null,
				count: m.count,
				amountMinor: m.amountMinor
			}))
		});
	}
	const categoryCount = groups.filter((g) =>
		g.totals.some((t) => t.outMinor === null || t.outMinor > 0)
	).length;
	return { ...facts, group: { categoryCount, currencies } };
}

/**
 * Step `summary`: income, expense and net per currency; a monthly report adds the previous whole month's expense
 * and the change (`floorPercent`, null on a zero base); an annual report adds each month and its highest and
 * lowest expense month (computed here, never by the model).
 */
export async function summaryStep(ctx: FactsContext, facts: AgentFacts): Promise<AgentFacts> {
	const db = readOnlyDb(ctx.db);
	const totals = await periodTotals(db, ctx.spaceId, filterOf(facts, null));
	const currencies = facts.read?.currencies ?? [];
	if (facts.type === 'monthly') {
		const previousPeriod = shiftMonth(facts.period, -1);
		const previous = await periodTotals(
			db,
			ctx.spaceId,
			filterOf(monthRange(previousPeriod), 'expense')
		);
		return {
			...facts,
			summary: {
				previousPeriod,
				currencies: currencies.map((c) => {
					const out = outOf(totals.totals, c);
					const before = outOf(previous.totals, c);
					return {
						currency: c,
						inMinor: inOf(totals.totals, c),
						outMinor: out,
						netMinor: difference(inOf(totals.totals, c), out),
						previousOutMinor: before,
						changePercent: floorPercent(difference(out, before), before)
					};
				})
			}
		};
	}
	const months = await monthlyTotals(db, ctx.spaceId, filterOf(facts, null));
	const all = monthsBetween(facts.from.slice(0, 7), facts.to.slice(0, 7));
	return {
		...facts,
		summary: {
			previousPeriod: null,
			currencies: currencies.map((c) => {
				const series = all.map((m) => {
					const t = months.find((x) => x.month === m)?.totals ?? [];
					return { month: m, inMinor: inOf(t, c), outMinor: outOf(t, c) };
				});
				const known = series.filter(
					(s): s is { month: string; inMinor: number | null; outMinor: number } =>
						s.outMinor !== null && s.outMinor > 0
				);
				// Earliest month wins a tie; a month too large to show is never ranked.
				const highest = known.reduce<(typeof known)[number] | null>(
					(best, s) => (best === null || s.outMinor > best.outMinor ? s : best),
					null
				);
				const lowest = known.reduce<(typeof known)[number] | null>(
					(best, s) => (best === null || s.outMinor < best.outMinor ? s : best),
					null
				);
				const out = outOf(totals.totals, c);
				return {
					currency: c,
					inMinor: inOf(totals.totals, c),
					outMinor: out,
					netMinor: difference(inOf(totals.totals, c), out),
					months: series,
					highestMonth: highest?.month ?? null,
					lowestMonth: lowest?.month ?? null
				};
			})
		}
	};
}

/**
 * Step `balances` of the asset list: each live wallet's balance at the end of the chosen year (opening balance
 * plus signed rows with `occurred_on` up to 31 December), or now for the current year (exactly Dompet's figure).
 * A wallet created after that year end with no earlier row is left out; archived wallets are never listed.
 */
export async function balancesStep(ctx: FactsContext, facts: AgentFacts): Promise<AgentFacts> {
	const db = readOnlyDb(ctx.db);
	const asOf = facts.partial ? facts.generatedOn : `${facts.period}-12-31`;
	const [wallets, sums] = await Promise.all([
		listWallets(db, ctx.spaceId),
		walletTransactionsSums(db, ctx.spaceId, facts.partial ? undefined : asOf)
	]);
	const listed = wallets
		.filter((w) => facts.partial || wibDateString(w.createdAt) <= asOf || sums.has(w.id))
		.map((w) => ({
			name: reportName(w.name),
			currency: w.currency,
			balanceMinor: shownBalance(w, sums.get(w.id))
		}));
	const totals = balanceTotals(listed, 'IDR').map((t) => ({
		currency: t.currency,
		totalMinor: t.totalMinor
	}));
	return { ...facts, balances: { asOf, wallets: listed, totals } };
}

/**
 * Step `assets` of the asset list: net-worth items (debts apart, as liabilities) valued from the cached price
 * book, belongings (`belongingValue`) and collectibles, each with its latest known value as of the report's date
 * (no value history exists, so never a 31 December value), its acquisition date and price where recorded.
 * Items acquired after the year end are left out; `Data demo` rows never appear. Subtotals per group and
 * currency, never across currencies; an unpriced item counts in none.
 */
export async function assetsStep(ctx: FactsContext, facts: AgentFacts): Promise<AgentFacts> {
	const db = readOnlyDb(ctx.db);
	const yearEnd = facts.partial ? null : `${facts.period}-12-31`;
	const after = (d: string | null) => yearEnd !== null && d !== null && d > yearEnd;
	const [rawItems, rawBelongings, rawCollectibles, book] = await Promise.all([
		listNetWorthItems(db, ctx.spaceId),
		listBelongings(db, ctx.spaceId),
		listCollectibles(db, ctx.spaceId),
		readPriceBook(ctx.cache, ctx.now)
	]);
	const valued = summarizeNetWorth(
		[],
		rawItems.filter((i) => !i.isDemo && !after(i.acquiredOn)),
		book,
		ctx.now
	).items;
	const items: AssetFact[] = [];
	const debts: AssetFact[] = [];
	for (const i of valued) {
		const fact: AssetFact = {
			name: reportName(i.name),
			kind: i.kind,
			currency: i.currency,
			valueMinor: i.valueMinor,
			unpriced: i.basis === null,
			estimated: false,
			acquiredOn: i.acquiredOn,
			acquisitionMinor: null
		};
		(isLiabilityKind(i.kind) ? debts : items).push(fact);
	}
	const belongings: AssetFact[] = rawBelongings
		.filter((b) => !b.isDemo && !after(b.purchasedOn))
		.map((b) => {
			const v = belongingValue(b, facts.generatedOn);
			return {
				name: reportName(b.name),
				kind: 'belonging',
				currency: b.currency,
				valueMinor: v.valueMinor,
				unpriced: false,
				estimated: v.estimated,
				acquiredOn: b.purchasedOn,
				acquisitionMinor: b.purchasePriceMinor
			};
		});
	const collectibles: AssetFact[] = rawCollectibles
		.filter((c) => !c.isDemo && !after(c.purchasedOn))
		.map((c) => ({
			name: reportName(c.name),
			kind: 'collectible',
			currency: c.currency,
			valueMinor: c.valueMinor,
			unpriced: false,
			estimated: false,
			acquiredOn: c.purchasedOn,
			acquisitionMinor: c.purchasePriceMinor
		}));
	const groups: Record<AssetGroup, AssetFact[]> = { items, debts, belongings, collectibles };
	const subtotals = ASSET_GROUPS.flatMap((group) => subtotalsOf(group, groups[group]));
	return {
		...facts,
		assets: { valuedOn: facts.generatedOn, items, debts, belongings, collectibles, subtotals }
	};
}

/** Exact per-currency sums of the priced rows of one group (IDR first); null when a value or the sum is too large. */
export function subtotalsOf(group: AssetGroup, rows: readonly AssetFact[]) {
	const sums = new Map<string, bigint | null>();
	for (const r of rows) {
		if (r.unpriced) continue;
		const prev = sums.has(r.currency) ? (sums.get(r.currency) ?? null) : 0n;
		sums.set(
			r.currency,
			prev === null || r.valueMinor === null ? null : prev + BigInt(r.valueMinor)
		);
	}
	return [...sums]
		.sort(([a], [b]) => (a === 'IDR' ? -1 : b === 'IDR' ? 1 : a < b ? -1 : 1))
		.map(([c, sum]) => ({ group, currency: c, totalMinor: sum === null ? null : safeMinor(sum) }));
}
