import { error, fail, redirect } from '@sveltejs/kit';
import { listCategoriesWithPresets } from '#lib/server/categories/repo';
import { readFormBody, boundedId, expectedUpdatedAt } from '#lib/server/forms';
import { SERIES_CHANGED, SERIES_NOT_FOUND, SERIES_STOPPED } from '#lib/server/recurring/messages';
import {
	deleteSeries,
	getSeries,
	listSeriesInstances,
	pauseSeries,
	resumeSeries,
	stopSeries,
	updateSeries,
	type SeriesWriteResult
} from '#lib/server/recurring/repo';
import { readRecurringForm } from '#lib/server/recurring/validation';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { REFS_GONE } from '#lib/server/transactions/messages';
import { setSeriesSavedNotice, type SeriesSavedKind } from '#lib/server/transactions/saved-notice';
import { listWallets } from '#lib/server/wallets/repo';
import { minorToAmountText } from '#lib/shared/amount-input';
import { wibTodayString } from '#lib/shared/dates';
import type { RecurringFormValues } from '#lib/shared/recurring';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const db = locals.db;
	const series = await getSeries(db, spaceId, boundedId(params.id));
	// Unknown, deleted and other-space ids get the one same answer.
	if (!series) error(404, 'Not found');
	const [categories, wallets, instances] = await Promise.all([
		listCategoriesWithPresets(db, spaceId),
		listWallets(db, spaceId),
		listSeriesInstances(db, spaceId, series.id)
	]);
	const { schedule } = series;
	const values: RecurringFormValues = {
		type: series.type,
		amount: minorToAmountText(series.amountMinor, series.currency, locals.locale),
		walletId: series.walletId,
		categoryId: series.categoryId,
		title: series.title ?? '',
		note: series.note ?? '',
		frequency: schedule.frequency,
		day: schedule.frequency === 'monthly' ? String(schedule.day) : '1',
		weekday: schedule.frequency === 'weekly' ? String(schedule.day) : '1',
		startOn: series.startOn,
		endOn: series.endOn ?? ''
	};
	return {
		today: wibTodayString(),
		series,
		instances,
		values,
		// Only a live wallet and a visible category can carry the next instances (the cron refuses others).
		categories: categories.map(({ id, kind, name, tileKey, isPreset }) => ({
			id,
			kind,
			name,
			tileKey,
			isPreset
		})),
		wallets: wallets.map(({ id, name, currency }) => ({ id, name, currency }))
	};
};

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const scope = await currentSpaceScope(event.locals);
	return { form, scope, db: event.locals.db, id: boundedId(event.params.id) };
}

/** A confirmed write: the one-shot notice first, then the redirect that carries `?saved=` (see the list's load). */
function saved(event: RequestEvent, kind: SeriesSavedKind): never {
	setSeriesSavedNotice(event.cookies, event.locals.secure, kind);
	redirect(303, `/riwayat/berulang?saved=${kind}`);
}

function refused(result: Exclude<SeriesWriteResult, 'ok'> | 'stopped') {
	if (result === 'missing') return fail(404, { error: SERIES_NOT_FOUND });
	if (result === 'stopped') return fail(409, { error: SERIES_STOPPED });
	return fail(409, { error: SERIES_CHANGED });
}

export const actions: Actions = {
	/** "Ubah seri": only instances created after this save use the new template. */
	update: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const current = await getSeries(db, scope.spaceId, id);
		if (!current) return fail(404, { error: SERIES_NOT_FOUND });
		const today = wibTodayString();
		const read = await readRecurringForm(db, scope.spaceId, form, today, event.locals.locale);
		if (!read.ok) return fail(400, { errors: read.errors, values: read.values });
		const result = await updateSeries(
			db,
			scope,
			current,
			read.input,
			expectedUpdatedAt(form),
			today,
			Date.now()
		);
		if (result === 'refs') return fail(409, { error: REFS_GONE });
		if (result !== 'ok') return refused(result);
		saved(event, 'updated');
	},

	pause: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const result = await pauseSeries(db, scope, id, expectedUpdatedAt(form), Date.now());
		if (result !== 'ok') return refused(result);
		saved(event, 'paused');
	},

	resume: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const current = await getSeries(db, scope.spaceId, id);
		if (!current) return fail(404, { error: SERIES_NOT_FOUND });
		const result = await resumeSeries(
			db,
			scope,
			current,
			expectedUpdatedAt(form),
			wibTodayString(),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		saved(event, 'resumed');
	},

	stop: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const result = await stopSeries(db, scope, id, expectedUpdatedAt(form), Date.now());
		if (result !== 'ok') return refused(result);
		saved(event, 'stopped');
	},

	delete: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const result = await deleteSeries(db, scope, id, expectedUpdatedAt(form), Date.now());
		if (result !== 'ok') return refused(result);
		saved(event, 'deleted');
	}
};
