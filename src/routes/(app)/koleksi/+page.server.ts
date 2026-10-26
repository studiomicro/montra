import { fail } from '@sveltejs/kit';
import { BELONGING_CHANGED } from '#lib/server/belongings/messages';
import {
	COLLECTIBLE_DEMO_READONLY,
	COLLECTIBLE_LIMIT,
	COLLECTIBLE_NOT_FOUND,
	COLLECTIBLES_LOAD_FAILED
} from '#lib/server/collectibles/messages';
import {
	archiveCollectible,
	collectiblesTotalsOf,
	createCollectible,
	listCollectibles,
	updateCollectible,
	type CollectibleWriteResult
} from '#lib/server/collectibles/repo';
import { collectibleFormValues, parseCollectibleForm } from '#lib/server/collectibles/validation';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { PHOTO_TOO_LARGE, PHOTO_UPLOAD_FAILED } from '#lib/server/photos/messages';
import { cleanUpFiles, type PhotoChange } from '#lib/server/photos/store';
import { readPhotoField, readPhotoForm, uploadPhoto } from '#lib/server/photos/upload';
import { currentSpaceAccess } from '#lib/server/spaces/current';
import { errorLabel } from '#lib/server/util';
import { wibTodayString } from '#lib/shared/dates';
import type { Actions, PageServerLoad } from './$types';

// FN-28. The page works on the session's current space (locals.space, already a re-validated membership). Every
// load and action still passes it through requireSpaceAccess with locals.user, so there is one access rule; an
// id from the form is only ever looked up inside that space, so another space's id and an unknown id get the
// same answer. Photos go through FN-27's shared module (photos/) and are read only through ./[id]/foto.
// Values are the user's own: nothing here (or anywhere in this feature) calls an external price source.

/** Longest collectible id read from a form or URL; ids are UUIDs, anything longer cannot match. */
const ID_MAX_LENGTH = 64;
/** An `updated_at` (epoch ms) as the form carries it. */
const UPDATED_AT = /^\d{1,15}$/;

const idField = (form: FormData) => {
	const id = textField(form, 'collectibleId');
	return id.length > ID_MAX_LENGTH ? '' : id;
};

/** The `updated_at` the form was loaded with; -1 (matches nothing, so "changed meanwhile") when malformed. */
function expectedUpdatedAt(form: FormData): number {
	const value = textField(form, 'updatedAt');
	return UPDATED_AT.test(value) ? Number(value) : -1;
}

function refused(result: Exclude<CollectibleWriteResult, 'ok'>) {
	if (result === 'demo') return fail(400, { error: COLLECTIBLE_DEMO_READONLY });
	return result === 'missing'
		? fail(404, { error: COLLECTIBLE_NOT_FOUND })
		: fail(409, { error: BELONGING_CHANGED });
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const { scope, space } = await currentSpaceAccess(locals);
	const spaceLabel = { kind: space.kind, name: space.kind === 'shared' ? space.name : '' };
	// `?tambah=1` / `?ubah=<id>` open the form without JavaScript (the sheet does it with JavaScript).
	const editId = url.searchParams.get('ubah')?.slice(0, ID_MAX_LENGTH) ?? null;
	const open = url.searchParams.get('tambah') === '1' ? 'add' : editId;
	const today = wibTodayString();
	try {
		const items = await listCollectibles(locals.db, scope.spaceId);
		return {
			space: spaceLabel,
			items,
			totals: collectiblesTotalsOf(items),
			today,
			open,
			loadError: null
		};
	} catch (e) {
		console.error('koleksi: list failed', errorLabel(e));
		return {
			space: spaceLabel,
			items: [],
			totals: [],
			today,
			open: null,
			loadError: COLLECTIBLES_LOAD_FAILED
		};
	}
};

/** Access first (before an 8 MB body is read), then the body within the photo bounds (photos/upload.ts). */
async function guardedUpload(event: Parameters<Actions[string]>[0], action: 'create' | 'update') {
	const { scope } = await currentSpaceAccess(event.locals);
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
		const parsed = parseCollectibleForm(form, wibTodayString(now));
		if (!parsed.ok)
			return fail(400, { action: 'create', errors: parsed.errors, values: parsed.values });
		const photo = await readPhotoField(form);
		if (photo.kind === 'refused')
			return fail(400, {
				action: 'create',
				errors: { photo: photo.message },
				values: collectibleFormValues(form)
			});
		const env = getEnv();
		const stored =
			photo.kind === 'image'
				? await uploadPhoto(env, db, scope.spaceId, 'collectibles', photo.image, now)
				: null;
		if (photo.kind === 'image' && !stored)
			return fail(503, {
				action: 'create',
				errors: { photo: PHOTO_UPLOAD_FAILED },
				values: collectibleFormValues(form)
			});
		const created = await createCollectible(db, scope, parsed.value, stored, now);
		if (!created.ok) {
			if (stored) await cleanUpFiles(env, db, [stored.key], now);
			return created.reason === 'limit'
				? fail(409, { error: COLLECTIBLE_LIMIT })
				: fail(404, { error: COLLECTIBLE_NOT_FOUND });
		}
		return { saved: stored ? ('createdWithPhoto' as const) : ('created' as const) };
	},

	update: async (event) => {
		const guarded = await guardedUpload(event, 'update');
		if ('refusal' in guarded) return guarded.refusal;
		const { form, scope, db } = guarded;
		const now = Date.now();
		const id = idField(form);
		const parsed = parseCollectibleForm(form, wibTodayString(now));
		if (!parsed.ok)
			return fail(400, {
				action: 'update',
				collectibleId: id,
				errors: parsed.errors,
				values: parsed.values
			});
		const photo = await readPhotoField(form);
		if (photo.kind === 'refused')
			return fail(400, {
				action: 'update',
				collectibleId: id,
				errors: { photo: photo.message },
				values: collectibleFormValues(form)
			});
		const env = getEnv();
		let change: PhotoChange = { kind: 'keep' };
		if (photo.kind === 'image') {
			const stored = await uploadPhoto(env, db, scope.spaceId, 'collectibles', photo.image, now);
			if (!stored)
				return fail(503, {
					action: 'update',
					collectibleId: id,
					errors: { photo: PHOTO_UPLOAD_FAILED },
					values: collectibleFormValues(form)
				});
			change = { kind: 'replace', ...stored };
		} else if (textField(form, 'removePhoto') === 'on') {
			change = { kind: 'remove' };
		}
		const { result, released } = await updateCollectible(
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
		const { result, released } = await archiveCollectible(
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
