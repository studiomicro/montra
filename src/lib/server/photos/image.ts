import { exifOrientationAt } from '../../shared/ocr/exif.ts';
import { sniffImageType, type PhotoType } from '../../shared/photos.ts';

/** Longest side a stored photo may have (a 48 MP phone photo is 8064 px wide). */
export const PHOTO_MAX_SIDE = 10_000;
/** Most pixels a stored photo may have: bounds what a browser decodes when it shows the thumbnail. */
export const PHOTO_MAX_PIXELS = 50_000_000;
/**
 * Most markers / chunks one file may have, kept or dropped (red team FN-27 M1). Real photos have tens; a
 * flood of empty segments is refused before it costs memory or CPU.
 */
export const MAX_SEGMENTS = 4096;
/**
 * Largest colour profile kept (JPEG ICC_PROFILE segments together, WebP ICCP). Real sRGB / Display P3
 * profiles are 0.5–4 KiB; anything larger is dropped, never refused.
 */
export const ICC_MAX_BYTES = 64 * 1024;

export type SanitizedImage = {
	ok: true;
	type: PhotoType;
	bytes: Uint8Array;
	width: number;
	height: number;
};
/** `type`: not a JPEG, PNG or WebP by its bytes. `malformed`: does not parse or is not allowed. `dimensions`: too big. */
export type ImageRefusal = { ok: false; reason: 'type' | 'malformed' | 'dimensions' };

class Malformed extends Error {}
class TooLarge extends Error {}

const u16be = (b: Uint8Array, at: number) => {
	if (at + 2 > b.length) throw new Malformed();
	return (b[at]! << 8) | b[at + 1]!;
};
const u32be = (b: Uint8Array, at: number) => {
	if (at + 4 > b.length) throw new Malformed();
	return b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
};
const u16le = (b: Uint8Array, at: number) => {
	if (at + 2 > b.length) throw new Malformed();
	return b[at]! | (b[at + 1]! << 8);
};
const u24le = (b: Uint8Array, at: number) => {
	if (at + 3 > b.length) throw new Malformed();
	return b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
};
const u32le = (b: Uint8Array, at: number) => {
	if (at + 4 > b.length) throw new Malformed();
	return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;
};
/** Four (or `length`) bytes as Latin-1 text, read in place (no array of the bytes is made). */
function ascii(b: Uint8Array, at: number, length: number): string {
	if (at + length > b.length) throw new Malformed();
	let s = '';
	for (let i = 0; i < length; i++) s += String.fromCharCode(b[at + i]!);
	return s;
}

/**
 * The single output buffer of one sanitise run: allocated once, never larger than the input plus a few bytes
 * of rewritten headers (red team M1/L3: no per-segment arrays, at most input + output in memory).
 */
class Writer {
	readonly out: Uint8Array;
	at = 0;
	constructor(capacity: number) {
		this.out = new Uint8Array(capacity);
	}
	copy(src: Uint8Array, start: number, end: number) {
		if (end < start || this.at + (end - start) > this.out.length) throw new Malformed();
		this.out.set(src.subarray(start, end), this.at);
		this.at += end - start;
	}
	bytes(...values: number[]) {
		if (this.at + values.length > this.out.length) throw new Malformed();
		for (const v of values) this.out[this.at++] = v;
	}
	result() {
		return this.out.subarray(0, this.at);
	}
}

/** Refuses a frame past the side or pixel cap, at the header that declares it. */
function checkSize(width: number, height: number) {
	if (width === 0 || height === 0) throw new Malformed();
	if (width > PHOTO_MAX_SIDE || height > PHOTO_MAX_SIDE || width * height > PHOTO_MAX_PIXELS)
		throw new TooLarge();
}

// The type sniff is shared with the photo picker (FN-45 red team 1), so both refuse the same files.
export { sniffImageType };

// ---------------------------------------------------------------------------------------------- JPEG

/** SOFn markers that carry the frame size (C4 DHT, C8 JPG and CC DAC are not frames). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Table and scan segments a JPEG keeps besides SOF: DHT, DQT, DRI, SOS. */
const JPEG_KEEP = new Set([0xc4, 0xdb, 0xdd, 0xda]);

/** A fresh APP1 holding only the Orientation tag (34 bytes), so a portrait phone photo still shows upright. */
function writeOrientation(w: Writer, orientation: number) {
	w.bytes(0xff, 0xe1, 0, 34);
	w.bytes(0x45, 0x78, 0x69, 0x66, 0, 0); // "Exif\0\0"
	w.bytes(0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8); // big-endian TIFF header, IFD0 at 8
	w.bytes(0, 1); // one entry
	w.bytes(0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0); // Orientation, SHORT, 1
	w.bytes(0, 0, 0, 0); // no next IFD
}

/** `ICC_PROFILE\0`: the signature of an APP2 colour-profile segment. */
const ICC_SIGNATURE = 'ICC_PROFILE\0';
/** Most ICC segments considered (a 64 KiB profile needs two). */
const MAX_ICC_SEGMENTS = 8;

/** Smallest ICC profile: its fixed header is 128 bytes. */
const ICC_HEADER_BYTES = 128;

/**
 * Whether the `length` profile bytes at `at` look like a real ICC profile (red team N1): at least the 128-byte
 * header, its size field (bytes 0–3) equal to `length`, and the `acsp` signature at offset 36. Tags are not
 * parsed or rewritten.
 */
function iccHeaderOk(b: Uint8Array, at: number, length: number): boolean {
	return (
		length >= ICC_HEADER_BYTES &&
		at + 40 <= b.length &&
		u32be(b, at) === length &&
		ascii(b, at + 36, 4) === 'acsp'
	);
}

/**
 * Whether the APP2 segments at `[start, end)` form one complete ICC profile: each payload is the signature,
 * its 1-based sequence number and the segment count, in order 1…count with the same count, profile data
 * together at most ICC_MAX_BYTES, and the joined profile passes iccHeaderOk (its header is read from the
 * first segment, which must hold at least 40 bytes). Anything else (MPF, FlashPix, a broken sequence, a blob
 * that is not a profile) is dropped as a whole.
 */
function validIcc(b: Uint8Array, segments: readonly { start: number; end: number }[]): boolean {
	if (segments.length === 0 || segments.length > MAX_ICC_SEGMENTS) return false;
	let total = 0;
	for (const [i, { start, end }] of segments.entries()) {
		const payload = start + 4;
		if (end - payload <= 14 || ascii(b, payload, 12) !== ICC_SIGNATURE) return false;
		if (b[payload + 12] !== i + 1 || b[payload + 13] !== segments.length) return false;
		total += end - payload - 14;
	}
	const first = segments[0]!;
	const firstData = first.start + 4 + 14;
	if (first.end - firstData < 40) return false;
	return total <= ICC_MAX_BYTES && iccHeaderOk(b, firstData, total);
}

/** A fresh APP0 JFIF 1.01 with no thumbnail, keeping only the density from the original (16 bytes). */
function writeJfif(w: Writer, b: Uint8Array, at: number, end: number) {
	const units = end - at >= 12 ? b[at + 7]! : 0;
	const x = end - at >= 12 ? u16be(b, at + 8) : 1;
	const y = end - at >= 12 ? u16be(b, at + 10) : 1;
	w.bytes(0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, units > 2 ? 0 : units);
	w.bytes(x >> 8, x & 0xff, y >> 8, y & 0xff, 0, 0);
}

/**
 * Rebuilds a JPEG by allow-list, in one pass into one buffer: SOI, DQT, DHT, DRI, exactly one SOFn, SOS with
 * its entropy-coded data, EOI; an APP0 JFIF is rewritten without thumbnail; the EXIF Orientation is carried
 * into a new minimal APP1; a complete ICC_PROFILE (APP2, validIcc) is kept so colours stay right. Every other
 * marker (EXIF/GPS, XMP, MPF, IPTC, comments, unknown) is dropped. RSTn or TEM outside a scan, a second frame
 * or more than MAX_SEGMENTS markers are refused. Whatever follows EOI (an Ultra HDR gain map, a motion-photo
 * video, MPF images) is cut without being parsed.
 */
function sanitizeJpeg(b: Uint8Array) {
	const w = new Writer(b.length + 64);
	w.bytes(0xff, 0xd8);
	let pos = 2;
	let width = 0;
	let height = 0;
	let scans = 0;
	let segments = 0;
	let orientation: number | null = null;
	let wroteHeader = false;
	let wroteJfif = false;
	const icc: { start: number; end: number }[] = [];
	const header = () => {
		// Orientation and the colour profile go before the first table or frame segment.
		if (wroteHeader) return;
		wroteHeader = true;
		if (orientation !== null) writeOrientation(w, orientation);
		if (validIcc(b, icc)) for (const { start, end } of icc) w.copy(b, start, end);
	};
	for (;;) {
		if (++segments > MAX_SEGMENTS) throw new Malformed();
		if (pos >= b.length || b[pos] !== 0xff) throw new Malformed();
		while (pos < b.length && b[pos] === 0xff) pos++;
		if (pos >= b.length) throw new Malformed();
		const marker = b[pos]!;
		pos++;
		if (marker === 0xd9) {
			if (scans === 0 || width === 0) throw new Malformed();
			w.bytes(0xff, 0xd9);
			break;
		}
		// Standalone markers outside entropy-coded data (RSTn, TEM, a stray SOI) are not valid here.
		if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01 || marker === 0x00)
			throw new Malformed();
		const length = u16be(b, pos);
		if (length < 2 || pos + length > b.length) throw new Malformed();
		const start = pos - 2;
		const payload = pos + 2;
		const end = pos + length;
		pos = end;
		if (marker === 0xe0) {
			if (!wroteHeader && !wroteJfif && end - payload >= 5 && ascii(b, payload, 5) === 'JFIF\0') {
				writeJfif(w, b, payload, end);
				wroteJfif = true;
			}
			continue;
		}
		if (marker === 0xe1) {
			if (!wroteHeader) orientation ??= exifOrientationAt(b, payload, end);
			continue;
		}
		if (marker === 0xe2) {
			// ICC_PROFILE segments only (MPF, FlashPix … are dropped); positions only, bounded: a list past
			// MAX_ICC_SEGMENTS is dropped by validIcc.
			const isIcc = end - payload >= 12 && ascii(b, payload, 12) === ICC_SIGNATURE;
			if (isIcc && !wroteHeader && icc.length <= MAX_ICC_SEGMENTS) icc.push({ start, end });
			continue;
		}
		if (isSof(marker)) {
			if (width !== 0 || end - payload < 5) throw new Malformed();
			height = u16be(b, payload + 1);
			width = u16be(b, payload + 3);
			checkSize(width, height);
		} else if (!JPEG_KEEP.has(marker)) {
			continue;
		}
		if (marker === 0xda && width === 0) throw new Malformed();
		header();
		w.copy(b, start, end);
		if (marker === 0xda) {
			scans++;
			// Entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart marker.
			let scanEnd = pos;
			while (scanEnd < b.length) {
				if (b[scanEnd] === 0xff && scanEnd + 1 < b.length) {
					const next = b[scanEnd + 1]!;
					if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
				}
				scanEnd++;
			}
			if (scanEnd >= b.length) throw new Malformed();
			w.copy(b, pos, scanEnd);
			pos = scanEnd;
		}
	}
	return { bytes: w.result(), width, height };
}

// ----------------------------------------------------------------------------------------------- PNG

/** The only chunks a PNG keeps: header, palette, transparency, image data, end. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
/**
 * Colour chunks kept when they have their fixed size (sRGB 1, gAMA 4, cHRM 32 bytes): numbers only, no text.
 * iCCP is dropped (its profile name is free text).
 */
const PNG_COLOUR: Readonly<Record<string, number>> = { sRGB: 1, gAMA: 4, cHRM: 32 };

function sanitizePng(b: Uint8Array) {
	const w = new Writer(b.length);
	w.copy(b, 0, 8);
	let pos = 8;
	let width = 0;
	let height = 0;
	let idat = false;
	let chunks = 0;
	for (;;) {
		if (++chunks > MAX_SEGMENTS) throw new Malformed();
		const length = u32be(b, pos);
		const type = ascii(b, pos + 4, 4);
		const end = pos + 12 + length;
		if (length > 0x7fffffff || end > b.length || !/^[A-Za-z]{4}$/.test(type)) throw new Malformed();
		if (chunks === 1) {
			if (type !== 'IHDR' || length !== 13) throw new Malformed();
			width = u32be(b, pos + 8);
			height = u32be(b, pos + 12);
			checkSize(width, height);
		} else if (type === 'IHDR') {
			throw new Malformed();
		}
		if (type === 'IDAT') idat = true;
		if (PNG_KEEP.has(type) || (Object.hasOwn(PNG_COLOUR, type) && PNG_COLOUR[type] === length))
			w.copy(b, pos, end);
		pos = end;
		// Whatever follows IEND is cut without being parsed.
		if (type === 'IEND') break;
	}
	if (!idat) throw new Malformed();
	return { bytes: w.result(), width, height };
}

// ---------------------------------------------------------------------------------------------- WebP

/** VP8X flags: animation is refused; EXIF and XMP are cleared (their chunks are dropped); alpha kept; ICC set only when its ICCP chunk is kept. */
const VP8X_ANIMATION = 0x02;
const VP8X_ALPHA = 0x10;
const VP8X_ICC = 0x20;
/** Most chunks a WebP may have; a still image has at most VP8X, ICCP, ALPH, the bitstream, EXIF, XMP. */
const MAX_WEBP_CHUNKS = 64;

/** The bitstream's frame size of a VP8 or VP8L chunk at `data`. */
function bitstreamSize(b: Uint8Array, type: string, data: number, size: number) {
	if (type === 'VP8 ') {
		if (size < 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a)
			throw new Malformed();
		return { width: u16le(b, data + 6) & 0x3fff, height: u16le(b, data + 8) & 0x3fff };
	}
	if (size < 5 || b[data] !== 0x2f) throw new Malformed();
	const bits = u32le(b, data + 1);
	return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/**
 * A still WebP by allow-list: VP8X (alpha flag kept, ICC flag only with its profile), ICCP up to ICC_MAX_BYTES,
 * ALPH, one VP8 or VP8L bitstream. EXIF, XMP and unknown chunks are dropped; animation (flag, ANIM, ANMF) is
 * refused; a VP8X canvas that differs from the bitstream size is refused. Bytes after the RIFF end are cut.
 */
function sanitizeWebp(b: Uint8Array) {
	const riffEnd = 8 + u32le(b, 4);
	if (riffEnd > b.length || riffEnd < 20) throw new Malformed();
	const w = new Writer(b.length + 2);
	w.copy(b, 0, 12); // RIFF size patched at the end
	let pos = 12;
	let canvas: { width: number; height: number } | null = null;
	let frame: { width: number; height: number } | null = null;
	let alpha = false;
	let chunks = 0;
	/** Output offset of the VP8X flags byte, to set the ICC flag once a profile is kept. */
	let flagsAt = -1;
	let profile = false;
	while (pos < riffEnd) {
		if (++chunks > MAX_WEBP_CHUNKS) throw new Malformed();
		const type = ascii(b, pos, 4);
		const size = u32le(b, pos + 4);
		const data = pos + 8;
		const end = data + size + (size % 2);
		if (data + size > riffEnd || !/^[\x20-\x7e]{4}$/.test(type)) throw new Malformed();
		if (type === 'ANIM' || type === 'ANMF') throw new Malformed();
		if (type === 'VP8X') {
			// Exactly 10 bytes (red team N3): nothing may ride along after the flags and canvas size.
			if (chunks !== 1 || size !== 10) throw new Malformed();
			if (b[data]! & VP8X_ANIMATION) throw new Malformed();
			canvas = { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 };
			checkSize(canvas.width, canvas.height);
			w.copy(b, pos, data);
			flagsAt = w.at;
			w.bytes(b[data]! & VP8X_ALPHA);
			w.copy(b, data + 1, data + size);
			if (size % 2) w.bytes(0);
		} else if (type === 'ICCP') {
			// Only right after VP8X (before any image data), once, and bounded.
			const ok = size <= ICC_MAX_BYTES && iccHeaderOk(b, data, size);
			if (canvas && !profile && !alpha && !frame && ok) {
				profile = true;
				w.out[flagsAt] = w.out[flagsAt]! | VP8X_ICC;
				w.copy(b, pos, Math.min(end, riffEnd));
				if (size % 2 && end > riffEnd) w.bytes(0);
			}
		} else if (type === 'ALPH') {
			if (alpha || frame || !canvas) throw new Malformed();
			alpha = true;
			w.copy(b, pos, Math.min(end, riffEnd));
			if (size % 2 && end > riffEnd) w.bytes(0);
		} else if (type === 'VP8 ' || type === 'VP8L') {
			if (frame) throw new Malformed();
			frame = bitstreamSize(b, type, data, size);
			checkSize(frame.width, frame.height);
			w.copy(b, pos, Math.min(end, riffEnd));
			if (size % 2 && end > riffEnd) w.bytes(0);
		}
		pos = end;
	}
	if (!frame) throw new Malformed();
	if (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))
		throw new Malformed();
	const out = w.result();
	const riff = out.length - 8;
	out[4] = riff & 0xff;
	out[5] = (riff >> 8) & 0xff;
	out[6] = (riff >> 16) & 0xff;
	out[7] = (riff >>> 24) & 0xff;
	return { bytes: out, width: frame.width, height: frame.height };
}

/**
 * An uploaded photo, checked and cleaned for storage without decoding it (no image library in the Worker):
 * the type is sniffed from the magic bytes (JPEG, PNG or WebP; SVG, GIF, HEIC, PDF and anything else are
 * refused), and the container is rebuilt by allow-list in one pass into one preallocated buffer, keeping only
 * what is needed to show the pixels (see each sanitiser). Work is bounded: at most MAX_SEGMENTS markers or
 * chunks, every frame header checked against PHOTO_MAX_SIDE / PHOTO_MAX_PIXELS as it is read.
 */
export function sanitizeImage(bytes: Uint8Array): SanitizedImage | ImageRefusal {
	const type = sniffImageType(bytes);
	if (!type) return { ok: false, reason: 'type' };
	try {
		const result =
			type === 'image/jpeg'
				? sanitizeJpeg(bytes)
				: type === 'image/png'
					? sanitizePng(bytes)
					: sanitizeWebp(bytes);
		return { ok: true, type, ...result };
	} catch (e) {
		if (e instanceof TooLarge) return { ok: false, reason: 'dimensions' };
		if (e instanceof Malformed || e instanceof RangeError)
			return { ok: false, reason: 'malformed' };
		throw e;
	}
}
