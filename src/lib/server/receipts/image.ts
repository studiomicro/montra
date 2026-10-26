import { readFormBody } from '../forms';
import { createUserLane } from '../lane';
import type { SanitizedImage } from '../photos/image';
import { PHOTO_FORM_IDLE_MS, PHOTO_FORM_TIMEOUT_MS, readPhotoField } from '../photos/upload';
import { RECEIPT_NO_PHOTO, RECEIPT_PHOTO_TOO_LARGE } from './messages';

/**
 * The receipt photo of a /riwayat/struk request (FN-15), checked by FN-27's one image sanitiser
 * (`readPhotoField` → `sanitizeImage`: sniffed JPEG/PNG/WebP, metadata stripped, dimension bounds) and then by
 * what the provider accepts inline, all before any provider call. Held in memory for the request only.
 */

/**
 * Largest photo read (after sanitising). Anthropic accepts 10 MB of base64 per image on its API
 * (docs.anthropic.com › Vision, re-checked 2026-10-09), about 7.5 MB of bytes; 5 MiB keeps a margin and bounds
 * memory. The browser re-encodes to at most RECEIPT_MAX_SIDE px first, so a real upload is far smaller.
 */
const RECEIPT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Largest side the provider accepts (docs.anthropic.com › Vision: 8000×8000 px). */
const RECEIPT_IMAGE_MAX_SIDE = 8000;
/** Largest /riwayat/struk form: the photo plus the review fields (80 items of bounded text). */
const RECEIPT_FORM_MAX_BYTES = RECEIPT_IMAGE_MAX_BYTES + 64 * 1024;
/**
 * Receipt requests one isolate holds at once (reading the body, sanitising, waiting for the provider or saving):
 * each may hold the body, the sanitised copy and its base64 form (about 3 × 5 MiB plus the request JSON). One per
 * user, so one user cannot occupy the lane (the same posture as FN-16a's statement lane).
 */
const RECEIPT_LANE_MAX = 3;

/** Whether the request announces a body past RECEIPT_FORM_MAX_BYTES (refused before reading it, 413). */
export const announcesTooLargeReceipt = (request: Request): boolean =>
	Number(request.headers.get('content-length')) > RECEIPT_FORM_MAX_BYTES;

/** The form of a receipt request, read within the receipt bounds and the photo deadlines (408 when it stalls). */
export const readReceiptForm = (request: Request): Promise<FormData> =>
	readFormBody(request, RECEIPT_FORM_MAX_BYTES, PHOTO_FORM_TIMEOUT_MS, PHOTO_FORM_IDLE_MS);

export type ReceiptPhoto = { ok: true; image: SanitizedImage } | { ok: false; message: string };

/** The form's `photo`: a checked image within the provider's bounds, or why not (FN-27 messages reused). */
export async function readReceiptPhoto(form: FormData): Promise<ReceiptPhoto> {
	const field = await readPhotoField(form, 'photo');
	if (field.kind === 'none') return { ok: false, message: RECEIPT_NO_PHOTO };
	if (field.kind === 'refused') return { ok: false, message: field.message };
	const { image } = field;
	if (
		image.bytes.length > RECEIPT_IMAGE_MAX_BYTES ||
		image.width > RECEIPT_IMAGE_MAX_SIDE ||
		image.height > RECEIPT_IMAGE_MAX_SIDE
	)
		return { ok: false, message: RECEIPT_PHOTO_TOO_LARGE };
	return { ok: true, image };
}

/**
 * A place in this isolate's receipt lane, taken before the request body is read: null when the user already has
 * a receipt request in flight or RECEIPT_LANE_MAX are held (answered 503 with Retry-After, body unread). Call the
 * returned release once, on every exit.
 */
export const reserveReceiptSlot = createUserLane(RECEIPT_LANE_MAX);
