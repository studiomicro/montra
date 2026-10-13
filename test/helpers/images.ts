import { deflateSync } from 'node:zlib';

/** Hand-built image containers for the photo tests (FN-27): structure only, with planted metadata. */
export const bytes = (...parts: (number[] | string | Uint8Array)[]) =>
	Uint8Array.from(
		parts.flatMap((p) =>
			typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : Array.from(p)
		)
	);
export const has = (haystack: Uint8Array, needle: string) =>
	Buffer.from(haystack).includes(Buffer.from(needle, 'latin1'));

export const seg = (marker: number, payload: number[] | Uint8Array) => {
	const length = payload.length + 2;
	return bytes([0xff, marker, length >> 8, length & 0xff], Array.from(payload));
};

/** A big-endian EXIF APP1 payload with Orientation and a GPS IFD pointer plus a GPS latitude. */
export function exifPayload(orientation: number) {
	// TIFF: header (8) + IFD0 at 8: 2 entries (Orientation, GPS IFD pointer) + next 0 → GPS IFD at 8+2+24+4=38
	const ifd0 = [
		...[0, 2],
		...[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0],
		...[0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 38],
		...[0, 0, 0, 0]
	];
	const gps = [...[0, 1], ...[0, 1, 0, 2, 0, 0, 0, 2, 0x53, 0, 0, 0], ...[0, 0, 0, 0]];
	return bytes('Exif\0\0', [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8], ifd0, gps, 'GPSLAT-6.2088,106.8456');
}

export function jpeg(
	opts: { orientation?: number; width?: number; height?: number; trailer?: string } = {}
) {
	const w = opts.width ?? 16;
	const h = opts.height ?? 8;
	return bytes(
		[0xff, 0xd8],
		seg(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0])),
		seg(0xe1, exifPayload(opts.orientation ?? 6)),
		seg(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Jakarta</x:xmpmeta>')),
		seg(0xed, bytes('Photoshop 3.0\0IPTC-city')),
		seg(0xfe, bytes('<script>alert(1)</script>')),
		seg(0xdb, new Uint8Array(65)),
		seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]),
		seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
		[0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56],
		[0xff, 0xd9],
		opts.trailer ?? ''
	);
}

export function pngChunk(type: string, data: Uint8Array | number[]) {
	const d = Uint8Array.from(data);
	const len = d.length;
	return bytes(
		[len >>> 24, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff],
		type,
		d,
		[0, 0, 0, 0]
	);
}
export function png(opts: { width?: number; height?: number; trailer?: string } = {}) {
	const w = opts.width ?? 2;
	const h = opts.height ?? 2;
	const be32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
	return bytes(
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		pngChunk('IHDR', [...be32(w), ...be32(h), 8, 2, 0, 0, 0]),
		pngChunk('tEXt', bytes('Comment\0GPS -6.2,106.8')),
		pngChunk('eXIf', bytes('MM\0*GPSDATA')),
		pngChunk('IDAT', deflateSync(Buffer.alloc(h * (1 + 3 * Math.min(w, 4))))),
		pngChunk('IEND', []),
		opts.trailer ?? ''
	);
}

export const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
export function webpChunk(type: string, data: Uint8Array | number[]) {
	const d = Uint8Array.from(data);
	return bytes(type, le32(d.length), d, d.length % 2 ? [0] : []);
}
export function webp(opts: { trailer?: string } = {}) {
	// VP8X: flags EXIF|XMP set, canvas 3×5 (stored as size − 1)
	const vp8x = [0x08 | 0x04, 0, 0, 0, 2, 0, 0, 4, 0, 0];
	const vp8l = [0x2f, ...le32(2 | (4 << 14)), 0, 0, 0];
	const body = bytes(
		'WEBP',
		webpChunk('VP8X', vp8x),
		webpChunk('VP8L', vp8l),
		webpChunk('EXIF', bytes('MM\0*GPS-6.2')),
		webpChunk('XMP ', bytes('<x:xmpmeta>Jakarta</x:xmpmeta>'))
	);
	return bytes('RIFF', le32(body.length), body, opts.trailer ?? '');
}

/**
 * A structurally valid ICC profile: a 128-byte header whose size field (bytes 0–3) is the whole length and
 * with `acsp` at offset 36, followed by `texts` (stand-ins for the tag data).
 */
export function iccProfile(...texts: string[]): Uint8Array {
	const tail = bytes(...texts);
	const out = new Uint8Array(128 + tail.length);
	const n = out.length;
	out.set([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff], 0);
	out.set([0x61, 0x63, 0x73, 0x70], 36);
	out.set(tail, 128);
	return out;
}
