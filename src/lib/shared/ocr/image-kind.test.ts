import { describe, expect, it } from 'vitest';
import { bytes, jpeg, png, webp, webpChunk, le32, seg } from '../../../../test/helpers/images';
import {
	checkOcrBatch,
	checkOcrFile,
	declaredSize,
	HEIC_MAX_META_BYTES,
	heicMetaBox,
	OCR_MAX_FILE_BYTES,
	readingSize,
	sniffOcrFile
} from './image-kind';

const be32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const heic = bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0], 'mif1heic');

describe('sniffOcrFile', () => {
	it('decides by magic bytes only', () => {
		expect(sniffOcrFile(png())).toBe('png');
		expect(sniffOcrFile(jpeg())).toBe('jpeg');
		expect(sniffOcrFile(webp())).toBe('webp');
		expect(sniffOcrFile(heic)).toBe('heic');
		expect(sniffOcrFile(bytes('%PDF-1.7\n'))).toBe('pdf');
		expect(sniffOcrFile(bytes('GIF89a'))).toBe('unknown');
		expect(sniffOcrFile(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe('unknown');
	});
});

describe('declared size (read before any decode)', () => {
	it('reads PNG IHDR, JPEG SOF and WebP VP8X/VP8L/VP8 headers', () => {
		expect(declaredSize(png({ width: 1080, height: 2400 }), 'png')).toEqual({
			width: 1080,
			height: 2400
		});
		expect(declaredSize(jpeg({ width: 4000, height: 3000 }), 'jpeg')).toEqual({
			width: 4000,
			height: 3000
		});
		expect(declaredSize(webp(), 'webp')).toEqual({ width: 3, height: 5 });
		const vp8l = bytes(
			'RIFF',
			le32(14),
			'WEBP',
			webpChunk('VP8L', [0x2f, ...le32(99 | (199 << 14)), 0])
		);
		expect(declaredSize(vp8l, 'webp')).toEqual({ width: 100, height: 200 });
		const vp8 = bytes(
			'RIFF',
			le32(20),
			'WEBP',
			webpChunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 1, 32, 2])
		);
		expect(declaredSize(vp8, 'webp')).toEqual({ width: 320, height: 544 });
	});

	it('refuses a lying huge header before decode, and an unreadable one', () => {
		expect(checkOcrFile(png({ width: 9000, height: 8000 }), 1000)).toEqual({
			refusal: 'too_many_pixels'
		});
		expect(checkOcrFile(jpeg({ width: 65535, height: 65535 }), 1000)).toEqual({
			refusal: 'too_many_pixels'
		});
		const huge = bytes(
			'RIFF',
			le32(18),
			'WEBP',
			webpChunk('VP8X', [0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
		);
		expect(checkOcrFile(huge, 1000)).toEqual({ refusal: 'too_many_pixels' });
		// 65 MP declared (just over the 64 MP cap); 8000 × 8000 = 64 MP passes.
		expect(checkOcrFile(png({ width: 8125, height: 8000 }), 1000)).toEqual({
			refusal: 'too_many_pixels'
		});
		expect(checkOcrFile(jpeg({ width: 8000, height: 8000 }), 1000)).toMatchObject({
			kind: 'jpeg',
			size: { width: 8000, height: 8000 }
		});
		expect(checkOcrFile(bytes([0xff, 0xd8, 0xff], seg(0xdb, [1, 2])), 10)).toEqual({
			refusal: 'malformed'
		});
		expect(checkOcrFile(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 8)).toEqual({
			refusal: 'malformed'
		});
	});

	it('refuses a file over 15 MB and an unknown kind', () => {
		expect(checkOcrFile(png(), OCR_MAX_FILE_BYTES + 1)).toEqual({ refusal: 'too_large' });
		expect(checkOcrFile(bytes('GIF89a'), 6)).toEqual({ refusal: 'unsupported' });
	});

	it('refuses a PNG or WebP that would decode too large, but not a JPEG of that size (red team L3)', () => {
		// 24 MP passes; 24.01 MP does not. The JPEG is cut down while it decodes.
		expect(checkOcrFile(png({ width: 4800, height: 5000 }), 1000)).toMatchObject({ kind: 'png' });
		expect(checkOcrFile(png({ width: 4900, height: 4900 }), 1000)).toEqual({
			refusal: 'too_big_to_decode'
		});
		const big = bytes(
			'RIFF',
			le32(18),
			'WEBP',
			webpChunk('VP8X', [0, 0, 0, 0, 0x87, 0x13, 0, 0x87, 0x13, 0])
		);
		expect(checkOcrFile(big, 1000)).toEqual({ refusal: 'too_big_to_decode' });
		expect(checkOcrFile(jpeg({ width: 6000, height: 8000 }), 1000)).toMatchObject({ kind: 'jpeg' });
	});

	const ispe = (w: number, h: number) =>
		bytes([0, 0, 0, 20], 'ispe', [0, 0, 0, 0], be32(w), be32(h));
	const box = (type: string, ...parts: (number[] | string | Uint8Array)[]) => {
		const body = bytes(...parts);
		return bytes(be32(8 + body.length), type, body);
	};
	/** Walks the file's boxes like the picker does, then checks it from its 512 KB head. */
	const checkHeic = async (file: Uint8Array) => {
		const meta = await heicMetaBox(async (start, end) => file.slice(start, end), file.length);
		return checkOcrFile(file.subarray(0, 512 * 1024), file.length, meta);
	};

	it('reads a HEIC header size before decoding and refuses a missing, huge or oversized one (red team L3)', async () => {
		const heicOf = (...boxes: Uint8Array[]) => bytes(heic, box('meta', ...boxes), box('mdat', 'x'));
		// A phone photo (12 MP) with a thumbnail passes; the size stays with the browser (rotation).
		expect(await checkHeic(heicOf(ispe(320, 240), ispe(4032, 3024)))).toEqual({
			kind: 'heic',
			size: null
		});
		expect(await checkHeic(heicOf(ispe(8000, 6000)))).toEqual({ refusal: 'too_big_to_decode' });
		expect(await checkHeic(heicOf(ispe(20000, 20000)))).toEqual({ refusal: 'too_many_pixels' });
		// No readable size box: refused rather than decoded blind.
		expect(await checkHeic(heic)).toEqual({ refusal: 'malformed' });
		expect(await checkHeic(heicOf(bytes([0, 0, 0, 12], 'ispe', [0, 0, 0, 0])))).toEqual({
			refusal: 'malformed'
		});
		expect(checkOcrFile(heicOf(ispe(320, 240)), 5000)).toEqual({ refusal: 'malformed' });
	});

	it('red team L5: only the top-level meta box is read, wherever it is; a decoy elsewhere is ignored', async () => {
		const bigMdat = box('mdat', new Uint8Array(600 * 1024));
		// A decoy small ispe in the head (in a free box), the real huge one in a meta box after a large mdat.
		const decoy = bytes(heic, box('free', ispe(320, 240)), bigMdat, box('meta', ispe(8000, 6000)));
		expect(await checkHeic(decoy)).toEqual({ refusal: 'too_big_to_decode' });
		// An honest photo whose meta box comes after a large mdat is read, not refused as damaged.
		const late = bytes(heic, bigMdat, box('meta', ispe(4032, 3024)));
		expect(await checkHeic(late)).toEqual({ kind: 'heic', size: null });
		// A 64-bit box size is followed too.
		const large = bytes(
			heic,
			be32(1),
			'mdat',
			be32(0),
			be32(16 + 8),
			'abcdefgh',
			box('meta', ispe(4032, 3024))
		);
		expect(await checkHeic(large)).toEqual({ kind: 'heic', size: null });
		// Boxes that do not fit the file, or a meta box past its cap, give no size: malformed.
		expect(await checkHeic(bytes(heic, be32(9999), 'mdat'))).toEqual({ refusal: 'malformed' });
		expect(
			await checkHeic(bytes(heic, box('meta', new Uint8Array(HEIC_MAX_META_BYTES), ispe(1, 1))))
		).toEqual({ refusal: 'malformed' });
	});
});

describe('batch and page limits', () => {
	it('takes up to 5 images, or one PDF alone', () => {
		expect(checkOcrBatch(['png', 'png', 'jpeg', 'webp', 'png'])).toBeNull();
		expect(checkOcrBatch(['png', 'png', 'jpeg', 'webp', 'png', 'png'])).toBe('too_many');
		expect(checkOcrBatch(['pdf'])).toBeNull();
		expect(checkOcrBatch(['pdf', 'png'])).toBe('too_many');
	});

	it('scales a page down to 3000 px and 6 MP, never up', () => {
		expect(readingSize(1080, 2400)).toMatchObject({ width: 1080, height: 2400, scale: 1 });
		const photo = readingSize(8000, 6000);
		expect(Math.max(photo.width, photo.height)).toBeLessThanOrEqual(3000);
		expect(photo.width * photo.height).toBeLessThanOrEqual(6_000_000);
		const tall = readingSize(1000, 9000);
		expect(tall.height).toBeLessThanOrEqual(3000);
	});
});
