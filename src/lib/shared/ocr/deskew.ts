/**
 * Skew estimate of a photographed page (FN-16g, PRD Scope 3 camera photos): a projection-profile search. Text
 * lines tilted by θ lie along y − x·tan θ = constant, so binning the dark pixels by that value gives the sharpest
 * profile (largest variance of the bin counts) at θ. Searched over −15° … +15° in 0.5° steps on a grayscale copy
 * scaled to at most DESKEW_WORK_SIDE, so the cost is bounded whatever the photo's size. Pure over a typed array.
 */

const DESKEW_MAX_DEGREES = 15;
const DESKEW_STEP_DEGREES = 0.5;
/** The caller rotates the page only from this estimate on. */
const DESKEW_MIN_DEGREES = 0.7;
/** Longest side of the working copy. */
export const DESKEW_WORK_SIDE = 800;
/** Darker than this (0–255) counts as ink. */
const INK = 128;
/** Fewer ink pixels than this share of the page: blank, no estimate. */
const MIN_INK_SHARE = 0.001;
/** Ink pixels sampled at most (evenly), keeping the search cheap on a dense page. */
const MAX_SAMPLES = 60_000;

/** Box-downscales a grayscale raster so its long side is at most `maxSide` (returned as is when it fits). */
export function downscaleGray(
	gray: Uint8Array,
	width: number,
	height: number,
	maxSide: number = DESKEW_WORK_SIDE
): { gray: Uint8Array; width: number; height: number } {
	const factor = Math.ceil(Math.max(width, height) / maxSide);
	if (factor <= 1) return { gray, width, height };
	const w = Math.floor(width / factor);
	const h = Math.floor(height / factor);
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let sum = 0;
			for (let dy = 0; dy < factor; dy++) {
				const row = (y * factor + dy) * width + x * factor;
				for (let dx = 0; dx < factor; dx++) sum += gray[row + dx]!;
			}
			out[y * w + x] = Math.round(sum / (factor * factor));
		}
	return { gray: out, width: w, height: h };
}

/** The text-line angle in degrees (positive: lines fall to the right, y down), or 0 for a blank page. */
export function estimateSkew(gray: Uint8Array, width: number, height: number): number {
	const work = downscaleGray(gray, width, height);
	const xs: number[] = [];
	const ys: number[] = [];
	let ink = 0;
	for (let i = 0; i < work.gray.length; i++) if (work.gray[i]! < INK) ink++;
	if (ink < Math.max(50, work.gray.length * MIN_INK_SHARE)) return 0;
	const stride = Math.max(1, Math.ceil(ink / MAX_SAMPLES));
	let seen = 0;
	for (let y = 0; y < work.height; y++)
		for (let x = 0; x < work.width; x++)
			if (work.gray[y * work.width + x]! < INK && seen++ % stride === 0) {
				xs.push(x);
				ys.push(y);
			}
	const diagonal = Math.ceil(Math.hypot(work.width, work.height));
	const bins = new Float64Array(diagonal * 2 + 1);
	const varianceAt = (degrees: number) => {
		const a = (degrees * Math.PI) / 180;
		const cos = Math.cos(a);
		const sin = Math.sin(a);
		bins.fill(0);
		for (let i = 0; i < xs.length; i++)
			bins[Math.round(ys[i]! * cos - xs[i]! * sin) + diagonal]! += 1;
		let sum = 0;
		let squares = 0;
		for (const v of bins) {
			sum += v;
			squares += v * v;
		}
		const mean = sum / bins.length;
		return squares / bins.length - mean * mean;
	};
	let best = 0;
	let bestVariance = varianceAt(0);
	const level = bestVariance;
	for (let d = -DESKEW_MAX_DEGREES; d <= DESKEW_MAX_DEGREES + 1e-9; d += DESKEW_STEP_DEGREES) {
		const v = varianceAt(d);
		if (v > bestVariance) {
			bestVariance = v;
			best = d;
		}
	}
	// No clear line structure (a photo, noise): the profile barely sharpens, so nothing is rotated.
	if (bestVariance < level * 1.02) return 0;
	return Math.round(best * 10) / 10;
}

/** Whether a page should be turned before reading. */
export const shouldDeskew = (degrees: number) => Math.abs(degrees) >= DESKEW_MIN_DEGREES;
