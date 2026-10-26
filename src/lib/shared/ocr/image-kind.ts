import { sniffStatementFile } from '../statements/detect.ts';

/**
 * What the on-device OCR accepts and how big it may be (FN-16g, PRD owner default A5), decided from the bytes:
 * the kind by magic number (never the name or MIME type) and an image's declared size from its header, refused
 * before anything is decoded. Pure, so the limits are unit-tested.
 */

/** Largest file one pick may hold (the same 15 MB as a statement upload). */
export const OCR_MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Images per run (pages in the order added). */
export const OCR_MAX_IMAGES = 5;
/** PDF pages read per run; the rest are reported as not processed. */
export const OCR_MAX_PDF_PAGES = 12;
/** Largest declared source image (a 48 MP phone photo fits; a planted 100 MP header does not). */
export const OCR_MAX_DECLARED_PIXELS = 64_000_000;
/**
 * Largest declared PNG, WebP or HEIC image (red team L3). The browser may decode these at full size before any
 * scaling (RGBA, 4 bytes a pixel), so the cap keeps that to about 100 MB; a JPEG is cut down while decoding.
 */
const OCR_MAX_FULL_DECODE_PIXELS = 24_000_000;
/** What one page is scaled to before reading: long side and pixel count. */
const OCR_MAX_LONG_SIDE = 3000;
const OCR_MAX_PAGE_PIXELS = 6_000_000;
/** Time budget of a whole run and of one page. */
export const OCR_RUN_TIMEOUT_MS = 5 * 60_000;
export const OCR_PAGE_TIMEOUT_MS = 60_000;

export type OcrFileKind = 'png' | 'jpeg' | 'webp' | 'heic' | 'pdf' | 'unknown';

const ascii = (b: Uint8Array, at: number, length: number) =>
	at + length > b.length ? '' : String.fromCharCode(...b.subarray(at, at + length));

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** The file kind by its first bytes. */
export function sniffOcrFile(bytes: Uint8Array): OcrFileKind {
	if (
		bytes.length >= 8 &&
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)
	)
		return 'png';
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return 'jpeg';
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
	if (ascii(bytes, 4, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 4))) return 'heic';
	if (sniffStatementFile(bytes.subarray(0, 1024)) === 'pdf') return 'pdf';
	return 'unknown';
}

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) =>
	b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

/** SOFn markers that carry the frame size (C4 DHT, C8 JPG and CC DAC are not frames). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Segments walked before giving up on a JPEG header (real photos have tens). */
const MAX_SEGMENTS = 4096;

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
	let pos = 2;
	for (let n = 0; n < MAX_SEGMENTS && pos + 4 <= b.length; n++) {
		if (b[pos] !== 0xff) return null;
		const marker = b[pos + 1]!;
		if (marker === 0xff) {
			pos += 1;
			continue;
		}
		if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			pos += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return null;
		const length = u16be(b, pos + 2);
		if (length < 2) return null;
		if (isSof(marker)) {
			if (pos + 9 > b.length) return null;
			return { height: u16be(b, pos + 5), width: u16be(b, pos + 7) };
		}
		pos += 2 + length;
	}
	return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
	const chunk = ascii(b, 12, 4);
	const data = 20;
	if (chunk === 'VP8X' && b.length >= data + 10)
		return { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 };
	if (chunk === 'VP8 ' && b.length >= data + 10)
		return { width: u16le(b, data + 6) & 0x3fff, height: u16le(b, data + 8) & 0x3fff };
	if (chunk === 'VP8L' && b.length >= data + 5 && b[data] === 0x2f) {
		const bits = b[data + 1]! | (b[data + 2]! << 8) | (b[data + 3]! << 16) | (b[data + 4]! << 24);
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
	}
	return null;
}

/** The image size its header declares (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X); null when unreadable. */
export function declaredSize(
	bytes: Uint8Array,
	kind: OcrFileKind
): { width: number; height: number } | null {
	let size: { width: number; height: number } | null = null;
	if (kind === 'png' && bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR')
		size = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
	else if (kind === 'jpeg') size = jpegSize(bytes);
	else if (kind === 'webp') size = webpSize(bytes);
	return size && size.width > 0 && size.height > 0 ? size : null;
}

/** Most top-level boxes walked to find a HEIC's `meta` box (a phone photo has a handful). */
const HEIC_MAX_TOP_BOXES = 64;
/** Largest `meta` box read (item info and properties: a phone photo's is a few to tens of KB). */
export const HEIC_MAX_META_BYTES = 512 * 1024;

/** Reads bytes `[start, end)` of the picked file. */
export type ByteReader = (start: number, end: number) => Promise<Uint8Array>;

/**
 * The bytes of a HEIC's top-level `meta` box (red team L5), found by walking the top-level boxes by their sizes
 * from the file's start: an `ispe`-shaped decoy anywhere else (in `mdat`, a `free` box) is never read, and a
 * `meta` box after a large `mdat` is still found. Null when there is none within HEIC_MAX_TOP_BOXES, it is larger
 * than HEIC_MAX_META_BYTES, or the box sizes do not fit the file.
 */
export async function heicMetaBox(read: ByteReader, fileBytes: number): Promise<Uint8Array | null> {
	let at = 0;
	for (let n = 0; n < HEIC_MAX_TOP_BOXES && at + 8 <= fileBytes; n++) {
		const head = await read(at, Math.min(fileBytes, at + 16));
		if (head.length < 8) return null;
		let size = u32be(head, 0);
		let header = 8;
		if (size === 1) {
			if (head.length < 16) return null;
			size = u32be(head, 8) * 0x100000000 + u32be(head, 12);
			header = 16;
		} else if (size === 0) size = fileBytes - at;
		if (size < header || at + size > fileBytes) return null;
		if (ascii(head, 4, 4) === 'meta') {
			if (size > HEIC_MAX_META_BYTES) return null;
			const meta = await read(at, at + size);
			return meta.length === size ? meta : null;
		}
		at += size;
	}
	return null;
}

/**
 * The largest image a HEIC `meta` box declares (`ispe` boxes: size 20, `ispe`, version/flags, width, height; the
 * grid image and its tiles each have one). Null when it holds none.
 */
function heicSize(b: Uint8Array): { width: number; height: number } | null {
	let best: { width: number; height: number } | null = null;
	for (let i = 4; i + 16 <= b.length; i++) {
		if (b[i] !== 0x69 || b[i + 1] !== 0x73 || b[i + 2] !== 0x70 || b[i + 3] !== 0x65) continue;
		if (u32be(b, i - 4) !== 20) continue;
		const width = u32be(b, i + 8);
		const height = u32be(b, i + 12);
		if (width > 0 && height > 0 && (!best || width * height > best.width * best.height))
			best = { width, height };
	}
	return best;
}

export type OcrInputRefusal =
	/** Not a PNG, JPEG, WebP, HEIC image or a PDF. */
	| 'unsupported'
	| 'too_large'
	/** More than OCR_MAX_IMAGES images, or a PDF together with other files. */
	| 'too_many'
	/** The header declares more than OCR_MAX_DECLARED_PIXELS. */
	| 'too_many_pixels'
	/** A PNG, WebP or HEIC declares more than OCR_MAX_FULL_DECODE_PIXELS. */
	| 'too_big_to_decode'
	| 'malformed';

export interface OcrInput {
	kind: Exclude<OcrFileKind, 'unknown'>;
	/** Declared size; null for HEIC (checked here, decoded as is: its rotation box is the browser's) and PDF. */
	size: { width: number; height: number } | null;
}

/**
 * Checks one picked file before it is decoded, from its first bytes (`bytes`) and, for a HEIC, its `meta` box
 * (`heicMetaBox`; null when none was found: refused as malformed).
 */
export function checkOcrFile(
	bytes: Uint8Array,
	fileBytes: number,
	heicMeta: Uint8Array | null = null
): OcrInput | { refusal: OcrInputRefusal } {
	if (fileBytes > OCR_MAX_FILE_BYTES) return { refusal: 'too_large' };
	const kind = sniffOcrFile(bytes);
	if (kind === 'unknown') return { refusal: 'unsupported' };
	if (kind === 'pdf') return { kind, size: null };
	const size = kind === 'heic' ? (heicMeta ? heicSize(heicMeta) : null) : declaredSize(bytes, kind);
	if (!size) return { refusal: 'malformed' };
	const pixels = size.width * size.height;
	if (pixels > OCR_MAX_DECLARED_PIXELS) return { refusal: 'too_many_pixels' };
	if (kind !== 'jpeg' && pixels > OCR_MAX_FULL_DECODE_PIXELS)
		return { refusal: 'too_big_to_decode' };
	return { kind, size: kind === 'heic' ? null : size };
}

/** A run's files together: up to OCR_MAX_IMAGES images, or one PDF alone. */
export function checkOcrBatch(kinds: readonly OcrInput['kind'][]): OcrInputRefusal | null {
	const pdfs = kinds.filter((k) => k === 'pdf').length;
	if (pdfs > 0 && kinds.length > 1) return 'too_many';
	if (kinds.length > OCR_MAX_IMAGES) return 'too_many';
	return null;
}

/** The size a page is read at: scaled down (never up) to OCR_MAX_LONG_SIDE and OCR_MAX_PAGE_PIXELS. */
export function readingSize(
	width: number,
	height: number
): { width: number; height: number; scale: number } {
	const scale = Math.min(
		1,
		OCR_MAX_LONG_SIDE / Math.max(width, height),
		Math.sqrt(OCR_MAX_PAGE_PIXELS / (width * height))
	);
	return {
		width: Math.max(1, Math.floor(width * scale)),
		height: Math.max(1, Math.floor(height * scale)),
		scale
	};
}
