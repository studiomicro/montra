import { describe, expect, it } from 'vitest';
import {
	bytes,
	has,
	jpeg,
	le32,
	png,
	iccProfile,
	pngChunk,
	seg,
	webp,
	webpChunk
} from '../../../../test/helpers/images';
import { PHOTO_MAX_SIDE, sanitizeImage, sniffImageType } from './image';

describe('sniffImageType', () => {
	it('names JPEG, PNG and WebP from their magic bytes', () => {
		expect(sniffImageType(jpeg())).toBe('image/jpeg');
		expect(sniffImageType(png())).toBe('image/png');
		expect(sniffImageType(webp())).toBe('image/webp');
	});

	it('refuses SVG, HTML, GIF, HEIC, PDF and empty input whatever they are called', () => {
		for (const text of [
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			'<?xml version="1.0"?><svg/>',
			'<!doctype html><script>alert(1)</script>',
			'GIF89a\x01\x00\x01\x00',
			'\0\0\0\x18ftypheic\0\0\0\0mif1heic',
			'%PDF-1.7',
			''
		])
			expect(sniffImageType(bytes(text))).toBeNull();
	});
});

describe('sanitizeImage: JPEG', () => {
	it('drops EXIF GPS, XMP, IPTC and comments, keeps the orientation only, cuts trailing bytes', () => {
		const result = sanitizeImage(jpeg({ orientation: 6, trailer: 'PK\x03\x04<html>' }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result).toMatchObject({ type: 'image/jpeg', width: 16, height: 8 });
		const out = result.bytes;
		for (const leaked of ['GPSLAT', '106.8456', 'xmpmeta', 'IPTC', '<script>', 'PK', '<html>'])
			expect(has(out, leaked), leaked).toBe(false);
		// The GPS IFD pointer tag (0x8825) is gone; a new minimal Exif keeps Orientation 6.
		expect(Buffer.from(out).includes(Buffer.from([0x88, 0x25]))).toBe(false);
		expect(has(out, 'Exif\0\0')).toBe(true);
		expect(Buffer.from(out).includes(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6]))).toBe(true);
		expect(Array.from(out.subarray(0, 4))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
		expect(Array.from(out.subarray(-2))).toEqual([0xff, 0xd9]);
		// Scan data with stuffed bytes and restart markers is copied unchanged.
		expect(Buffer.from(out).includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]))).toBe(
			true
		);
	});

	it('sanitising twice gives the same bytes (idempotent)', () => {
		const once = sanitizeImage(jpeg());
		if (!once.ok) throw new Error('expected ok');
		const twice = sanitizeImage(once.bytes);
		expect(twice.ok && Buffer.from(twice.bytes).equals(Buffer.from(once.bytes))).toBe(true);
	});

	it('refuses a JPEG header with no frame, no scan, a bad length or no end', () => {
		expect(sanitizeImage(bytes([0xff, 0xd8, 0xff, 0xd9]))).toEqual({
			ok: false,
			reason: 'malformed'
		});
		expect(sanitizeImage(bytes([0xff, 0xd8, 0xff, 0xe0, 0x40, 0]))).toEqual({
			ok: false,
			reason: 'malformed'
		});
		const cut = jpeg();
		expect(sanitizeImage(cut.subarray(0, cut.length - 2))).toEqual({
			ok: false,
			reason: 'malformed'
		});
		// A polyglot that is JPEG only by its first three bytes.
		expect(sanitizeImage(bytes([0xff, 0xd8, 0xff], '<html><script>alert(1)</script>'))).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});

	it('refuses a frame past the side or pixel cap', () => {
		expect(sanitizeImage(jpeg({ width: PHOTO_MAX_SIDE + 1, height: 10 }))).toEqual({
			ok: false,
			reason: 'dimensions'
		});
		expect(sanitizeImage(jpeg({ width: 9000, height: 9000 }))).toEqual({
			ok: false,
			reason: 'dimensions'
		});
		expect(sanitizeImage(jpeg({ width: 8064, height: 6048 })).ok).toBe(true);
	});
});

describe('sanitizeImage: PNG', () => {
	it('keeps image chunks, drops text and eXIf chunks and trailing bytes', () => {
		const result = sanitizeImage(png({ trailer: '<html>' }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result).toMatchObject({ type: 'image/png', width: 2, height: 2 });
		for (const leaked of ['tEXt', 'GPS', 'eXIf', '<html>'])
			expect(has(result.bytes, leaked), leaked).toBe(false);
		expect(
			has(result.bytes, 'IHDR') && has(result.bytes, 'IDAT') && has(result.bytes, 'IEND')
		).toBe(true);
	});

	it('refuses a PNG without IHDR first, without IDAT, cut short, or too large', () => {
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		expect(sanitizeImage(bytes(sig, pngChunk('IEND', [])))).toEqual({
			ok: false,
			reason: 'malformed'
		});
		const noData = bytes(
			sig,
			pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
			pngChunk('IEND', [])
		);
		expect(sanitizeImage(noData)).toEqual({ ok: false, reason: 'malformed' });
		const whole = png();
		expect(sanitizeImage(whole.subarray(0, whole.length - 6)).ok).toBe(false);
		expect(sanitizeImage(png({ width: 20_000, height: 1 }))).toEqual({
			ok: false,
			reason: 'dimensions'
		});
	});
});

describe('sanitizeImage: WebP', () => {
	it('drops EXIF and XMP chunks, clears their VP8X flags and fixes the RIFF size', () => {
		const result = sanitizeImage(webp({ trailer: '<html>' }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result).toMatchObject({ type: 'image/webp', width: 3, height: 5 });
		const out = result.bytes;
		for (const leaked of ['EXIF', 'XMP ', 'GPS', 'Jakarta', '<html>'])
			expect(has(out, leaked), leaked).toBe(false);
		expect(out[20]! & 0x0c).toBe(0);
		const riff = out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
		expect(riff).toBe(out.length - 8);
	});

	it('refuses a RIFF size beyond the file and a WebP with no image chunk', () => {
		const w = webp();
		expect(sanitizeImage(w.subarray(0, w.length - 4))).toEqual({ ok: false, reason: 'malformed' });
		const empty = bytes('RIFF', le32(4 + 18), 'WEBP', webpChunk('XMP ', bytes('0123456789')));
		expect(sanitizeImage(empty)).toEqual({ ok: false, reason: 'malformed' });
	});
});

// ---- cycle 2: red team FN-27 M1 / L1 / L2 ----

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const sof = (w: number, h: number) =>
	seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
const sos = () => seg(0xda, [1, 1, 0, 0, 0x3f, 0]);
const dqt = () => seg(0xdb, new Uint8Array(65));

/** Size of `n` repetitions of `unit`, filled into one buffer (the 8 MiB flood files of the red-team probe). */
function flood(head: Uint8Array, unit: number[], count: number, tail: Uint8Array) {
	const out = new Uint8Array(head.length + unit.length * count + tail.length);
	out.set(head);
	for (let i = 0; i < count; i++) out.set(unit, head.length + i * unit.length);
	out.set(tail, head.length + unit.length * count);
	return out;
}

/** Runs `fn` and returns its result with the heap growth in MB (no GC in between: garbage counts too). */
function measured<T>(fn: () => T) {
	const before = process.memoryUsage().heapUsed;
	const started = performance.now();
	const result = fn();
	return {
		result,
		heapMb: (process.memoryUsage().heapUsed - before) / 1024 / 1024,
		ms: performance.now() - started
	};
}

describe('M1: segment floods are refused with bounded memory and time', () => {
	const MiB8 = 8 * 1024 * 1024 - 64;
	it.each([
		[
			'JPEG: SOI + SOF 1x1 + 4M FF D0 + SOS + EOI (the red-team repro)',
			() => flood(bytes(SOI, sof(1, 1)), [0xff, 0xd0], (MiB8 - 40) / 2, bytes(sos(), [0], EOI))
		],
		[
			'JPEG: 2M empty APP0 segments',
			() =>
				flood(bytes(SOI), [0xff, 0xe0, 0, 2], (MiB8 - 40) / 4, bytes(sof(1, 1), sos(), [0], EOI))
		],
		[
			'JPEG: 2M empty DRI-sized kept segments',
			() =>
				flood(bytes(SOI, sof(1, 1)), [0xff, 0xdd, 0, 2], (MiB8 - 40) / 4, bytes(sos(), [0], EOI))
		],
		[
			'PNG: 700k empty gAMA chunks',
			() =>
				flood(
					bytes(
						[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
						pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
					),
					[0, 0, 0, 0, 0x67, 0x41, 0x4d, 0x41, 0, 0, 0, 0],
					Math.floor((MiB8 - 100) / 12),
					bytes(pngChunk('IDAT', [0]), pngChunk('IEND', []))
				)
		],
		[
			'WebP: 1M empty ALPH chunks',
			() => {
				const count = Math.floor((MiB8 - 100) / 8);
				const body = flood(
					bytes('WEBP'),
					[0x41, 0x4c, 0x50, 0x48, 0, 0, 0, 0],
					count,
					bytes(webpChunk('VP8L', [0x2f, 0, 0, 0, 0, 0]))
				);
				return bytes('RIFF', le32(body.length), body);
			}
		]
	])('%s', (_label, make) => {
		const input = make();
		expect(input.length).toBeGreaterThan(7 * 1024 * 1024);
		const run = measured(() => sanitizeImage(input));
		expect(run.result).toEqual({ ok: false, reason: 'malformed' });
		// Well under the 128 MB isolate: the output buffer is at most one input size.
		expect(run.heapMb).toBeLessThan(24);
		expect(run.ms).toBeLessThan(1000);
	});

	it('a legitimate 8 MiB JPEG (one large scan) sanitises within input + output memory', () => {
		const input = flood(
			bytes(SOI, dqt(), sof(4000, 3000), sos()),
			[0x12, 0x34, 0xff, 0x00],
			2_000_000,
			bytes(EOI)
		);
		const run = measured(() => sanitizeImage(input));
		expect(run.result.ok).toBe(true);
		expect(run.heapMb).toBeLessThan(24);
	});

	it('refuses RSTn and TEM outside a scan', () => {
		for (const stray of [
			[0xff, 0xd0],
			[0xff, 0x01]
		])
			expect(sanitizeImage(bytes(SOI, sof(1, 1), stray, sos(), [0], EOI))).toEqual({
				ok: false,
				reason: 'malformed'
			});
	});
});

describe('R15: data after the image end is cut, never refused and never parsed', () => {
	it('an Ultra HDR / motion-photo JPEG (a second JPEG and an MP4 after EOI) is kept up to EOI', () => {
		const gainMap = bytes(
			SOI,
			seg(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0hdrgm')),
			sof(1, 1),
			sos(),
			[0],
			EOI
		);
		const mp4 = bytes([0, 0, 0, 0x18], 'ftypmp42', new Uint8Array(3 * 1024 * 1024));
		const primary = bytes(SOI, dqt(), sof(4, 3), sos(), [0x11, 0x22], EOI);
		const result = sanitizeImage(bytes(primary, gainMap, mp4));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Buffer.from(result.bytes).equals(Buffer.from(primary))).toBe(true);
		expect(Array.from(result.bytes.subarray(-2))).toEqual(EOI);
		expect(has(result.bytes, 'ftyp')).toBe(false);
		expect(has(result.bytes, 'hdrgm')).toBe(false);
	});

	it('PNG and WebP: bytes after IEND / the RIFF end are cut', () => {
		const p = sanitizeImage(png({ trailer: 'x'.repeat(100_000) }));
		expect(p.ok && has(p.bytes, 'xxxx')).toBe(false);
		expect(p.ok && Buffer.from(p.bytes.subarray(-8, -4)).toString('latin1')).toBe('IEND');
		const w = sanitizeImage(webp({ trailer: 'x'.repeat(100_000) }));
		expect(w.ok && has(w.bytes, 'xxxx')).toBe(false);
	});
});

describe('L1: one frame, dimensions checked on every frame header', () => {
	it('refuses a JPEG with a second SOF (65000×65000 then 1×1)', () => {
		const huge = bytes(
			SOI,
			seg(0xc0, [8, 0xfd, 0xe8, 0xfd, 0xe8, 1, 1, 0x11, 0]),
			sos(),
			[0],
			sof(1, 1),
			sos(),
			[0],
			EOI
		);
		expect(sanitizeImage(huge).ok).toBe(false);
		expect(sanitizeImage(bytes(SOI, sof(1, 1), sos(), [0], sof(1, 1), sos(), [0], EOI))).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});

	it('refuses a WebP whose VP8X canvas and bitstream sizes disagree', () => {
		const vp8x = [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // canvas 1×1
		const vp8l = [0x2f, ...le32(1999 | (1999 << 14)), 0]; // bitstream 2000×2000
		const body = bytes('WEBP', webpChunk('VP8X', vp8x), webpChunk('VP8L', vp8l));
		expect(sanitizeImage(bytes('RIFF', le32(body.length), body))).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});

	it('refuses an oversized VP8L bitstream without VP8X', () => {
		const vp8l = [0x2f, ...le32(16383 | (16383 << 14)), 0];
		const body = bytes('WEBP', webpChunk('VP8L', vp8l));
		expect(sanitizeImage(bytes('RIFF', le32(body.length), body))).toEqual({
			ok: false,
			reason: 'dimensions'
		});
	});
});

describe('L2: allow-list, nothing else survives', () => {
	it('JPEG keeps only SOI, a thumbnail-free JFIF, the orientation APP1, the ICC profile, DQT, DHT, DRI, SOF, SOS + data, EOI', () => {
		const input = bytes(
			SOI,
			seg(0xe0, bytes('JFXX\0', [0x10], 'THUMBNAIL-UNCROPPED')),
			seg(0xe0, bytes('JFIF\0', [1, 2, 1, 0, 72, 0, 72, 2, 2], 'THUMBPIXELS-UNCROPPED')),
			seg(
				0xe1,
				bytes(
					'Exif\0\0',
					[
						0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0,
						0, 0
					]
				)
			),
			seg(0xe2, bytes('ICC_PROFILE\0', [1, 1], iccProfile('ICCDATA-P3'))),
			seg(0xe2, bytes('MPF\0', 'MPF-SECRET')),
			seg(0xf0, bytes('UNKNOWN-F0-SECRET')),
			seg(0xee, bytes('Adobe', 'ADOBE-SECRET')),
			dqt(),
			seg(0xc4, bytes([0], new Uint8Array(16), 'H')),
			seg(0xdd, [0, 4]),
			sof(2, 2),
			sos(),
			[0x55, 0xff, 0xd0, 0x66],
			EOI
		);
		const result = sanitizeImage(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const leaked of ['THUMBNAIL', 'THUMBPIXELS', 'MPF', 'UNKNOWN-F0', 'ADOBE-SECRET', 'JFXX'])
			expect(has(result.bytes, leaked), leaked).toBe(false);
		// Walk the output: only allowed markers, in a valid order.
		const markers: number[] = [];
		const b = result.bytes;
		let pos = 2;
		while (pos < b.length) {
			const m = b[pos + 1]!;
			markers.push(m);
			if (m === 0xd9) break;
			pos += 2 + ((b[pos + 2]! << 8) | b[pos + 3]!);
			if (m === 0xda) pos += 4; // the scan bytes of this fixture
		}
		expect(markers).toEqual([0xe0, 0xe1, 0xe2, 0xdb, 0xc4, 0xdd, 0xc0, 0xda, 0xd9]);
		expect(has(b, 'ICC_PROFILE\0\u0001\u0001')).toBe(true);
		expect(has(b, 'ICCDATA-P3')).toBe(true);
		// The new JFIF keeps the density and has a 0×0 thumbnail; the APP1 holds Orientation 3 only.
		expect(Array.from(b.subarray(2, 20))).toEqual([
			0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 72, 0, 72, 0, 0
		]);
		expect(Array.from(b.subarray(20, 24))).toEqual([0xff, 0xe1, 0, 34]);
		expect(b[20 + 4 + 6 + 8 + 2 + 9]).toBe(3);
	});

	it('JPEG drops an ICC profile that is incomplete, out of order or over 64 KiB', () => {
		const frame = bytes(dqt(), sof(1, 1), sos(), [0], EOI);
		const icc = (seq: number, count: number, data: Uint8Array | string) =>
			seg(0xe2, bytes('ICC_PROFILE\0', [seq, count], data));
		const big = new Uint8Array(40_000).fill(0x41);
		for (const segments of [
			[icc(1, 2, 'ONLY-FIRST')],
			[icc(2, 2, 'B'), icc(1, 2, 'A')],
			[icc(1, 1, 'X'), icc(1, 1, 'Y')],
			[icc(1, 2, big), icc(2, 2, big)],
			[seg(0xe2, bytes('ICC_PROFILX\0', [1, 1], 'NOPE'))]
		]) {
			const result = sanitizeImage(bytes(SOI, ...segments, frame));
			expect(result.ok).toBe(true);
			if (result.ok) expect(has(result.bytes, 'ICC_PROFIL')).toBe(false);
		}
		// A real profile split over two segments: the size field counts the joined length.
		const whole = iccProfile('PART-ONE', 'PART-TWO');
		const two = sanitizeImage(
			bytes(SOI, icc(1, 2, whole.subarray(0, 136)), icc(2, 2, whole.subarray(136)), frame)
		);
		expect(two.ok && has(two.bytes, 'PART-ONE') && has(two.bytes, 'PART-TWO')).toBe(true);
	});

	it('N1: an ICC "profile" without the acsp signature or with a wrong size field is dropped', () => {
		const frame = bytes(dqt(), sof(1, 1), sos(), [0], EOI);
		const icc = (data: Uint8Array) => seg(0xe2, bytes('ICC_PROFILE\0', [1, 1], data));
		const noAcsp = iccProfile('CARRIER-1');
		noAcsp.set([0x78, 0x78, 0x78, 0x78], 36);
		const wrongSize = iccProfile('CARRIER-2');
		wrongSize.set([0, 0, 0, 200], 0);
		const tooShort = bytes('CARRIER-3');
		for (const data of [noAcsp, wrongSize, tooShort]) {
			const result = sanitizeImage(bytes(SOI, icc(data), frame));
			expect(result.ok).toBe(true);
			if (result.ok) expect(has(result.bytes, 'CARRIER')).toBe(false);
		}
		for (const data of [noAcsp, wrongSize, tooShort]) {
			const body = bytes(
				'WEBP',
				webpChunk('VP8X', [0x20, 0, 0, 0, 2, 0, 0, 4, 0, 0]),
				webpChunk('ICCP', data),
				webpChunk('VP8L', [0x2f, ...le32(2 | (4 << 14)), 0])
			);
			const result = sanitizeImage(bytes('RIFF', le32(body.length), body));
			expect(result.ok).toBe(true);
			if (!result.ok) continue;
			expect(has(result.bytes, 'CARRIER')).toBe(false);
			expect(result.bytes[20]).toBe(0);
		}
	});

	it('N2: only the first JFIF segment is written', () => {
		const jfif = seg(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]));
		const result = sanitizeImage(bytes(SOI, jfif, jfif, jfif, dqt(), sof(1, 1), sos(), [0], EOI));
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(Buffer.from(result.bytes).toString('latin1').split('JFIF\0').length - 1).toBe(1);
	});

	it('N3: a VP8X chunk that is not exactly 10 bytes is refused', () => {
		for (const vp8x of [
			[0, 0, 0, 0, 2, 0, 0, 4, 0, 0, 0x41, 0x42],
			[0, 0, 0, 0, 2, 0, 0, 4]
		]) {
			const body = bytes(
				'WEBP',
				webpChunk('VP8X', vp8x),
				webpChunk('VP8L', [0x2f, ...le32(2 | (4 << 14)), 0])
			);
			expect(sanitizeImage(bytes('RIFF', le32(body.length), body))).toEqual({
				ok: false,
				reason: 'malformed'
			});
		}
	});

	it('PNG keeps only IHDR, PLTE, tRNS, IDAT, IEND and the sRGB, gAMA, cHRM colour chunks', () => {
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		const input = bytes(
			sig,
			pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 3, 0, 0, 0]),
			pngChunk('iCCP', bytes('Pixel 8 Pro profile\0\0', [1, 2, 3])),
			pngChunk('gAMA', [0, 0, 0xb1, 0x8f]),
			pngChunk('sRGB', [0]),
			pngChunk('cHRM', new Uint8Array(32)),
			pngChunk('gAMA', bytes('gAMA with text, wrong size')),
			pngChunk('PLTE', [1, 2, 3]),
			pngChunk('tRNS', [0]),
			pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]),
			pngChunk('zTXt', bytes('Author\0\0secret')),
			pngChunk('IDAT', [0]),
			pngChunk('tIME', [7, 0xea, 10, 8, 1, 2, 3]),
			pngChunk('IEND', [])
		);
		const result = sanitizeImage(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const types: string[] = [];
		for (let pos = 8; pos < result.bytes.length;) {
			const len = Buffer.from(result.bytes).readUInt32BE(pos);
			types.push(Buffer.from(result.bytes.subarray(pos + 4, pos + 8)).toString('latin1'));
			pos += 12 + len;
		}
		expect(types).toEqual(['IHDR', 'gAMA', 'sRGB', 'cHRM', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
		expect(has(result.bytes, 'wrong size')).toBe(false);
		expect(has(result.bytes, 'Pixel 8')).toBe(false);
	});

	it('WebP keeps only VP8X (alpha + ICC flags), ICCP, ALPH and the bitstream', () => {
		const vp8x = [0x20 | 0x10 | 0x08 | 0x04, 0, 0, 0, 2, 0, 0, 4, 0, 0];
		const body = bytes(
			'WEBP',
			webpChunk('VP8X', vp8x),
			webpChunk('ICCP', iccProfile('Galaxy profile')),
			webpChunk('ALPH', [0, 1, 2]),
			webpChunk('VP8L', [0x2f, ...le32(2 | (4 << 14)), 0]),
			webpChunk('EXIF', bytes('MM\0*GPS')),
			webpChunk('XMP ', bytes('<x:xmpmeta/>')),
			webpChunk('ZZZZ', bytes('unknown'))
		);
		const result = sanitizeImage(bytes('RIFF', le32(body.length), body));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const out = result.bytes;
		const types: string[] = [];
		for (let pos = 12; pos < out.length;) {
			const size = Buffer.from(out).readUInt32LE(pos + 4);
			types.push(Buffer.from(out.subarray(pos, pos + 4)).toString('latin1'));
			pos += 8 + size + (size % 2);
		}
		expect(types).toEqual(['VP8X', 'ICCP', 'ALPH', 'VP8L']);
		expect(out[20]).toBe(0x30);
		expect(has(out, 'Galaxy profile')).toBe(true);
		expect(Buffer.from(out).readUInt32LE(4)).toBe(out.length - 8);
	});

	it('WebP drops an ICCP over 64 KiB and clears the ICC flag', () => {
		const body = bytes(
			'WEBP',
			webpChunk('VP8X', [0x20, 0, 0, 0, 2, 0, 0, 4, 0, 0]),
			webpChunk('ICCP', new Uint8Array(64 * 1024 + 2)),
			webpChunk('VP8L', [0x2f, ...le32(2 | (4 << 14)), 0])
		);
		const result = sanitizeImage(bytes('RIFF', le32(body.length), body));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(has(result.bytes, 'ICCP')).toBe(false);
		expect(result.bytes[20]).toBe(0);
	});

	it('refuses animated WebP (flag, ANIM or ANMF)', () => {
		const animFlag = bytes(
			'WEBP',
			webpChunk('VP8X', [0x02, 0, 0, 0, 2, 0, 0, 4, 0, 0]),
			webpChunk('VP8L', [0x2f, ...le32(2 | (4 << 14)), 0])
		);
		const anmf = bytes(
			'WEBP',
			webpChunk('VP8X', [0, 0, 0, 0, 2, 0, 0, 4, 0, 0]),
			webpChunk('ANMF', new Uint8Array(30))
		);
		for (const body of [animFlag, anmf])
			expect(sanitizeImage(bytes('RIFF', le32(body.length), body))).toEqual({
				ok: false,
				reason: 'malformed'
			});
	});
});
