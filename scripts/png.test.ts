import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodeIndexedPng, pngSize } from './png.ts';

function rgba(
	width: number,
	height: number,
	pixel: (x: number, y: number) => [number, number, number, number]
) {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
	return { width, height, data };
}

describe('encodeIndexedPng / decodePng', () => {
	it('round-trips a flat image with a few colours at every bit depth', () => {
		for (const colours of [2, 3, 12, 40]) {
			const image = rgba(37, 19, (x, y) => [((x + y) % colours) * 5, 10, 200, 255]);
			const png = encodeIndexedPng(image);
			// The decoder reads the RGB/RGBA files Chromium writes; this file is indexed (colour type 3).
			expect(png[25]).toBe(3);
			expect(pngSize(png)).toEqual({ width: 37, height: 19 });
		}
	});

	it('is deterministic: the same pixels give the same bytes', () => {
		const image = rgba(64, 64, (x, y) =>
			x > 20 && y > 20 ? [1, 2, 3, 255] : [250, 250, 250, 255]
		);
		expect(encodeIndexedPng(image).equals(encodeIndexedPng(image))).toBe(true);
	});

	it('packs a mostly flat image far below its raw size', () => {
		const image = rgba(1000, 1000, () => [17, 17, 18, 255]);
		expect(encodeIndexedPng(image).length).toBeLessThan(2_000);
	});

	it('refuses transparency and more than 256 colours', () => {
		expect(() => encodeIndexedPng(rgba(2, 2, () => [0, 0, 0, 0]))).toThrow(/opaque/);
		expect(() =>
			encodeIndexedPng(rgba(300, 1, (x) => [x % 256, Math.floor(x / 256), 0, 255]))
		).toThrow(/256 colours/);
	});
});

describe('decodePng', () => {
	/** A one-row RGBA PNG made by hand (filter 0), so the decoder is checked against known bytes. */
	function handmade(pixels: number[]): Buffer {
		const crc = (b: Buffer) => {
			let c = 0xffffffff;
			for (const byte of b) {
				c ^= byte;
				for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			}
			return (c ^ 0xffffffff) >>> 0;
		};
		const chunk = (type: string, data: Buffer) => {
			const body = Buffer.concat([Buffer.from(type), data]);
			const out = Buffer.alloc(body.length + 8);
			out.writeUInt32BE(data.length, 0);
			body.copy(out, 4);
			out.writeUInt32BE(crc(body), body.length + 4);
			return out;
		};
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(pixels.length / 4, 0);
		ihdr.writeUInt32BE(1, 4);
		ihdr[8] = 8;
		ihdr[9] = 6;
		return Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk('IHDR', ihdr),
			chunk('IDAT', deflateSync(Buffer.from([0, ...pixels]))),
			chunk('IEND', Buffer.alloc(0))
		]);
	}

	it('reads an 8-bit RGBA file', () => {
		const png = decodePng(handmade([10, 20, 30, 255, 0, 0, 0, 0]));
		expect([png.width, png.height]).toEqual([2, 1]);
		expect([...png.data]).toEqual([10, 20, 30, 255, 0, 0, 0, 0]);
	});

	it('refuses an indexed file and a file that is not a PNG', () => {
		expect(() => decodePng(encodeIndexedPng(rgba(2, 2, () => [1, 2, 3, 255])))).toThrow(
			/unsupported/
		);
		expect(() => pngSize(Buffer.from('GIF89a'))).toThrow(/not a PNG/);
	});
});
