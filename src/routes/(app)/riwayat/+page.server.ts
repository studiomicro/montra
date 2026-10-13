import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { listTransactionsByDay, periodTotals, PAGE_SIZE } from '#lib/server/transactions/aggregate';
import { TRANSACTIONS_LOAD_FAILED } from '#lib/server/transactions/messages';
import { hasTransactions } from '#lib/server/transactions/repo';
import { takeSavedNotice } from '#lib/server/transactions/saved-notice';
import { listWallets } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { parseRiwayatQuery, viewFilter } from '#lib/shared/riwayat-query';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, cookies }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	const { view, cursor } = parseRiwayatQuery(url.searchParams, today);
	const filter = viewFilter(view);
	// What a finished write tells the list: shown only with the one-shot notice the write set (FN-44 L1), so a
	// crafted or reloaded `?saved=` shows no success.
	const saved = takeSavedNotice(cookies, locals.secure, url.searchParams.get('saved'));
	// `?pilih=kategori|dompet` shows that picker inline without JavaScript (a sheet does it with JavaScript).
	const pickParam = url.searchParams.get('pilih');
	const pick = pickParam === 'kategori' || pickParam === 'dompet' ? pickParam : null;
	try {
		const db = locals.db;
		await ensurePresetCategories(db, spaceId);
		// The header's figure and the chips' counts come from the same aggregate the list uses (one filter).
		const [totals, chipTotals, page, any, categories, wallets] = await Promise.all([
			periodTotals(db, spaceId, filter),
			filter.type ? periodTotals(db, spaceId, { ...filter, type: null }) : null,
			listTransactionsByDay(db, spaceId, filter, { cursor, limit: PAGE_SIZE }),
			hasTransactions(db, spaceId),
			listCategories(db, spaceId, { includeHidden: true }),
			listWallets(db, spaceId, { includeArchived: true })
		]);
		return {
			today,
			view,
			cursor: page.days.length > 0 ? cursor : null,
			totals,
			chipTotals: chipTotals ?? totals,
			page,
			hasAny: any,
			categories: categories.map(({ id, kind, name, tileKey, isPreset, isHidden }) => ({
				id,
				kind,
				name,
				tileKey,
				isPreset,
				isHidden
			})),
			wallets: wallets.map(({ id, name, archived }) => ({ id, name, archived })),
			saved,
			pick,
			loadError: null
		};
	} catch (e) {
		console.error('riwayat: list failed', e);
		return {
			today,
			view,
			cursor: null,
			totals: null,
			chipTotals: null,
			page: { days: [], nextCursor: null },
			hasAny: false,
			categories: [],
			wallets: [],
			saved,
			pick,
			loadError: TRANSACTIONS_LOAD_FAILED
		};
	}
};
