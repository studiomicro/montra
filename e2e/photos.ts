import { crc32, deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { exifPayload } from '../test/helpers/images';

/** Photo files for the FN-27 / FN-28 journeys, made in the test (no fixture files). */

/** The GPS text the test images carry; it must never come back from our photo routes. */
export const GPS_MARK = 'GPSLAT-6.2088,106.8456';

/** A real 24×16 RGB PNG (valid CRCs, so the browser decodes it). */
export function realPng(): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
		return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(24, 0);
	ihdr.writeUInt32BE(16, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const raw = Buffer.alloc(16 * (1 + 24 * 3), 0x60);
	for (let y = 0; y < 16; y++) raw[y * (1 + 24 * 3)] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('tEXt', Buffer.from(`Comment\0${GPS_MARK}`, 'latin1')),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** A real JPEG drawn by the browser, with an EXIF APP1 (orientation + GPS) spliced in after SOI. */
export async function realJpegWithGps(page: Page): Promise<Buffer> {
	const base64 = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 32;
		canvas.height = 24;
		const ctx = canvas.getContext('2d')!;
		ctx.fillStyle = '#2a6';
		ctx.fillRect(0, 0, 32, 24);
		return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
	});
	return withExif(Buffer.from(base64, 'base64'), 1);
}

/** An image drawn by the browser's canvas (FN-45): a gradient so a re-encode has something to keep. */
export async function canvasImage(
	page: Page,
	opts: { width: number; height: number; type: 'image/jpeg' | 'image/png' }
): Promise<Buffer> {
	const base64 = await page.evaluate(({ width, height, type }) => {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d')!;
		const gradient = ctx.createLinearGradient(0, 0, width, height);
		gradient.addColorStop(0, '#2a6');
		gradient.addColorStop(1, '#36c');
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, width, height);
		return canvas.toDataURL(type, 0.9).split(',')[1]!;
	}, opts);
	return Buffer.from(base64, 'base64');
}

/** `jpeg` with an EXIF APP1 (this orientation, plus GPS) spliced in after SOI. */
export function withExif(jpeg: Buffer, orientation: number): Buffer {
	const payload = Buffer.from(exifPayload(orientation));
	const app1 = Buffer.alloc(4);
	app1.set([0xff, 0xe1]);
	app1.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

/** `jpeg` grown past `size` bytes with comment segments: still a valid JPEG the browser decodes. */
export function paddedJpeg(jpeg: Buffer, size: number): Buffer {
	const segments: Buffer[] = [];
	let total = jpeg.length;
	while (total <= size) {
		const segment = Buffer.alloc(4 + 65_000, 0x20);
		segment.set([0xff, 0xfe]);
		segment.writeUInt16BE(65_002, 2);
		segments.push(segment);
		total += segment.length;
	}
	return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

/** The first bytes of an HEIC file (an ISO-BMFF `ftyp` box with brand heic) and filler: no decoder takes it. */
export function heifHeader(): Buffer {
	return Buffer.concat([
		Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'),
		Buffer.alloc(2048, 7)
	]);
}

/** Width and height of a JPEG (its SOF segment) or PNG (IHDR). */
export function imageSize(bytes: Buffer): { width: number; height: number } {
	if (bytes[0] === 0x89) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	let at = 2;
	while (at + 9 < bytes.length) {
		const marker = bytes[at + 1]!;
		const length = bytes.readUInt16BE(at + 2);
		if (marker >= 0xc0 && marker <= 0xc3)
			return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
		at += 2 + length;
	}
	throw new Error('no SOF segment');
}
