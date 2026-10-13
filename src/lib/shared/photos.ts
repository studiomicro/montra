/**
 * Photos the user keeps (FN-27 belongings; FN-28 collectibles reuse this): the accepted types, sniffed from the
 * bytes on the server, never taken from the file name or the browser's type.
 */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];
/** Largest photo file accepted (FN-27 Owner decision 4: 8 MiB). */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/** The file picker's `accept`: these three only, so iOS converts a HEIC photo to JPEG before uploading. */
export const PHOTO_ACCEPT = PHOTO_TYPES.join(',');
/**
 * Longest side of an item photo as it leaves the device (FN-45 Owner decision 3): a larger photo, or one over
 * PHOTO_MAX_BYTES, is re-encoded on the device first; a smaller one is sent as picked.
 */
export const PHOTO_UPLOAD_MAX_SIDE = 2560;
/** JPEG quality of a photo re-encoded on the device (the same as receipts). */
export const PHOTO_JPEG_QUALITY = 0.85;

/**
 * The type the first bytes prove, or null. Never the file name, never the client's Content-Type. The server's
 * upload check and the photo picker's drop check (FN-45) both use it.
 */
export function sniffImageType(bytes: Uint8Array): PhotoType | null {
	const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return 'image/jpeg';
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length >= 8 && png.every((v, i) => bytes[i] === v)) return 'image/png';
	if (bytes.length >= 12 && ascii(0) === 'RIFF' && ascii(8) === 'WEBP') return 'image/webp';
	return null;
}

/** ISO-BMFF brands of the HEIF family (HEIC photos from phone cameras and galleries). */
const HEIF_BRANDS = new Set([
	'heic',
	'heix',
	'hevc',
	'hevx',
	'heim',
	'heis',
	'hevm',
	'hevs',
	'mif1',
	'msf1'
]);

/** How many leading bytes isHeifBytes reads. */
export const HEIF_SNIFF_BYTES = 32;

/**
 * Whether the bytes start an HEIF/HEIC file: an ISO-BMFF `ftyp` box whose major or a compatible brand (within
 * the first HEIF_SNIFF_BYTES) is in the HEIF family. Read from the bytes only, never the name or the browser's
 * type; shared by the picker (before upload) and the server (its refusal message).
 */
export function isHeifBytes(bytes: Uint8Array): boolean {
	if (bytes.length < 12) return false;
	const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
	if (text(4) !== 'ftyp') return false;
	const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
	if (HEIF_BRANDS.has(text(8))) return true;
	// Brands follow the major brand (8–11) and the minor version (12–15), up to the end of the box.
	const end = Math.min(boxSize, bytes.length, HEIF_SNIFF_BYTES);
	for (let at = 16; at + 4 <= end; at += 4) {
		if (HEIF_BRANDS.has(text(at))) return true;
	}
	return false;
}
