import { RECEIPT_JPEG_QUALITY, RECEIPT_MAX_SIDE } from '#lib/shared/receipts';
import { reencodePhoto } from '#lib/ui/photos/reencode';

/** Longest side of the on-page preview, a `data:` URL (the CSP's img-src allows `self` and `data:` only). */
const PREVIEW_MAX_SIDE = 480;

/**
 * The receipt photo as it leaves the device (FN-15): the shared re-encode (photos/reencode.ts) at
 * RECEIPT_MAX_SIDE and RECEIPT_JPEG_QUALITY, so the upload and the provider's cost are bounded, the orientation
 * is baked in and every metadata block (location included) is dropped before a byte is sent. Where the browser
 * cannot decode or draw it, the original file is sent and the server's sanitiser (FN-27) is the backstop.
 * `preview`: a small JPEG `data:` URL, or null.
 */
export async function reencodeReceiptPhoto(
	file: File
): Promise<{ file: File; preview: string | null }> {
	const encoded = await reencodePhoto(file, {
		maxSide: RECEIPT_MAX_SIDE,
		quality: RECEIPT_JPEG_QUALITY,
		name: 'struk.jpg',
		previewSide: PREVIEW_MAX_SIDE
	});
	return { file: encoded.file, preview: encoded.preview };
}
