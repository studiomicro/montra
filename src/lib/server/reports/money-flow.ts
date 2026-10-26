import { msg } from '#lib/shared/i18n';
import { FOLDED_ID } from '#lib/shared/money-flow';
import { periodDates, previousPeriodDates, type ReportPeriod } from '#lib/shared/report-period';
import type { TileKey } from '#lib/shared/transactions';
import { sumExact } from '../budgets/math';
import type { Db } from '../db';
import {
	moneyFlowTotals,
	monthlyTotals,
	periodTotals,
	safeMinor,
	type MoneyFlowRow,
	type TransactionFilter
} from '../transactions/aggregate';
import { listWallets } from '../wallets/repo';
import { floorPer } from './laporan';

// Alur uang (FN-35, FN-53): income categories → wallets → expense categories for one WIB month, quarter or year.
// Every link is a sum of stored rows from `moneyFlowTotals` (the FN-05 WHERE clause: live rows of one space, demo
// rows never count, transfers and every non-money type left out). One currency is drawn, the favourite wallet's
// (IDR without wallets), Laporan's rule; other currencies are named and counted, never added in. A sum past
// Number.MAX_SAFE_INTEGER is null ("Total terlalu besar untuk ditampilkan"), and anything built on it is null too.

export const FLOW_LOAD_FAILED = msg('Alur uang tidak bisa dimuat. Coba lagi sebentar lagi.');

/** Kuartal and Tahun fold the smaller categories (per side) and wallets past these into one node (FN-53). */
const FOLD_CATEGORIES = 7;
const FOLD_WALLETS = 6;
/** Kuartal and Tahun list this many links per direction; the rest is one "Alur lainnya (n)" row. */
const LIST_LINKS = 12;

/**
 * An income or expense category node; `categoryId` '' stands for rows without a category and FOLDED_ID for the
 * folded "Lainnya" node.
 */
interface FlowCategoryNode {
	key: string;
	categoryId: string;
	name: string | null;
	isPreset: boolean;
	tileKey: TileKey;
	minor: number | null;
}

/** A wallet node; `walletId` FOLDED_ID is the folded "Dompet lainnya" node. */
interface FlowWalletNode {
	key: string;
	walletId: string;
	name: string;
	inMinor: number | null;
	outMinor: number | null;
}

/** Money from one node to the next: income category → wallet, or wallet → expense category. */
export interface FlowLink {
	from: string;
	to: string;
	amountMinor: number | null;
}

export interface MoneyFlowShape {
	currency: string;
	/** Largest first; a node without money in the period is left out. */
	income: FlowCategoryNode[];
	wallets: FlowWalletNode[];
	expense: FlowCategoryNode[];
	/** Income links first, then expense links; each with money (never a zero link). */
	links: FlowLink[];
	inMinor: number | null;
	outMinor: number | null;
	/** Other currencies with income or expense in the period: left out of the diagram, never converted. */
	otherCurrencies: string[];
	/** Income and expense rows in those other currencies. */
	otherCount: number;
	/** More groups than MONEY_FLOW_MAX_GROUPS: only the largest are drawn and summed (the page says so). */
	truncated: boolean;
}

/** One direction's link list: the largest links, and the exact sum of the rest (null when nothing is left out). */
export interface FlowLinkList {
	links: FlowLink[];
	rest: { count: number; minor: number | null } | null;
}

export interface MoneyFlowReport extends MoneyFlowShape {
	period: ReportPeriod;
	/** The WIB dates summed (a current quarter or year runs through today). */
	from: string;
	to: string;
	/** The period is still running. */
	partial: boolean;
	/**
	 * The previous period of the same kind in the same currency (cut at the same day offset while this one runs),
	 * and this period minus it. `current` sums this period through today (the month view's diagram covers the
	 * whole month; the comparison stops at today, like with like). `hasRows`: the previous period had income or
	 * expense in this currency ("Belum ada data" otherwise). A null figure is too large to show. Null at the 2000
	 * floor, where there is no previous period (red team L1).
	 */
	comparison: {
		previous: ReportPeriod;
		from: string;
		to: string;
		cut: boolean;
		hasRows: boolean;
		current: { inMinor: number | null; outMinor: number | null; netMinor: number | null };
		previousTotals: { inMinor: number | null; outMinor: number | null; netMinor: number | null };
		diff: { inMinor: number | null; outMinor: number | null; netMinor: number | null };
	} | null;
	/** Kuartal and Tahun: one entry per month so far (zeros for a month without rows). Null for a month. */
	months: { month: string; inMinor: number | null; outMinor: number | null }[] | null;
	/** Kuartal and Tahun: floor(total / months so far) per direction. Null for a month. */
	average: { inMinor: number | null; outMinor: number | null; months: number } | null;
	/** "Rincian alur": the links per direction, capped for Kuartal and Tahun. */
	lists: { income: FlowLinkList; expense: FlowLinkList };
}

const incomeKey = (categoryId: string) => `in:${categoryId}`;
const walletKey = (walletId: string) => `w:${walletId}`;
const expenseKey = (categoryId: string) => `out:${categoryId}`;

/** Largest first, a too-large (null) value first of all; ties by key for a stable order. */
function byAmount<T>(value: (n: T) => number | null, key: (n: T) => string) {
	return (a: T, b: T) => {
		const x = value(a);
		const y = value(b);
		if (x === y) return key(a) < key(b) ? -1 : 1;
		if (x === null) return -1;
		if (y === null) return 1;
		return y - x;
	};
}
const nodeKey = (n: { key: string }) => n.key;
const linkKey = (l: FlowLink) => `${l.from}>${l.to}`;
const linkOrder = (a: FlowLink, b: FlowLink) =>
	a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1;

/** Shapes `moneyFlowTotals` rows into the diagram's nodes and links in `currency`. Pure. */
export function shapeMoneyFlow(
	rows: readonly MoneyFlowRow[],
	currency: string,
	truncated = false
): MoneyFlowShape {
	const shown = rows.filter((r) => r.currency === currency && r.amountMinor !== 0);
	const others = rows.filter((r) => r.currency !== currency);

	const categories = (type: MoneyFlowRow['type'], key: (id: string) => string) => {
		const map = new Map<string, FlowCategoryNode & { parts: (number | null)[] }>();
		for (const r of shown.filter((x) => x.type === type)) {
			const id = r.category?.id ?? '';
			const node = map.get(id) ?? {
				key: key(id),
				categoryId: id,
				name: r.category?.name ?? null,
				isPreset: r.category?.isPreset ?? false,
				tileKey: r.category?.tileKey ?? 'lain',
				minor: 0,
				parts: []
			};
			node.parts.push(r.amountMinor);
			map.set(id, node);
		}
		return [...map.values()]
			.map(({ parts, ...node }) => ({ ...node, minor: sumExact(parts) }))
			.sort(byAmount<FlowCategoryNode>((n) => n.minor, nodeKey));
	};

	const wallets = new Map<
		string,
		{ node: FlowWalletNode; ins: (number | null)[]; outs: (number | null)[] }
	>();
	for (const r of shown) {
		const w = wallets.get(r.wallet.id) ?? {
			node: {
				key: walletKey(r.wallet.id),
				walletId: r.wallet.id,
				name: r.wallet.name,
				inMinor: 0,
				outMinor: 0
			},
			ins: [],
			outs: []
		};
		(r.type === 'income' ? w.ins : w.outs).push(r.amountMinor);
		wallets.set(r.wallet.id, w);
	}
	const walletNodes = [...wallets.values()]
		.map(({ node, ins, outs }) => ({ ...node, inMinor: sumExact(ins), outMinor: sumExact(outs) }))
		.sort(byAmount<FlowWalletNode>(walletSize, nodeKey));

	const link = (r: MoneyFlowRow): FlowLink => {
		const category = r.category?.id ?? '';
		return r.type === 'income'
			? { from: incomeKey(category), to: walletKey(r.wallet.id), amountMinor: r.amountMinor }
			: { from: walletKey(r.wallet.id), to: expenseKey(category), amountMinor: r.amountMinor };
	};

	const income = categories('income', incomeKey);
	const expense = categories('expense', expenseKey);
	return {
		currency,
		income,
		wallets: walletNodes,
		expense,
		links: [
			...shown
				.filter((r) => r.type === 'income')
				.map(link)
				.sort(linkOrder),
			...shown
				.filter((r) => r.type === 'expense')
				.map(link)
				.sort(linkOrder)
		],
		inMinor: sumExact(income.map((n) => n.minor)),
		outMinor: sumExact(expense.map((n) => n.minor)),
		otherCurrencies: [...new Set(others.map((r) => r.currency))].sort(),
		otherCount: others.reduce((n, r) => n + r.count, 0),
		truncated
	};
}

/** A wallet's size in the diagram: the larger of its money in and out (null when either is too large). */
function walletSize(n: FlowWalletNode): number | null {
	return n.inMinor === null || n.outMinor === null ? null : Math.max(n.inMinor, n.outMinor);
}

/** Splits nodes (largest first) into the kept ones and the folded rest; never folds fewer than two. */
function foldNodes<T>(nodes: readonly T[], cap: number): { kept: T[]; folded: T[] } {
	return nodes.length - cap >= 2
		? { kept: nodes.slice(0, cap), folded: nodes.slice(cap) }
		: { kept: [...nodes], folded: [] };
}

/**
 * Kuartal and Tahun (FN-53): at most FOLD_CATEGORIES income and expense categories and FOLD_WALLETS wallets, the
 * smaller rest folded into one node each ("Lainnya" `in:*` / `out:*`, "Dompet lainnya" `w:*`) when that absorbs
 * two or more nodes. Links that end up sharing both ends are merged with an exact sum, so every node sum, link sum
 * and the period totals stay exact. Pure.
 */
export function foldMoneyFlow(flow: MoneyFlowShape): MoneyFlowShape {
	const income = foldNodes(flow.income, FOLD_CATEGORIES);
	const expense = foldNodes(flow.expense, FOLD_CATEGORIES);
	const wallets = foldNodes(flow.wallets, FOLD_WALLETS);
	if (income.folded.length + expense.folded.length + wallets.folded.length === 0) return flow;

	const remap = new Map<string, string>();
	for (const n of income.folded) remap.set(n.key, incomeKey(FOLDED_ID));
	for (const n of expense.folded) remap.set(n.key, expenseKey(FOLDED_ID));
	for (const n of wallets.folded) remap.set(n.key, walletKey(FOLDED_ID));

	const foldedCategory = (nodes: FlowCategoryNode[], key: string): FlowCategoryNode[] =>
		nodes.length === 0
			? []
			: [
					{
						key,
						categoryId: FOLDED_ID,
						name: null,
						isPreset: false,
						tileKey: 'lain',
						minor: sumExact(nodes.map((n) => n.minor))
					}
				];
	const foldedWallet: FlowWalletNode[] =
		wallets.folded.length === 0
			? []
			: [
					{
						key: walletKey(FOLDED_ID),
						walletId: FOLDED_ID,
						name: '',
						inMinor: sumExact(wallets.folded.map((w) => w.inMinor)),
						outMinor: sumExact(wallets.folded.map((w) => w.outMinor))
					}
				];

	const merged = new Map<string, { link: FlowLink; parts: (number | null)[] }>();
	for (const l of flow.links) {
		const from = remap.get(l.from) ?? l.from;
		const to = remap.get(l.to) ?? l.to;
		const key = `${from}>${to}`;
		const entry = merged.get(key) ?? { link: { from, to, amountMinor: 0 }, parts: [] };
		entry.parts.push(l.amountMinor);
		merged.set(key, entry);
	}
	const links = [...merged.values()].map(({ link, parts }) => ({
		...link,
		amountMinor: sumExact(parts)
	}));
	const isIncome = (l: FlowLink) => l.from.startsWith('in:');
	return {
		...flow,
		income: [...income.kept, ...foldedCategory(income.folded, incomeKey(FOLDED_ID))],
		wallets: [...wallets.kept, ...foldedWallet],
		expense: [...expense.kept, ...foldedCategory(expense.folded, expenseKey(FOLDED_ID))],
		links: [
			...links.filter(isIncome).sort(linkOrder),
			...links.filter((l) => !isIncome(l)).sort(linkOrder)
		]
	};
}

/** One direction's links, largest first, at most `cap`; the rest as one exact sum. Pure. */
export function linkList(links: readonly FlowLink[], cap: number): FlowLinkList {
	const sorted = links.toSorted(byAmount((l) => l.amountMinor, linkKey));
	const rest = sorted.slice(cap);
	return {
		links: sorted.slice(0, cap),
		rest:
			rest.length === 0
				? null
				: { count: rest.length, minor: sumExact(rest.map((l) => l.amountMinor)) }
	};
}

const minus = (a: number | null, b: number | null) =>
	a === null || b === null ? null : safeMinor(BigInt(a) - BigInt(b));
const net = (t: { inMinor: number | null; outMinor: number | null }) =>
	minus(t.inMinor, t.outMinor);

const allRows = (from: string, to: string): TransactionFilter => ({
	from,
	to,
	type: null,
	categoryId: null,
	walletId: null,
	q: null
});

/**
 * The money flow of `spaceId` (already admitted by the access gate) for `period` on the WIB date `today`. Four
 * D1 statements whatever the period: the wallets, `moneyFlowTotals` for the period, `monthlyTotals` for the period
 * through today, and `periodTotals` for the previous period. Nothing loads raw transaction rows.
 */
export async function moneyFlowReport(
	db: Db,
	spaceId: string,
	period: ReportPeriod,
	today: string
): Promise<MoneyFlowReport> {
	const dates = periodDates(period, today);
	const previous = previousPeriodDates(period, today);
	const throughToday = dates.to < today ? dates.to : today;
	const [wallets, flow, monthly, before] = await Promise.all([
		listWallets(db, spaceId),
		moneyFlowTotals(db, spaceId, allRows(dates.from, dates.to)),
		// A month after today (callers clamp; only a direct call names one) has nothing through today.
		throughToday < dates.from
			? Promise.resolve([])
			: monthlyTotals(db, spaceId, allRows(dates.from, throughToday)),
		previous ? periodTotals(db, spaceId, allRows(previous.from, previous.to)) : null
	]);
	const currency = wallets.find((w) => w.isFavourite)?.currency ?? 'IDR';
	const shaped = shapeMoneyFlow(flow.rows, currency, flow.truncated);
	const folds = period.kind !== 'bulan';
	const shape = folds ? foldMoneyFlow(shaped) : shaped;

	const months = dates.months.map((month) => {
		const t = monthly.find((m) => m.month === month)?.totals.find((c) => c.currency === currency);
		return { month, inMinor: t ? t.inMinor : 0, outMinor: t ? t.outMinor : 0 };
	});
	const current = {
		inMinor: sumExact(months.map((m) => m.inMinor)),
		outMinor: sumExact(months.map((m) => m.outMinor))
	};
	const prev = before?.totals.find((t) => t.currency === currency);
	const previousTotals = { inMinor: prev ? prev.inMinor : 0, outMinor: prev ? prev.outMinor : 0 };

	const cap = folds ? LIST_LINKS : Number.MAX_SAFE_INTEGER;
	const isIncome = (l: FlowLink) => l.from.startsWith('in:');
	return {
		...shape,
		period,
		from: dates.from,
		to: dates.to,
		partial: dates.partial,
		comparison: previous && {
			previous: previous.period,
			from: previous.from,
			to: previous.to,
			cut: previous.cut,
			hasRows: prev !== undefined,
			current: { ...current, netMinor: net(current) },
			previousTotals: { ...previousTotals, netMinor: net(previousTotals) },
			diff: {
				inMinor: minus(current.inMinor, previousTotals.inMinor),
				outMinor: minus(current.outMinor, previousTotals.outMinor),
				netMinor: minus(net(current), net(previousTotals))
			}
		},
		months: folds ? months : null,
		average: folds
			? {
					inMinor: floorPer(current.inMinor, dates.elapsedMonths),
					outMinor: floorPer(current.outMinor, dates.elapsedMonths),
					months: dates.elapsedMonths
				}
			: null,
		lists: {
			income: linkList(shape.links.filter(isIncome), cap),
			expense: linkList(
				shape.links.filter((l) => !isIncome(l)),
				cap
			)
		}
	};
}
