import { isHeifBytes, PHOTO_MAX_BYTES } from '#lib/shared/photos';
import type { Db } from '../db';
import { readFormBody } from '../forms';
import { errorLabel } from '../util';
import { sanitizeImage, type SanitizedImage } from './image';
import {
	PHOTO_DIMENSIONS,
	PHOTO_HEIF,
	PHOTO_NOT_IMAGE,
	PHOTO_TOO_LARGE,
	PHOTO_UNREADABLE
} from './messages';
import { newPhotoKey, putPhoto, reservePhotoKey, type PhotoKind } from './store';

/** Largest form a photo upload sends: the photo plus the item's short text fields. */
const PHOTO_FORM_MAX_BYTES = PHOTO_MAX_BYTES + 64 * 1024;
/**
 * Wall-clock limit for an upload body (R17): 8 MiB in 120 s needs about 0.6 Mbit/s, which slow mobile uplinks
 * manage. The buffer grows only with bytes received, so a slow sender holds only what it sent.
 */
export const PHOTO_FORM_TIMEOUT_MS = 120_000;
/** No bytes for this long ends the upload with 408 (R17): a stalled connection is not held for 120 s. */
export const PHOTO_FORM_IDLE_MS = 20_000;

/** Whether the request announces a body past PHOTO_FORM_MAX_BYTES (refused before reading it). */
const announcesTooLarge = (request: Request): boolean =>
	Number(request.headers.get('content-length')) > PHOTO_FORM_MAX_BYTES;

/**
 * The body of a form that may carry a photo, read within the photo bounds (size, total and idle deadlines);
 * null when the request announces a body past PHOTO_FORM_MAX_BYTES (refused without reading it: the caller
 * answers 413 with PHOTO_TOO_LARGE). Call only after the access check.
 */
export async function readPhotoForm(request: Request): Promise<FormData | null> {
	if (announcesTooLarge(request)) return null;
	return readFormBody(request, PHOTO_FORM_MAX_BYTES, PHOTO_FORM_TIMEOUT_MS, PHOTO_FORM_IDLE_MS);
}

export type PhotoField =
	| { kind: 'none' }
	| { kind: 'image'; image: SanitizedImage }
	| { kind: 'refused'; message: string };

const REFUSALS = {
	type: PHOTO_NOT_IMAGE,
	malformed: PHOTO_UNREADABLE,
	dimensions: PHOTO_DIMENSIONS
} as const;

/**
 * The form's photo file: none (no file chosen), a checked and metadata-free image (image.ts), or a refusal
 * message. The file's name and browser-given type are never read.
 */
export async function readPhotoField(form: FormData, name = 'photo'): Promise<PhotoField> {
	const value = form.get(name);
	if (!(value instanceof File) || value.size === 0) return { kind: 'none' };
	// The form lets go of the file once its bytes are read (red team L3: at most input + output held).
	form.delete(name);
	if (value.size > PHOTO_MAX_BYTES) return { kind: 'refused', message: PHOTO_TOO_LARGE };
	const bytes = new Uint8Array(await value.arrayBuffer());
	const result = sanitizeImage(bytes);
	if (result.ok) return { kind: 'image', image: result };
	// HEIC is still refused (FN-45), but with how to fix it instead of the generic type message.
	if (result.reason === 'type' && isHeifBytes(bytes))
		return { kind: 'refused', message: PHOTO_HEIF };
	return { kind: 'refused', message: REFUSALS[result.reason] };
}

/**
 * Writes a checked image to R2 under a fresh key in `spaceId`'s namespace, the key reserved for deletion first
 * (photos/store.ts). The caller then stores the key on its row in a batch that also calls `keepKey`. Null when
 * D1 or R2 failed: nothing points at the key, and the sweep removes whatever was written.
 */
export async function uploadPhoto(
	env: { FILES: R2Bucket },
	db: Db,
	spaceId: string,
	kind: PhotoKind,
	image: SanitizedImage,
	now: number
): Promise<{ key: string; type: SanitizedImage['type'] } | null> {
	const key = newPhotoKey(spaceId, kind);
	try {
		await reservePhotoKey(db, key, now);
		await putPhoto(env.FILES, key, image);
	} catch (e) {
		console.warn('photos: upload failed', errorLabel(e));
		return null;
	}
	return { key, type: image.type };
}
