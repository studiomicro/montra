import { fail, redirect } from '@sveltejs/kit';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { readFormBody } from '#lib/server/forms';
import { SERIES_LIMIT, SERIES_LOAD_FAILED } from '#lib/server/recurring/messages';
import { createSeries } from '#lib/server/recurring/repo';
import { readRecurringForm } from '#lib/server/recurring/validation';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { REFS_GONE } from '#lib/server/transactions/messages';
import { setSeriesSavedNotice } from '#lib/server/transactions/saved-notice';
import { listWallets } from '#lib/server/wallets/repo';
import { wibDateParts, wibTodayString } from '#lib/shared/dates';
import type { RecurringFormValues } from '#lib/shared/recurring';
import { isoWeekday } from '#lib/shared/subscriptions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	try {
		await ensurePresetCategories(locals.db, spaceId);
		const [categories, wallets] = await Promise.all([
			listCategories(locals.db, spaceId),
			listWallets(locals.db, spaceId)
		]);
		// Today's day and weekday as the default schedule; the favourite wallet (listed first) as the wallet.
		const values: RecurringFormValues = {
			type: 'expense',
			amount: '',
			walletId: wallets[0]?.id ?? '',
			categoryId: '',
			title: '',
			note: '',
			frequency: 'monthly',
			day: String(wibDateParts(today).day),
			weekday: String(isoWeekday(today)),
			startOn: today,
			endOn: ''
		};
		return {
			values,
			categories: categories
				.filter((c) => c.kind === 'expense' || c.kind === 'income')
				.map(({ id, kind, name, tileKey, isPreset }) => ({ id, kind, name, tileKey, isPreset })),
			wallets: wallets.map(({ id, name, currency }) => ({ id, name, currency })),
			loadError: null
		};
	} catch (e) {
		console.error('riwayat/berulang/baru: load failed', e instanceof Error ? e.name : 'unknown');
		return { values: null, categories: [], wallets: [], loadError: SERIES_LOAD_FAILED };
	}
};

export const actions: Actions = {
	create: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const db = event.locals.db;
		const today = wibTodayString();
		const read = await readRecurringForm(db, scope.spaceId, form, today, event.locals.locale);
		if (!read.ok) return fail(400, { errors: read.errors, values: read.values });
		const created = await createSeries(db, scope, read.input, today, Date.now());
		if (!created.ok)
			return fail(409, { error: created.reason === 'limit' ? SERIES_LIMIT : REFS_GONE });
		setSeriesSavedNotice(event.cookies, event.locals.secure, 'created');
		redirect(303, '/riwayat/berulang?saved=created');
	}
};
