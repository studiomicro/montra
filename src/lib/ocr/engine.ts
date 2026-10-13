import type Tesseract from 'tesseract.js';
import {
	OCR_ASSET_BASE,
	OCR_CORES,
	ocrAssetUrl,
	type OcrCoreVariant
} from '#lib/shared/ocr/assets';
import type { RecognisedWord } from '#lib/shared/ocr/lines';

/**
 * The OCR engine (FN-16g): one tesseract.js Web Worker (no pool), languages `ind+eng`, LSTM only. Loaded from
 * this origin only, never at page load: the page-side module comes from `/_ocr/<version>/` by a dynamic
 * `import()` when the user has picked a file. Every location is explicit (tesseract.js would otherwise fall back
 * to public CDNs) and the worker is started from its own URL, never a `blob:` (the page CSP has no `blob:`).
 * WebAssembly is compiled inside the worker, under the `/_ocr/` response policy (src/lib/server/csp.ts).
 */

export interface OcrEngine {
	recognize(image: HTMLCanvasElement | OffscreenCanvas): Promise<RecognisedWord[]>;
	terminate(): Promise<void>;
}

/** A worker that never reports ready (blocked, crashed) is given up on after this long. */
export const ENGINE_START_TIMEOUT_MS = 60_000;

/** Where every engine file comes from: this origin's versioned folder. */
export function engineOptions(core: OcrCoreVariant): Partial<Tesseract.WorkerOptions> {
	return {
		workerPath: ocrAssetUrl('worker.min.js'),
		corePath: ocrAssetUrl(OCR_CORES[core]),
		langPath: `${OCR_ASSET_BASE}/lang`,
		gzip: false,
		workerBlobURL: false,
		cacheMethod: 'write'
	};
}

type TesseractModule = { default: typeof Tesseract };

/** Starts the engine; rejects when it cannot start (and leaves no worker behind). */
export async function startEngine(core: OcrCoreVariant): Promise<OcrEngine> {
	const { default: T } = (await import(
		/* @vite-ignore */ ocrAssetUrl('tesseract.esm.min.js')
	)) as TesseractModule;
	let worker: Tesseract.Worker | null = null;
	let abandoned = false;
	let failed: ((e: unknown) => void) | null = null;
	const failure = new Promise<never>((_, reject) => (failed = reject));
	const timer = setTimeout(
		() => failed?.(new Error('engine start timeout')),
		ENGINE_START_TIMEOUT_MS
	);
	const created = T.createWorker(['ind', 'eng'], T.OEM.LSTM_ONLY, {
		...engineOptions(core),
		errorHandler: (e: unknown) => failed?.(e)
	});
	// A worker that arrives after the start was given up on is terminated at once.
	created.then(
		(w) => {
			if (abandoned) void w.terminate().catch(() => {});
		},
		() => {}
	);
	try {
		worker = await Promise.race([created, failure]);
		await Promise.race([
			worker.setParameters({ tessedit_pageseg_mode: T.PSM.AUTO, preserve_interword_spaces: '1' }),
			failure
		]);
	} catch (e) {
		abandoned = true;
		void (worker as Tesseract.Worker | null)?.terminate().catch(() => {});
		throw e;
	} finally {
		clearTimeout(timer);
	}
	const ready = worker;
	return {
		async recognize(image) {
			const { data } = await ready.recognize(
				image as HTMLCanvasElement,
				{},
				{ blocks: true, text: false }
			);
			const words: RecognisedWord[] = [];
			for (const block of data.blocks ?? [])
				for (const paragraph of block.paragraphs)
					for (const line of paragraph.lines)
						for (const w of line.words)
							words.push({ text: w.text, confidence: w.confidence, ...w.bbox });
			return words;
		},
		async terminate() {
			await ready.terminate();
		}
	};
}
