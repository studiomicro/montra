import { monthRange } from '#lib/shared/dates';
import { msg } from '#lib/shared/i18n';
import type { TileKey } from '#lib/shared/transactions';
import { sumExact } from '../budgets/math';
import type { Db } from '../db';
import {
	moneyFlowTotals,
	type MoneyFlowRow,
	type TransactionFilter
} from '../transactions/aggregate';
import { listWallets } from '../wallets/repo';

// Alur uang (FN-35): income categories → wallets → expense categories for one WIB month. Every link is a sum of
// stored rows from `moneyFlowTotals` (the FN-05 WHERE clause: live rows of one space, demo rows never count,
// transfers and every non-money type left out). One currency is drawn, the favourite wallet's (IDR without
// wallets), Laporan's rule; other currencies are named and counted, never added in. A sum past
// Number.MAX_SAFE_INTEGER is null ("Total terlalu besar untuk ditampilkan"), and anything built on it is null too.

export const FLOW_LOAD_FAILED = msg('Alur uang tidak bisa dimuat. Coba lagi sebentar lagi.');

/** An income or expense category node; `categoryId` '' stands for rows without a category. */
export interface FlowCategoryNode {
	key: string;
	categoryId: string;
	name: string | null;
	isPreset: boolean;
	tileKey: TileKey;
	minor: number | null;
}

export interface FlowWalletNode {
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

export interface MoneyFlowReport {
	month: string;
	currency: string;
	/** Largest first; a node without money in the month is left out. */
	income: FlowCategoryNode[];
	wallets: FlowWalletNode[];
	expense: FlowCategoryNode[];
	/** Income links first, then expense links; each with money (never a zero link). */
	links: FlowLink[];
	inMinor: number | null;
	outMinor: number | null;
	/** Other currencies with income or expense this month: left out of the diagram, never converted. */
	otherCurrencies: string[];
	/** Income and expense rows in those other currencies. */
	otherCount: number;
	/** More groups than MONEY_FLOW_MAX_GROUPS: only the largest are drawn and summed (the page says so). */
	truncated: boolean;
}

const incomeKey = (categoryId: string) => `in:${categoryId}`;
const walletKey = (walletId: string) => `w:${walletId}`;
const expenseKey = (categoryId: string) => `out:${categoryId}`;

/** Largest first, a too-large (null) value first of all; ties by key for a stable order. */
function byAmount<T extends { key: string }>(value: (n: T) => number | null) {
	return (a: T, b: T) => {
		const x = value(a);
		const y = value(b);
		if (x === y) return a.key < b.key ? -1 : 1;
		if (x === null) return -1;
		if (y === null) return 1;
		return y - x;
	};
}

/** Shapes `moneyFlowTotals` rows into the diagram's nodes and links in `currency`. Pure. */
export function shapeMoneyFlow(
	rows: readonly MoneyFlowRow[],
	month: string,
	currency: string,
	truncated = false
): MoneyFlowReport {
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
			.sort(byAmount((n) => n.minor));
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
		.sort(
			byAmount((n) =>
				n.inMinor === null || n.outMinor === null ? null : Math.max(n.inMinor, n.outMinor)
			)
		);

	const link = (r: MoneyFlowRow): FlowLink => {
		const category = r.category?.id ?? '';
		return r.type === 'income'
			? { from: incomeKey(category), to: walletKey(r.wallet.id), amountMinor: r.amountMinor }
			: { from: walletKey(r.wallet.id), to: expenseKey(category), amountMinor: r.amountMinor };
	};
	const order = (a: FlowLink, b: FlowLink) =>
		a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1;

	const income = categories('income', incomeKey);
	const expense = categories('expense', expenseKey);
	return {
		month,
		currency,
		income,
		wallets: walletNodes,
		expense,
		links: [
			...shown
				.filter((r) => r.type === 'income')
				.map(link)
				.sort(order),
			...shown
				.filter((r) => r.type === 'expense')
				.map(link)
				.sort(order)
		],
		inMinor: sumExact(income.map((n) => n.minor)),
		outMinor: sumExact(expense.map((n) => n.minor)),
		otherCurrencies: [...new Set(others.map((r) => r.currency))].sort(),
		otherCount: others.reduce((n, r) => n + r.count, 0),
		truncated
	};
}

/** The money flow of `spaceId` (already admitted by the access gate) in the WIB month `month` (`YYYY-MM`). */
export async function moneyFlowReport(
	db: Db,
	spaceId: string,
	month: string
): Promise<MoneyFlowReport> {
	const { from, to } = monthRange(month);
	const filter: TransactionFilter = {
		from,
		to,
		type: null,
		categoryId: null,
		walletId: null,
		q: null
	};
	const [wallets, flow] = await Promise.all([
		listWallets(db, spaceId),
		moneyFlowTotals(db, spaceId, filter)
	]);
	const currency = wallets.find((w) => w.isFavourite)?.currency ?? 'IDR';
	return shapeMoneyFlow(flow.rows, month, currency, flow.truncated);
}
