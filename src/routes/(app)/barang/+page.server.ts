import { error, fail, redirect } from '@sveltejs/kit';
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
import { readFormBody, textField } from '#lib/server/forms';
import { PHOTO_TOO_LARGE, PHOTO_UPLOAD_FAILED } from '#lib/server/photos/messages';
import { cleanUpFiles, type PhotoChange } from '#lib/server/photos/store';
import { readPhotoField, readPhotoForm, uploadPhoto } from '#lib/server/photos/upload';
import { requireSpaceAccess, type SpaceScope } from '#lib/server/spaces/access';
import { belongingValue } from '#lib/shared/belongings';
import { wibTodayString } from '#lib/shared/dates';
import type { Actions, PageServerLoad } from './$types';

// The page works on the session's current space (locals.space, already a re-validated membership). Every load
// and action still passes it through requireSpaceAccess with locals.user, so there is one access rule; an id
// from the form is only ever looked up inside that space, so another space's id and an unknown id get the
// same answer. Photos are read only through ./[id]/foto (the same check), never from a public R2 URL.

/** Longest belonging id read from a form or URL; ids are UUIDs, anything longer cannot match. */
const ID_MAX_LENGTH = 64;
/** An `updated_at` (epoch ms) as the form carries it. */
const UPDATED_AT = /^\d{1,15}$/;

async function belongingScope(locals: App.Locals) {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	if (!locals.space) error(404, 'Not found');
	const access = await requireSpaceAccess(locals.db, user.id, locals.space.id);
	const scope: SpaceScope = { spaceId: access.space.id, userId: user.id };
	return { scope, space: access.space };
}

const idField = (form: FormData) => {
	const id = textField(form, 'belongingId');
	return id.length > ID_MAX_LENGTH ? '' : id;
};

/** The `updated_at` the form was loaded with; -1 (matches nothing, so "changed meanwhile") when malformed. */
function expectedUpdatedAt(form: FormData): number {
	const value = textField(form, 'updatedAt');
	return UPDATED_AT.test(value) ? Number(value) : -1;
}

function refused(result: Exclude<BelongingWriteResult, 'ok'>) {
	if (result === 'demo') return fail(400, { error: DEMO_READONLY });
	return result === 'missing'
		? fail(404, { error: BELONGING_NOT_FOUND })
		: fail(409, { error: BELONGING_CHANGED });
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const { scope, space } = await belongingScope(locals);
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

/**
 * Access first (before an 8 MB body is read), then the body within the photo bounds. A body announced past the
 * cap is refused with a clear message without reading it.
 */
async function guardedUpload(event: Parameters<Actions[string]>[0], action: 'create' | 'update') {
	const { scope } = await belongingScope(event.locals);
	const form = await readPhotoForm(event.request);
	if (!form)
		return {
			refusal: fail(413, { action, error: PHOTO_TOO_LARGE, errors: {}, values: null })
		} as const;
	return { form, scope, db: event.locals.db } as const;
}

export const actions: Actions = {
	create: async (event) => {
		const guarded = await guardedUpload(event, 'create');
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
		const guarded = await guardedUpload(event, 'update');
		if ('refusal' in guarded) return guarded.refusal;
		const { form, scope, db } = guarded;
		const now = Date.now();
		const id = idField(form);
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
		const { scope } = await belongingScope(event.locals);
		const form = await readFormBody(event.request);
		const now = Date.now();
		const { result, released } = await archiveBelonging(
			event.locals.db,
			scope,
			idField(form),
			expectedUpdatedAt(form),
			now
		);
		await cleanUpFiles(getEnv(), event.locals.db, released, now);
		if (result !== 'ok') return refused(result);
		return { saved: 'archived' as const };
	}
};
