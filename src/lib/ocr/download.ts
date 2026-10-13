import { contentTypeFits, ocrAssetUrl, type OcrAsset } from '#lib/shared/ocr/assets';

/**
 * The engine's first download (FN-16g), with a byte counter: every file is fetched from this origin's
 * `/_ocr/<version>/` and checked against its pinned size and content type before anything runs. The bytes are
 * not kept here: the browser's HTTP cache (the folder is immutable) then serves the engine's own requests.
 * Nothing half-loaded is ever used: a failure stops the run before the engine starts.
 */

export type DownloadFailure =
	/** The files are not on this server (the build step was skipped). */
	| 'not_installed'
	/** Network error, a wrong status, size or content type. */
	| 'failed';

export class OcrDownloadError extends Error {
	constructor(readonly reason: DownloadFailure) {
		super(reason);
	}
}

export interface DownloadOptions {
	signal?: AbortSignal;
	onProgress?: (doneBytes: number, totalBytes: number) => void;
	fetch?: typeof fetch;
}

export const totalBytes = (assets: readonly OcrAsset[]) => assets.reduce((n, a) => n + a.bytes, 0);

export async function downloadAssets(
	assets: readonly OcrAsset[],
	options: DownloadOptions = {}
): Promise<void> {
	const get = options.fetch ?? fetch;
	const total = totalBytes(assets);
	let done = 0;
	options.onProgress?.(0, total);
	for (const [i, asset] of assets.entries()) {
		let response: Response;
		try {
			response = await get(ocrAssetUrl(asset.path), {
				signal: options.signal,
				credentials: 'same-origin'
			});
		} catch (e) {
			if (options.signal?.aborted) throw e;
			throw new OcrDownloadError('failed');
		}
		if (response.status === 404 && i === 0) throw new OcrDownloadError('not_installed');
		if (!response.ok || !response.body) throw new OcrDownloadError('failed');
		if (!contentTypeFits(asset.kind, response.headers.get('content-type'))) {
			await response.body.cancel();
			throw new OcrDownloadError('failed');
		}
		const reader = response.body.getReader();
		let bytes = 0;
		try {
			for (;;) {
				const { done: end, value } = await reader.read();
				if (end) break;
				bytes += value.byteLength;
				if (bytes > asset.bytes) throw new OcrDownloadError('failed');
				options.onProgress?.(done + bytes, total);
			}
		} catch (e) {
			await reader.cancel().catch(() => {});
			if (e instanceof OcrDownloadError || options.signal?.aborted) throw e;
			throw new OcrDownloadError('failed');
		}
		if (bytes !== asset.bytes) throw new OcrDownloadError('failed');
		done += asset.bytes;
	}
}
