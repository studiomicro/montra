/**
 * EXIF orientation (FN-16g camera photos, and FN-27's photo sanitiser): a portrait phone photo is often stored
 * sideways with an Orientation tag (1–8) saying how to turn it upright. Browsers apply it when decoding with
 * `imageOrientation: 'from-image'`; for one that does not, the OCR module reads the tag here and turns the canvas
 * itself. Pure and bounded: only the first 64 KB of a JPEG are read.
 */

/** Bytes of a JPEG searched for its EXIF segment (APP1 sits right after SOI in camera files). */
const EXIF_SCAN_BYTES = 64 * 1024;

type Reader = (o: number) => number | null;

/** The Orientation (1–8) in an APP1 payload `[at, end)`, or null. Reads IFD0 only, in place. */
export function exifOrientationAt(b: Uint8Array, at: number, end: number): number | null {
	const limit = Math.min(end, b.length);
	if (limit - at < 14) return null;
	const head = String.fromCharCode(...b.subarray(at, at + 6));
	if (head !== 'Exif\0\0') return null;
	const tiff = at + 6;
	const order = String.fromCharCode(b[tiff]!, b[tiff + 1]!);
	if (order !== 'II' && order !== 'MM') return null;
	const le = order === 'II';
	const r16: Reader = (o) => {
		const p = tiff + o;
		if (o < 0 || p + 2 > limit) return null;
		return le ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!;
	};
	const r32: Reader = (o) => {
		const p = tiff + o;
		if (o < 0 || p + 4 > limit) return null;
		return le
			? (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16)) + b[p + 3]! * 0x1000000
			: b[p]! * 0x1000000 + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!);
	};
	const ifd = r32(4);
	if (ifd === null) return null;
	const count = r16(ifd);
	if (count === null) return null;
	for (let i = 0; i < Math.min(count, 512); i++) {
		const entry = ifd + 2 + i * 12;
		const tag = r16(entry);
		if (tag === null) return null;
		if (tag === 0x0112) {
			const value = r16(entry + 8);
			return value !== null && value >= 1 && value <= 8 ? value : null;
		}
	}
	return null;
}

/** A JPEG's EXIF Orientation, 1 (as stored) when it has none or is not a JPEG. */
export function readExifOrientation(bytes: Uint8Array): number {
	const b = bytes.subarray(0, EXIF_SCAN_BYTES);
	if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
	let pos = 2;
	while (pos + 4 <= b.length) {
		if (b[pos] !== 0xff) return 1;
		const marker = b[pos + 1]!;
		// Start of scan or end of image: no more metadata segments.
		if (marker === 0xda || marker === 0xd9) return 1;
		if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			pos += marker === 0xff ? 1 : 2;
			continue;
		}
		const length = (b[pos + 2]! << 8) | b[pos + 3]!;
		if (length < 2) return 1;
		if (marker === 0xe1) {
			const found = exifOrientationAt(b, pos + 4, pos + 2 + length);
			if (found !== null) return found;
		}
		pos += 2 + length;
	}
	return 1;
}

/** The upright size of a `width`×`height` image stored with `orientation` (5–8 swap the sides). */
export function orientedSize(
	orientation: number,
	width: number,
	height: number
): { width: number; height: number } {
	return orientation >= 5 && orientation <= 8
		? { width: height, height: width }
		: { width, height };
}

/**
 * The canvas transform `[a, b, c, d, e, f]` (`setTransform`) that draws a stored `width`×`height` image upright
 * onto a canvas of `orientedSize`: x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
export function orientationTransform(
	orientation: number,
	width: number,
	height: number
): [number, number, number, number, number, number] {
	switch (orientation) {
		case 2:
			return [-1, 0, 0, 1, width, 0];
		case 3:
			return [-1, 0, 0, -1, width, height];
		case 4:
			return [1, 0, 0, -1, 0, height];
		case 5:
			return [0, 1, 1, 0, 0, 0];
		case 6:
			return [0, 1, -1, 0, height, 0];
		case 7:
			return [0, -1, -1, 0, height, width];
		case 8:
			return [0, -1, 1, 0, 0, width];
		default:
			return [1, 0, 0, 1, 0, 0];
	}
}
