/**
 * Whether this browser can read images on the device (FN-16g): WebAssembly, a Web Worker, a canvas and
 * `createImageBitmap`. Checked before anything is downloaded; without them the OCR block says so and the PDF/CSV
 * import stays usable.
 */
export interface OcrGlobals {
	WebAssembly?: unknown;
	Worker?: unknown;
	createImageBitmap?: unknown;
	OffscreenCanvas?: unknown;
	document?: { createElement?: unknown };
}

export function ocrSupported(g: OcrGlobals = globalThis as OcrGlobals): boolean {
	return (
		typeof g.WebAssembly === 'object' &&
		g.WebAssembly !== null &&
		typeof g.Worker === 'function' &&
		typeof g.createImageBitmap === 'function' &&
		(typeof g.OffscreenCanvas === 'function' || typeof g.document?.createElement === 'function')
	);
}

/** The core variant tesseract.js would pick (relaxed SIMD, SIMD or plain), by validating tiny probe modules. */
const RELAXED_SIMD = [
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15,
	65, 2, 253, 15, 253, 128, 2, 11
];
const SIMD = [
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
	253, 98, 11
];

export function coreVariant(
	validate: (bytes: Uint8Array) => boolean = (b) => WebAssembly.validate(b as BufferSource)
): 'relaxedsimd' | 'simd' | 'plain' {
	const ok = (bytes: number[]) => {
		try {
			return validate(Uint8Array.from(bytes));
		} catch {
			return false;
		}
	};
	if (ok(RELAXED_SIMD)) return 'relaxedsimd';
	if (ok(SIMD)) return 'simd';
	return 'plain';
}
