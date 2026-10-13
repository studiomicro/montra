import { DESKEW_WORK_SIDE, estimateSkew, shouldDeskew } from '#lib/shared/ocr/deskew';
import { orientationTransform, orientedSize, readExifOrientation } from '#lib/shared/ocr/exif';
import { readingSize, type OcrInput } from '#lib/shared/ocr/image-kind';

/**
 * A picked photo or screenshot → one upright, bounded, de-skewed page canvas (FN-16g, PRD Scope 3). Decoded with
 * `createImageBitmap` at the reading size (a 48 MP camera photo is never materialised whole), EXIF orientation
 * applied by the browser or, where it does not, from the tag; canvases are zeroed and bitmaps closed as soon
 * as they are done with. Never an object URL, never an `<img>`: the page's img-src stays `'self' data:`.
 */

export interface PageCanvas {
	canvas: HTMLCanvasElement;
	/** Zeroes the canvas (frees its pixels at once). */
	release(): void;
}

export const releaseCanvas = (canvas: HTMLCanvasElement) => {
	canvas.width = 0;
	canvas.height = 0;
};

function canvasOf(width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

/** A 2×1 JPEG tagged Orientation 6 (rotate 90°): a browser that applies EXIF decodes it as 1×2. */
const ORIENTATION_PROBE =
	'/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAAD//Z';

let probe: Promise<boolean> | null = null;

/** Whether `imageOrientation: 'from-image'` is honoured here (checked once per page load). */
export function browserAppliesOrientation(): Promise<boolean> {
	probe ??= (async () => {
		try {
			const bytes = Uint8Array.from(atob(ORIENTATION_PROBE), (c) => c.charCodeAt(0));
			const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
				imageOrientation: 'from-image'
			});
			const upright = bitmap.width === 1 && bitmap.height === 2;
			bitmap.close();
			return upright;
		} catch {
			return false;
		}
	})();
	return probe;
}

/** Turns the page level when its text lines are tilted (deskew.ts); returns the canvas to read. */
function deskew(canvas: HTMLCanvasElement): HTMLCanvasElement {
	const scale = Math.min(1, DESKEW_WORK_SIDE / Math.max(canvas.width, canvas.height));
	const small = canvasOf(
		Math.max(1, Math.round(canvas.width * scale)),
		Math.max(1, Math.round(canvas.height * scale))
	);
	let degrees: number;
	try {
		const context = small.getContext('2d', { willReadFrequently: true });
		if (!context) return canvas;
		context.drawImage(canvas, 0, 0, small.width, small.height);
		const rgba = context.getImageData(0, 0, small.width, small.height).data;
		const gray = new Uint8Array(small.width * small.height);
		for (let i = 0; i < gray.length; i++)
			gray[i] = (rgba[i * 4]! * 299 + rgba[i * 4 + 1]! * 587 + rgba[i * 4 + 2]! * 114) / 1000;
		degrees = estimateSkew(gray, small.width, small.height);
	} finally {
		releaseCanvas(small);
	}
	if (!shouldDeskew(degrees)) return canvas;
	const level = canvasOf(canvas.width, canvas.height);
	const context = level.getContext('2d');
	if (!context) {
		releaseCanvas(level);
		return canvas;
	}
	context.fillStyle = '#fff';
	context.fillRect(0, 0, level.width, level.height);
	context.translate(level.width / 2, level.height / 2);
	context.rotate((-degrees * Math.PI) / 180);
	context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
	releaseCanvas(canvas);
	return level;
}

/** Decodes one image into its page canvas. `head`: the file's first bytes (EXIF), `input`: its checked kind. */
export async function imagePage(
	file: Blob,
	head: Uint8Array,
	input: OcrInput
): Promise<PageCanvas> {
	const auto = await browserAppliesOrientation();
	const orientation = input.kind === 'jpeg' ? readExifOrientation(head) : 1;
	const stored = input.size;
	const upright = stored ? orientedSize(orientation, stored.width, stored.height) : null;
	const target = upright ? readingSize(upright.width, upright.height) : null;
	const options: ImageBitmapOptions = { imageOrientation: auto ? 'from-image' : 'none' };
	if (target && stored && target.scale < 1) {
		// The browser resizes the upright image when it applies the orientation itself, else the stored one.
		const size = auto
			? target
			: {
					width: Math.round(stored.width * target.scale),
					height: Math.round(stored.height * target.scale)
				};
		options.resizeWidth = Math.max(1, size.width);
		options.resizeHeight = Math.max(1, size.height);
		options.resizeQuality = 'high';
	}
	const bitmap = await createImageBitmap(file, options);
	let canvas: HTMLCanvasElement;
	try {
		// A HEIC photo's size is not known to this code: its declared pixels were capped before decoding, and the page is scaled here.
		const fit = readingSize(bitmap.width, bitmap.height);
		const w = Math.round(bitmap.width * fit.scale);
		const h = Math.round(bitmap.height * fit.scale);
		const turn = !auto && orientation !== 1;
		const out = turn ? orientedSize(orientation, w, h) : { width: w, height: h };
		canvas = canvasOf(out.width, out.height);
		const context = canvas.getContext('2d');
		if (!context) throw new Error('no canvas');
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		if (turn) context.setTransform(...orientationTransform(orientation, w, h));
		context.drawImage(bitmap, 0, 0, w, h);
	} finally {
		bitmap.close();
	}
	const level = deskew(canvas);
	return { canvas: level, release: () => releaseCanvas(level) };
}
