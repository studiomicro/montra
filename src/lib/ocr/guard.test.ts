import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OCR_ASSET_BASE } from '#lib/shared/ocr/assets';
import { engineOptions } from './engine';

/** Source and built files for the FN-16g guards (criteria 4, 6, 19). */
function files(dir: string, ext: RegExp): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile() && ext.test(d.name))
		.map((d) => join(d.parentPath, d.name));
}
const CDN = /cdn\.jsdelivr\.net|unpkg\.com|tessdata\.projectnaptha\.com|cdnjs/;

describe('OCR module guards', () => {
	const ocr = files('src/lib/ocr', /\.(ts|svelte)$/).filter((f) => !f.endsWith('.test.ts'));

	it('the client OCR module names no CDN and no https:// load target; every engine path is on this origin', () => {
		expect(ocr.length).toBeGreaterThan(3);
		for (const f of ocr) {
			const text = readFileSync(f, 'utf8');
			expect(text, f).not.toMatch(CDN);
			expect(text, f).not.toMatch(/['"`]https?:\/\//);
		}
		const options = engineOptions('simd');
		expect(options.workerBlobURL).toBe(false);
		expect(options.gzip).toBe(false);
		for (const key of ['workerPath', 'corePath', 'langPath'] as const)
			expect(options[key]!.startsWith(`${OCR_ASSET_BASE}/`), key).toBe(true);
	});

	it('never creates an object URL (no blob: workers or images)', () => {
		for (const f of ocr) expect(readFileSync(f, 'utf8'), f).not.toMatch(/createObjectURL/);
	});

	it('tesseract.js and pdfjs-dist are never imported by server, shared, worker or route-server code; the client imports types only', () => {
		const runtime =
			/(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+['"](tesseract\.js|pdfjs-dist)|import\(\s*['"](tesseract\.js|pdfjs-dist)/;
		const anywhere =
			/(?:from\s+|import\(\s*|require\(\s*)['"](tesseract\.js|pdfjs-dist)(?:\/[^'"]*)?['"]/;
		const elsewhere = [
			...files('src/lib/server', /\.ts$/),
			...files('src/lib/shared', /\.ts$/),
			...files('workers', /\.ts$/),
			...files('src/routes', /\+(page|layout)\.server\.ts$|\+server\.ts$/)
		];
		for (const f of elsewhere) expect(readFileSync(f, 'utf8'), f).not.toMatch(anywhere);
		for (const f of [
			...ocr,
			...files('src/routes', /\.svelte$/),
			...files('src/lib/ui', /\.svelte$/)
		])
			expect(readFileSync(f, 'utf8'), f).not.toMatch(runtime);
	});

	it('the built client bundle (when present) carries no CDN host and no tesseract or pdf.js code', () => {
		for (const f of files('.svelte-kit/output/client/_app', /\.js$/)) {
			const text = readFileSync(f, 'utf8');
			expect(text, f).not.toMatch(CDN);
			expect(text, f).not.toMatch(/TesseractCore|pdfjsVersion|PDFPageProxy/);
		}
	});
});
