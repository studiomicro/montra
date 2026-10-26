import { fail } from '@sveltejs/kit';
import { currentSpaceAccess } from '../spaces/current';
import { PHOTO_TOO_LARGE } from './messages';
import { readPhotoForm } from './upload';

/**
 * A photo form action's start (FN-27 belongings, FN-28 collectibles): access first (before an 8 MB body is read),
 * then the body within the photo bounds (upload.ts). A body announced past the cap is refused with a clear
 * message without reading it (`refusal`, a 413 for `action`).
 */
export async function guardedPhotoForm(
	event: { locals: App.Locals; request: Request },
	action: 'create' | 'update'
) {
	const { scope } = await currentSpaceAccess(event.locals);
	const form = await readPhotoForm(event.request);
	if (!form)
		return {
			refusal: fail(413, { action, error: PHOTO_TOO_LARGE, errors: {}, values: null })
		} as const;
	return { form, scope, db: event.locals.db } as const;
}
