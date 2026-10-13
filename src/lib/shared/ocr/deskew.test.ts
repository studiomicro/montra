import { describe, expect, it } from 'vitest';
import { DESKEW_WORK_SIDE, downscaleGray, estimateSkew, shouldDeskew } from './deskew';

/** A synthetic page: dark "words" along text lines tilted by `degrees` (y down), white elsewhere. */
function textBars(width: number, height: number, degrees: number): Uint8Array {
	const gray = new Uint8Array(width * height).fill(255);
	const t = Math.tan((degrees * Math.PI) / 180);
	for (let y = 0; y < height; y++)
		for (let x = 60; x < width - 60; x++) {
			const along = y - (x - width / 2) * t;
			const inLine = ((along % 36) + 36) % 36 < 9;
			const inWord = Math.floor(x / 28) % 4 !== 3;
			if (along > 40 && along < height - 40 && inLine && inWord) gray[y * width + x] = 20;
		}
	return gray;
}

/** Nearest-neighbour rotation by `degrees` around the centre (white outside): the de-rotation step. */
function rotate(gray: Uint8Array, width: number, height: number, degrees: number): Uint8Array {
	const out = new Uint8Array(width * height).fill(255);
	const a = (degrees * Math.PI) / 180;
	const cx = width / 2;
	const cy = height / 2;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const sx = Math.round(Math.cos(a) * (x - cx) + Math.sin(a) * (y - cy) + cx);
			const sy = Math.round(-Math.sin(a) * (x - cx) + Math.cos(a) * (y - cy) + cy);
			if (sx >= 0 && sy >= 0 && sx < width && sy < height)
				out[y * width + x] = gray[sy * width + sx]!;
		}
	return out;
}

describe('estimateSkew', () => {
	for (const degrees of [-12, -3, 0, 4, 11]) {
		it(`estimates ${degrees}° within 0.75° and de-rotates to level`, () => {
			const page = textBars(600, 500, degrees);
			const found = estimateSkew(page, 600, 500);
			expect(Math.abs(found - degrees)).toBeLessThanOrEqual(0.75);
			const level = rotate(page, 600, 500, -found);
			expect(Math.abs(estimateSkew(level, 600, 500))).toBeLessThanOrEqual(0.75);
		});
	}

	it('returns 0 for a blank or near-blank page', () => {
		expect(estimateSkew(new Uint8Array(400 * 300).fill(255), 400, 300)).toBe(0);
		const specks = new Uint8Array(400 * 300).fill(255);
		for (let i = 0; i < 20; i++) specks[i * 997] = 0;
		expect(estimateSkew(specks, 400, 300)).toBe(0);
	});

	it('works on a downscaled copy of a large page (bounded) and finds the same angle', () => {
		const big = textBars(2400, 1800, 4);
		const small = downscaleGray(big, 2400, 1800);
		expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(DESKEW_WORK_SIDE);
		const started = performance.now();
		expect(Math.abs(estimateSkew(big, 2400, 1800) - 4)).toBeLessThanOrEqual(0.75);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it('rotates only from 0.7° on', () => {
		expect(shouldDeskew(0.6)).toBe(false);
		expect(shouldDeskew(-0.7)).toBe(true);
	});
});
