import type * as Pdfjs from 'pdfjs-dist';
import { ocrAssetUrl } from '#lib/shared/ocr/assets';
import {
	OCR_MAX_DECLARED_PIXELS,
	OCR_MAX_PDF_PAGES,
	readingSize
} from '#lib/shared/ocr/image-kind';
import { hasReadableText } from '#lib/shared/statements/text-layer';
import { releaseCanvas, type PageCanvas } from './image';

/**
 * Scanned or image-only statement PDFs on the device (FN-16g): pdf.js from this origin's `/_ocr/` folder (never
 * the server's `unpdf` copy), its worker started from its own URL, its image decoders' WebAssembly loaded from
 * the same folder and compiled inside that worker. Pages are rendered one at a time at the reading size; the
 * first OCR_MAX_PDF_PAGES are read and the rest reported. A PDF with a text layer is not read here: the
 * existing text-PDF import reads it exactly.
 */

export type PdfRefusal = 'has_text' | 'password_needed' | 'password_wrong' | 'corrupt';

export interface OpenPdf {
	pages: number;
	/** Pages past the cap, not read. */
	pagesNotProcessed: number;
	render(pageNumber: number): Promise<PageCanvas>;
	close(): Promise<void>;
}

type PdfjsModule = typeof Pdfjs;

/** How many pages are checked for a text layer before deciding the file is a scan. */
const TEXT_CHECK_PAGES = 3;

export async function openPdf(
	bytes: Uint8Array,
	password: string | null
): Promise<{ ok: true; pdf: OpenPdf } | { ok: false; refusal: PdfRefusal }> {
	const pdfjs = (await import(/* @vite-ignore */ ocrAssetUrl('pdf/pdf.min.mjs'))) as PdfjsModule;
	pdfjs.GlobalWorkerOptions.workerSrc = ocrAssetUrl('pdf/pdf.worker.min.mjs');
	const task = pdfjs.getDocument({
		data: bytes,
		password: password ?? undefined,
		wasmUrl: ocrAssetUrl('pdf/wasm/'),
		maxImageSize: OCR_MAX_DECLARED_PIXELS,
		disableFontFace: true,
		useSystemFonts: false,
		stopAtErrors: false
	});
	let doc: Pdfjs.PDFDocumentProxy;
	try {
		doc = await task.promise;
	} catch (e) {
		await task.destroy().catch(() => {});
		const err = e as { name?: unknown; code?: unknown } | null;
		if (err?.name === 'PasswordException')
			return { ok: false, refusal: err.code === 2 ? 'password_wrong' : 'password_needed' };
		return { ok: false, refusal: 'corrupt' };
	}
	try {
		for (let n = 1; n <= Math.min(doc.numPages, TEXT_CHECK_PAGES); n++) {
			const page = await doc.getPage(n);
			const content = await page.getTextContent();
			const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
			page.cleanup();
			if (hasReadableText(text)) {
				await task.destroy();
				return { ok: false, refusal: 'has_text' };
			}
		}
	} catch {
		await task.destroy().catch(() => {});
		return { ok: false, refusal: 'corrupt' };
	}
	const pages = Math.min(doc.numPages, OCR_MAX_PDF_PAGES);
	return {
		ok: true,
		pdf: {
			pages,
			pagesNotProcessed: doc.numPages - pages,
			async render(pageNumber) {
				const page = await doc.getPage(pageNumber);
				try {
					const base = page.getViewport({ scale: 1 });
					// PDF points at 72 dpi; a scan reads best near 200–300 dpi, bounded by the page cap.
					const wanted = readingSize(base.width * 4, base.height * 4);
					const viewport = page.getViewport({ scale: 4 * wanted.scale });
					const canvas = document.createElement('canvas');
					canvas.width = Math.floor(viewport.width);
					canvas.height = Math.floor(viewport.height);
					try {
						await page.render({ canvas, viewport, background: '#ffffff' }).promise;
					} catch (e) {
						releaseCanvas(canvas);
						throw e;
					}
					return { canvas, release: () => releaseCanvas(canvas) };
				} finally {
					page.cleanup();
				}
			},
			async close() {
				await task.destroy();
			}
		}
	};
}
