import { daysBetween, monthOf, monthRange } from '#lib/shared/dates';
import type { TileKey } from '#lib/shared/transactions';
import type { Db } from '../db';
import { listCategories, type CategorySummary } from '../categories/repo';
import {
	categoryTotals,
	periodTotals,
	type CategoryTotals,
	type PeriodTotals,
	type TransactionFilter
} from '../transactions/aggregate';
import { listWallets } from '../wallets/repo';
import { listCategoryBudgets, type CategoryBudget } from './category-repo';
import {
	amountIn,
	budgetProgress,
	outIn,
	pacePercent,
	safeToSpend,
	type BudgetProgress,
	type SafeToSpend
} from './math';
import { getActiveBudget, type Budget } from './repo';

interface CategoryRef {
	categoryId: string;
	name: string;
	tileKey: TileKey;
	isPreset: boolean;
}

/** A budgeted category with its progress, in the budget's own currency. */
export interface BudgetedCategory extends CategoryRef {
	budget: CategoryBudget;
	progress: BudgetProgress;
}

/** An expense category without a budget, with this month's spending in the page's currency. */
export interface UnbudgetedCategory extends CategoryRef {
	spentMinor: number | null;
}

export interface AnggaranFigures {
	today: string;
	/** This WIB month: the budget period (FN-07 budgets follow the calendar month). */
	from: string;
	to: string;
	/** WIB days after today until the period ends (0 on its last day). */
	daysLeft: number;
	/** The pace marker: percent of the period gone, today included. */
	pace: number;
	/** The page's currency: the total budget's, else the favourite wallet's, else IDR. */
	currency: string;
	budget: Budget | null;
	total: BudgetProgress | null;
	safeToSpend: SafeToSpend | null;
	categories: BudgetedCategory[];
	unbudgeted: UnbudgetedCategory[];
}

const refOf = (c: CategorySummary): CategoryRef => ({
	categoryId: c.id,
	name: c.name,
	tileKey: c.tileKey,
	isPreset: c.isPreset
});

/**
 * The Anggaran page's figures (pure). `monthTotals` and `spending` are `periodTotals` / `categoryTotals` over this
 * whole WIB month for type expense, the same reads Beranda uses, so "terpakai" equals Beranda's month total in
 * that currency. A category's spending is only ever compared in its budget's currency.
 */
export function anggaranFigures(input: {
	today: string;
	currency: string;
	budget: Budget | null;
	monthTotals: PeriodTotals;
	categories: readonly CategorySummary[];
	spending: readonly CategoryTotals[];
	categoryBudgets: readonly CategoryBudget[];
}): AnggaranFigures {
	const { today, budget } = input;
	const { from, to } = monthRange(monthOf(today));
	const currency = budget?.currency ?? input.currency;
	const byCategory = new Map(
		input.spending.filter((s) => s.category).map((s) => [s.category?.id ?? '', s.totals])
	);
	const spentIn = (categoryId: string, cur: string) =>
		amountIn(byCategory.get(categoryId) ?? [], cur, 'outMinor');
	const expense = input.categories.filter((c) => c.kind === 'expense');
	const byId = new Map(expense.map((c) => [c.id, c]));
	const budgeted = new Set<string>();
	const categories: BudgetedCategory[] = [];
	for (const b of input.categoryBudgets) {
		const c = byId.get(b.categoryId);
		if (!c) continue;
		budgeted.add(c.id);
		categories.push({
			...refOf(c),
			budget: b,
			progress: budgetProgress(b.amountMinor, spentIn(c.id, b.currency), today)
		});
	}
	const unbudgeted = expense
		.filter((c) => !c.isHidden && !budgeted.has(c.id))
		.map((c) => ({ ...refOf(c), spentMinor: spentIn(c.id, currency) }))
		// Most spent first (too large first of all); ties keep the categories' own order (a stable sort).
		.sort((a, b) =>
			a.spentMinor === b.spentMinor
				? 0
				: a.spentMinor === null
					? -1
					: b.spentMinor === null
						? 1
						: b.spentMinor - a.spentMinor
		);
	return {
		today,
		from,
		to,
		daysLeft: daysBetween(today, to),
		pace: pacePercent(today),
		currency,
		budget,
		total: budget
			? budgetProgress(budget.amountMinor, outIn(input.monthTotals.totals, budget.currency), today)
			: null,
		safeToSpend: budget
			? safeToSpend(budget.amountMinor, outIn(input.monthTotals.totals, budget.currency), today)
			: null,
		categories,
		unbudgeted
	};
}

const monthExpense = (from: string, to: string): TransactionFilter => ({
	from,
	to,
	type: 'expense',
	categoryId: null,
	walletId: null,
	q: null
});

/** Everything the Anggaran page shows for `spaceId` (already admitted by the access gate) on WIB `today`. */
export async function anggaranSummary(
	db: Db,
	spaceId: string,
	today: string
): Promise<AnggaranFigures> {
	const { from, to } = monthRange(monthOf(today));
	const [wallets, budget, monthTotals, spending, categories, categoryBudgets] = await Promise.all([
		listWallets(db, spaceId),
		getActiveBudget(db, spaceId),
		periodTotals(db, spaceId, monthExpense(from, to)),
		categoryTotals(db, spaceId, monthExpense(from, to)),
		listCategories(db, spaceId, { includeHidden: true }),
		listCategoryBudgets(db, spaceId)
	]);
	return anggaranFigures({
		today,
		currency: wallets.find((w) => w.isFavourite)?.currency ?? 'IDR',
		budget,
		monthTotals,
		categories,
		spending,
		categoryBudgets
	});
}
