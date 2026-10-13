import { describe, expect, it } from 'vitest';
import { bytes, jpeg, seg } from '../../../../test/helpers/images';
import { orientationTransform, orientedSize, readExifOrientation } from './exif';

/** Where the stored image's top-left pixel must land when shown upright (EXIF 2.32, Orientation tag). */
const TOP_LEFT_GOES_TO: Record<number, 'tl' | 'tr' | 'br' | 'bl'> = {
	1: 'tl',
	2: 'tr',
	3: 'br',
	4: 'bl',
	5: 'tl',
	6: 'tr',
	7: 'br',
	8: 'bl'
};

describe('EXIF orientation', () => {
	for (let o = 1; o <= 8; o++) {
		it(`orientation ${o}: read from the JPEG, upright size and marker position`, () => {
			// A 16×8 stored image with a marker pixel at its top-left (0,0) and one at (15,0).
			expect(readExifOrientation(jpeg({ orientation: o, width: 16, height: 8 }))).toBe(o);
			const size = orientedSize(o, 16, 8);
			expect(size).toEqual(o >= 5 ? { width: 8, height: 16 } : { width: 16, height: 8 });
			const [a, b, c, d, e, f] = orientationTransform(o, 16, 8);
			const map = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
			// The pixel's own corner (0,0)…(1,1) maps to a unit square; take its centre.
			const [cx, cy] = map(0.5, 0.5) as [number, number];
			const corner = `${cy < size.height / 2 ? 't' : 'b'}${cx < size.width / 2 ? 'l' : 'r'}`;
			expect(corner).toBe(TOP_LEFT_GOES_TO[o]);
			// Every stored pixel lands inside the upright canvas.
			for (const [x, y] of [
				[0.5, 0.5],
				[15.5, 0.5],
				[0.5, 7.5],
				[15.5, 7.5]
			] as const) {
				const [px, py] = map(x, y) as [number, number];
				expect(px).toBeGreaterThan(0);
				expect(py).toBeGreaterThan(0);
				expect(px).toBeLessThan(size.width);
				expect(py).toBeLessThan(size.height);
			}
		});
	}

	it('is 1 for no EXIF, a non-JPEG, a broken segment or an out-of-range value', () => {
		expect(
			readExifOrientation(bytes([0xff, 0xd8], seg(0xdb, new Uint8Array(4)), [0xff, 0xd9]))
		).toBe(1);
		expect(readExifOrientation(bytes('GIF89a'))).toBe(1);
		expect(readExifOrientation(bytes([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]))).toBe(1);
		expect(readExifOrientation(jpeg({ orientation: 9 }))).toBe(1);
	});

	it('reads only the first 64 KB', () => {
		const late = bytes(
			[0xff, 0xd8],
			seg(0xe2, new Uint8Array(40_000)),
			seg(0xe2, new Uint8Array(40_000)),
			jpeg({ orientation: 6 }).subarray(2)
		);
		expect(readExifOrientation(late)).toBe(1);
	});
});
