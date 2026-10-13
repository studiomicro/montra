import { OCR_PAGE_TIMEOUT_MS, OCR_RUN_TIMEOUT_MS } from '#lib/shared/ocr/image-kind';
import { buildPage, type OcrDocument } from '#lib/shared/ocr/lines';
import type { OcrEngine } from './engine';
import type { PageCanvas } from './image';

/**
 * One reading run (FN-16g): pages are prepared and read strictly one after another (one page canvas plus the
 * engine in memory at a time), each canvas zeroed as soon as it is read, one engine for the whole run and always
 * terminated at the end. `Batal` (the signal) or a time budget ends the run at once and drops everything read so
 * far: there is no half import. Only words, confidences and integer positions come out — no image data.
 */

export class OcrRunStopped extends Error {
	constructor(readonly reason: 'cancelled' | 'page_timeout' | 'run_timeout') {
		super(reason);
	}
}

export interface RunOptions {
	signal: AbortSignal;
	/** Called before page `n` (1-based) of `total` is read. */
	onPage?: (n: number, total: number) => void;
	pageTimeoutMs?: number;
	runTimeoutMs?: number;
	now?: () => number;
}

/** Rejects when the run is cancelled or `ms` pass, whichever first; settled with `work` otherwise. */
function bounded<T>(
	work: Promise<T>,
	ms: number,
	signal: AbortSignal,
	reason: 'page_timeout' | 'run_timeout'
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => finish(() => reject(new OcrRunStopped('cancelled')));
		const timer = setTimeout(() => finish(() => reject(new OcrRunStopped(reason))), ms);
		const finish = (f: () => void) => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			f();
		};
		if (signal.aborted) return onAbort();
		if (ms <= 0) return finish(() => reject(new OcrRunStopped(reason)));
		signal.addEventListener('abort', onAbort);
		work.then(
			(v) => finish(() => resolve(v)),
			(e) => finish(() => reject(e))
		);
	});
}

/**
 * Reads `pages` (each prepared only when its turn comes) with one engine from `start`. The engine is
 * terminated on every exit, cancellation included.
 */
export async function runOcr(
	pages: readonly (() => Promise<PageCanvas>)[],
	start: () => Promise<OcrEngine>,
	options: RunOptions
): Promise<OcrDocument> {
	const now = options.now ?? Date.now;
	const deadline = now() + (options.runTimeoutMs ?? OCR_RUN_TIMEOUT_MS);
	const pageMs = options.pageTimeoutMs ?? OCR_PAGE_TIMEOUT_MS;
	const left = () => deadline - now();
	const starting = start();
	let engine: OcrEngine;
	try {
		engine = await bounded(starting, left(), options.signal, 'run_timeout');
	} catch (e) {
		// Batal (or the budget) while the engine was still downloading: an engine that starts after that is
		// terminated as it arrives, so no worker is left behind.
		starting.then(
			(late) => void late.terminate().catch(() => {}),
			() => {}
		);
		throw e;
	}
	const stop = () => void engine.terminate().catch(() => {});
	options.signal.addEventListener('abort', stop);
	try {
		const out: OcrDocument = { pages: [] };
		for (const [i, prepare] of pages.entries()) {
			options.onPage?.(i + 1, pages.length);
			const pending = prepare();
			let page: PageCanvas;
			try {
				page = await bounded(pending, left(), options.signal, 'run_timeout');
			} catch (e) {
				// A page that finishes preparing after the run stopped is still zeroed.
				pending.then(
					(p) => p.release(),
					() => {}
				);
				throw e;
			}
			try {
				const ms = Math.min(pageMs, left());
				const reason = ms < pageMs ? 'run_timeout' : 'page_timeout';
				const words = await bounded(engine.recognize(page.canvas), ms, options.signal, reason);
				out.pages.push(buildPage(words, page.canvas.width, page.canvas.height));
			} finally {
				page.release();
			}
		}
		return out;
	} finally {
		options.signal.removeEventListener('abort', stop);
		await engine.terminate().catch(() => {});
	}
}
