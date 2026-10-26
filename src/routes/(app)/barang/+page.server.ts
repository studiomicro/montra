import { fail } from '@sveltejs/kit';
import {
	BELONGING_CHANGED,
	BELONGING_LIMIT,
	BELONGING_NOT_FOUND,
	BELONGINGS_LOAD_FAILED
} from '#lib/server/belongings/messages';
import {
	archiveBelonging,
	createBelonging,
	listBelongings,
	totalsOf,
	updateBelonging,
	type BelongingWriteResult
} from '#lib/server/belongings/repo';
import { belongingFormValues, parseBelongingForm } from '#lib/server/belongings/validation';
// One phrase for every read-only `Data demo` row (FN-28's answer, same i18n key).
import { COLLECTIBLE_DEMO_READONLY as DEMO_READONLY } from '#lib/server/collectibles/messages';
import { getEnv } from '#lib/server/env';
import { errorLabel } from '#lib/server/util';
import {
	readFormBody,
	textField,
	expectedUpdatedAt,
	ID_MAX_LENGTH,
	idField
} from '#lib/server/forms';
import { PHOTO_UPLOAD_FAILED } from '#lib/server/photos/messages';
import { cleanUpFiles, type PhotoChange } from '#lib/server/photos/store';
import { guardedPhotoForm } from '#lib/server/photos/guard';
import { readPhotoField, uploadPhoto } from '#lib/server/photos/upload';
import { currentSpaceAccess } from '#lib/server/spaces/current';
import { belongingValue } from '#lib/shared/belongings';
import { wibTodayString } from '#lib/shared/dates';
import type { Actions, PageServerLoad } from './$types';

// The page works on the session's current space (locals.space, already a re-validated membership). Every load
// and action still passes it through requireSpaceAccess with locals.user, so there is one access rule; an id
// from the form is only ever looked up inside that space, so another space's id and an unknown id get the
// same answer. Photos are read only through ./[id]/foto (the same check), never from a public R2 URL.

const belongingId = (form: FormData) => idField(form, 'belongingId');

function refused(result: Exclude<BelongingWriteResult, 'ok'>) {
	if (result === 'demo') return fail(400, { error: DEMO_READONLY });
	return result === 'missing'
		? fail(404, { error: BELONGING_NOT_FOUND })
		: fail(409, { error: BELONGING_CHANGED });
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const { scope, space } = await currentSpaceAccess(locals);
	const spaceLabel = { kind: space.kind, name: space.kind === 'shared' ? space.name : '' };
	// `?tambah=1` / `?ubah=<id>` open the form without JavaScript (the sheet does it with JavaScript).
	const editId = url.searchParams.get('ubah')?.slice(0, ID_MAX_LENGTH) ?? null;
	const open = url.searchParams.get('tambah') === '1' ? 'add' : editId;
	// Today's WIB date: every estimate is recomputed from it on each load, never stored.
	const today = wibTodayString();
	try {
		const rows = await listBelongings(locals.db, scope.spaceId);
		const items = rows.map((item) => ({ ...item, ...belongingValue(item, today) }));
		return {
			space: spaceLabel,
			items,
			totals: totalsOf(rows, today),
			today,
			open,
			loadError: null
		};
	} catch (e) {
		console.error('barang: list failed', errorLabel(e));
		return {
			space: spaceLabel,
			items: [],
			totals: [],
			today,
			open: null,
			loadError: BELONGINGS_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	create: async (event) => {
		const guarded = await guardedPhotoForm(event, 'create');
		if ('refusal' in guarded) return guarded.refusal;
		const { form, scope, db } = guarded;
		const now = Date.now();
		const parsed = parseBelongingForm(form, wibTodayString(now));
		if (!parsed.ok)
			return fail(400, { action: 'create', errors: parsed.errors, values: parsed.values });
		const photo = await readPhotoField(form);
		if (photo.kind === 'refused')
			return fail(400, {
				action: 'create',
				errors: { photo: photo.message },
				values: belongingFormValues(form)
			});
		const env = getEnv();
		const stored =
			photo.kind === 'image'
				? await uploadPhoto(env, db, scope.spaceId, 'belongings', photo.image, now)
				: null;
		if (photo.kind === 'image' && !stored)
			return fail(503, {
				action: 'create',
				errors: { photo: PHOTO_UPLOAD_FAILED },
				values: belongingFormValues(form)
			});
		const created = await createBelonging(db, scope, parsed.value, stored, now);
		if (!created.ok) {
			if (stored) await cleanUpFiles(env, db, [stored.key], now);
			return created.reason === 'limit'
				? fail(409, { error: BELONGING_LIMIT })
				: fail(404, { error: BELONGING_NOT_FOUND });
		}
		return { saved: stored ? ('createdWithPhoto' as const) : ('created' as const) };
	},

	update: async (event) => {
		const guarded = await guardedPhotoForm(event, 'update');
		if ('refusal' in guarded) return guarded.refusal;
		const { form, scope, db } = guarded;
		const now = Date.now();
		const id = belongingId(form);
		const parsed = parseBelongingForm(form, wibTodayString(now));
		if (!parsed.ok)
			return fail(400, {
				action: 'update',
				belongingId: id,
				errors: parsed.errors,
				values: parsed.values
			});
		const photo = await readPhotoField(form);
		if (photo.kind === 'refused')
			return fail(400, {
				action: 'update',
				belongingId: id,
				errors: { photo: photo.message },
				values: belongingFormValues(form)
			});
		const env = getEnv();
		let change: PhotoChange = { kind: 'keep' };
		if (photo.kind === 'image') {
			const stored = await uploadPhoto(env, db, scope.spaceId, 'belongings', photo.image, now);
			if (!stored)
				return fail(503, {
					action: 'update',
					belongingId: id,
					errors: { photo: PHOTO_UPLOAD_FAILED },
					values: belongingFormValues(form)
				});
			change = { kind: 'replace', ...stored };
		} else if (textField(form, 'removePhoto') === 'on') {
			change = { kind: 'remove' };
		}
		const { result, released } = await updateBelonging(
			db,
			scope,
			id,
			parsed.value,
			change,
			expectedUpdatedAt(form),
			now
		);
		const unused = change.kind === 'replace' && result !== 'ok' ? [change.key] : [];
		await cleanUpFiles(env, db, [...released, ...unused], now);
		if (result !== 'ok') return refused(result);
		return { saved: 'updated' as const };
	},

	archive: async (event) => {
		// Access first: a non-member's body is never read (red team FN-28 L1).
		const { scope } = await currentSpaceAccess(event.locals);
		const form = await readFormBody(event.request);
		const now = Date.now();
		const { result, released } = await archiveBelonging(
			event.locals.db,
			scope,
			belongingId(form),
			expectedUpdatedAt(form),
			now
		);
		await cleanUpFiles(getEnv(), event.locals.db, released, now);
		if (result !== 'ok') return refused(result);
		return { saved: 'archived' as const };
	}
};
