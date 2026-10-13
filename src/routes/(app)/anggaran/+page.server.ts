import {
	deleteBudgetAction,
	deleteCategoryBudgetAction,
	setBudgetAction,
	setCategoryBudgetAction
} from '#lib/server/budgets/actions';
import { anggaranSummary } from '#lib/server/budgets/anggaran';
import { ANGGARAN_LOAD_FAILED } from '#lib/server/budgets/messages';
import { ensurePresetCategories } from '#lib/server/categories/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { ID_MAX_LENGTH } from '#lib/server/transactions/validation';
import { errorLabel } from '#lib/server/util';
import { wibTodayString } from '#lib/shared/dates';
import type { Actions, PageServerLoad } from './$types';

// Anggaran (APP_PARITY § 3) works on the session's current space (locals.space), re-checked through
// requireSpaceAccess on every load and action (currentSpaceScope). A category id from the URL or a form is only
// ever looked up inside that space, so another space's id reads as not found.

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	// `?ubah=bulanan` / `?kategori=<id>` open a budget form without JavaScript (a sheet does it with JavaScript).
	const open =
		url.searchParams.get('ubah') === 'bulanan'
			? ('total' as const)
			: (url.searchParams.get('kategori')?.slice(0, ID_MAX_LENGTH) ?? null);
	try {
		await ensurePresetCategories(locals.db, spaceId);
		return {
			today,
			open,
			summary: await anggaranSummary(locals.db, spaceId, today),
			loadError: null
		};
	} catch (e) {
		console.error('anggaran: load failed', errorLabel(e));
		return { today, open, summary: null, loadError: ANGGARAN_LOAD_FAILED };
	}
};

export const actions: Actions = {
	setBudget: setBudgetAction,
	deleteBudget: deleteBudgetAction,
	setCategoryBudget: setCategoryBudgetAction,
	deleteCategoryBudget: deleteCategoryBudgetAction
};
