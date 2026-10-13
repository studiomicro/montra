import { describe, expect, it } from 'vitest';
import {
	imageRunAssets,
	OCR_ASSET_BASE,
	pdfRunAssets,
	type OcrAsset
} from '#lib/shared/ocr/assets';
import { downloadAssets, OcrDownloadError, totalBytes } from './download';
import { coreVariant, ocrSupported } from './support';

const full = {
	WebAssembly: {},
	Worker: function Worker() {},
	createImageBitmap: () => {},
	document: { createElement: () => {} }
};

describe('capability gate (criterion 11)', () => {
	it('is supported only with WebAssembly, Worker, createImageBitmap and a canvas', () => {
		expect(ocrSupported(full)).toBe(true);
		expect(
			ocrSupported({ ...full, document: undefined, OffscreenCanvas: function OffscreenCanvas() {} })
		).toBe(true);
		for (const missing of ['WebAssembly', 'Worker', 'createImageBitmap'] as const)
			expect(ocrSupported({ ...full, [missing]: undefined })).toBe(false);
		expect(ocrSupported({ ...full, document: undefined })).toBe(false);
	});

	it('picks the core variant tesseract.js would pick, plain when validation throws', () => {
		expect(coreVariant(() => true)).toBe('relaxedsimd');
		expect(coreVariant((b) => b.length !== 36)).toBe('simd');
		expect(coreVariant(() => false)).toBe('plain');
		expect(
			coreVariant(() => {
				throw new Error('no wasm');
			})
		).toBe('plain');
	});
});

/** A fetch stub answering each asset with `bytes` bytes, or a status. */
function stubFetch(
	answer: (
		asset: OcrAsset,
		url: string
	) => { status?: number; bytes?: number; type?: string } | 'reject'
) {
	const urls: string[] = [];
	const all = [...imageRunAssets('simd'), ...pdfRunAssets()];
	const fetchStub = (async (input: RequestInfo | URL) => {
		const url = String(input);
		urls.push(url);
		const asset = all.find((a) => url.endsWith(`/${a.path}`))!;
		const a = answer(asset, url);
		if (a === 'reject') throw new TypeError('network');
		const type = a.type ?? (asset.kind === 'data' ? 'application/octet-stream' : 'text/javascript');
		return new Response(new Uint8Array(a.bytes ?? asset.bytes), {
			status: a.status ?? 200,
			headers: { 'content-type': type }
		});
	}) as typeof fetch;
	return { fetchStub, urls };
}

describe('engine download (criterion 12)', () => {
	const assets = imageRunAssets('simd');

	it('fetches every file from this origin’s versioned folder and reports byte progress', async () => {
		const { fetchStub, urls } = stubFetch(() => ({}));
		const progress: number[] = [];
		await downloadAssets(assets, { fetch: fetchStub, onProgress: (d) => progress.push(d) });
		expect(urls.every((u) => u.startsWith(`${OCR_ASSET_BASE}/`))).toBe(true);
		expect(urls).toHaveLength(assets.length);
		expect(progress.at(-1)).toBe(totalBytes(assets));
		expect(totalBytes(assets)).toBeGreaterThan(9_000_000);
	});

	it('fails on a network error, a 404 (not installed), a 500, a wrong size or content type; a retry works', async () => {
		const cases: [Parameters<typeof stubFetch>[0], string][] = [
			[() => 'reject', 'failed'],
			[() => ({ status: 404 }), 'not_installed'],
			[(a) => (a.path === 'worker.min.js' ? { status: 404 } : {}), 'failed'],
			[() => ({ status: 500 }), 'failed'],
			[(a) => (a.path.endsWith('ind.traineddata') ? { bytes: a.bytes - 1 } : {}), 'failed'],
			[(a) => (a.path.endsWith('eng.traineddata') ? { bytes: a.bytes + 1 } : {}), 'failed'],
			[() => ({ type: 'text/html' }), 'failed']
		];
		for (const [answer, reason] of cases) {
			const { fetchStub } = stubFetch(answer);
			await expect(downloadAssets(assets, { fetch: fetchStub })).rejects.toEqual(
				new OcrDownloadError(reason as 'failed')
			);
		}
		const { fetchStub } = stubFetch(() => ({}));
		await expect(downloadAssets(assets, { fetch: fetchStub })).resolves.toBeUndefined();
	});
});
