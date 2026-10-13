/**
 * The on-device OCR engine's files (FN-16g): what `npm run ocr:assets` (scripts/ocr-assets.ts) copies or downloads
 * into the git-ignored `static/_ocr/<version>/`, and what the browser may fetch from there. One list, so the build
 * script, the client's size check and the asset-set test agree. Every file is served from the app's own origin;
 * no CDN (docs/features/fn-16g-ocr/PRD.md Scope 1).
 *
 * Sizes are the exact bytes of the pinned packages (`tesseract.js` 7.0.0, `tesseract.js-core` 7.0.0,
 * `pdfjs-dist` 6.4.299) and of the pinned tessdata_fast commit; a changed byte count blocks the build and is
 * refused by the client.
 */

export const TESSDATA_FAST_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd';

/** Bumped with any pinned version: the folder is served as immutable, so a new version needs a new path. */
export const OCR_ASSET_VERSION = 'tess7.0.0-pdfjs6.4.299-fast874164';

/** Where the files are served (and where the build writes them under `static/`). */
export const OCR_ASSET_BASE = `/_ocr/${OCR_ASSET_VERSION}`;

export type OcrAssetKind = 'script' | 'module' | 'wasm' | 'data' | 'text';

export interface OcrAsset {
	/** Path under the version folder. */
	path: string;
	/** Exact size in bytes. */
	bytes: number;
	kind: OcrAssetKind;
	/** Where it comes from: a file in node_modules or the tessdata_fast download, with its pinned SHA-256. */
	from: { npm: string; sha256: string } | { tessdata: string; sha256: string };
}

/** The three LSTM-only cores; tessdata_fast is LSTM-only, so the legacy cores are never shipped. */
export const OCR_CORES = {
	relaxedsimd: 'core/tesseract-core-relaxedsimd-lstm.wasm.js',
	simd: 'core/tesseract-core-simd-lstm.wasm.js',
	plain: 'core/tesseract-core-lstm.wasm.js'
} as const;

export type OcrCoreVariant = keyof typeof OCR_CORES;

export const OCR_LANGUAGES = ['ind', 'eng'] as const;

export const OCR_ASSETS: readonly OcrAsset[] = [
	// tesseract.js: the page-side module and the worker script.
	{
		path: 'tesseract.esm.min.js',
		bytes: 63_220,
		kind: 'module',
		from: {
			npm: 'tesseract.js/dist/tesseract.esm.min.js',
			sha256: '64871d76c75609fd5413b88a8171e2ef40deedd77d5875ba23df104b2d05eb29'
		}
	},
	{
		path: 'worker.min.js',
		bytes: 111_307,
		kind: 'script',
		from: {
			npm: 'tesseract.js/dist/worker.min.js',
			sha256: '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d'
		}
	},
	{
		path: OCR_CORES.relaxedsimd,
		bytes: 3_905_767,
		kind: 'script',
		from: {
			npm: 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
			sha256: '861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3'
		}
	},
	{
		path: OCR_CORES.simd,
		bytes: 3_899_472,
		kind: 'script',
		from: {
			npm: 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
			sha256: 'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38'
		}
	},
	{
		path: OCR_CORES.plain,
		bytes: 3_896_484,
		kind: 'script',
		from: {
			npm: 'tesseract.js-core/tesseract-core-lstm.wasm.js',
			sha256: 'eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680'
		}
	},
	// Language data (tessdata_fast, raw `.traineddata`; the edge compresses it in transit).
	{
		path: 'lang/ind.traineddata',
		bytes: 1_122_661,
		kind: 'data',
		from: {
			tessdata: 'ind.traineddata',
			sha256: '69786901da87ab8766c1ea7fbb10b28f2110c14da3f6c8f2735df131fba95d88'
		}
	},
	{
		path: 'lang/eng.traineddata',
		bytes: 4_113_088,
		kind: 'data',
		from: {
			tessdata: 'eng.traineddata',
			sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
		}
	},
	// pdf.js, for scanned PDFs only: the page module, its worker and the image decoders' wasm.
	{
		path: 'pdf/pdf.min.mjs',
		bytes: 458_904,
		kind: 'module',
		from: {
			npm: 'pdfjs-dist/build/pdf.min.mjs',
			sha256: '57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2'
		}
	},
	{
		path: 'pdf/pdf.worker.min.mjs',
		bytes: 1_264_342,
		kind: 'module',
		from: {
			npm: 'pdfjs-dist/build/pdf.worker.min.mjs',
			sha256: '9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18'
		}
	},
	{
		path: 'pdf/wasm/openjpeg.wasm',
		bytes: 251_131,
		kind: 'wasm',
		from: {
			npm: 'pdfjs-dist/wasm/openjpeg.wasm',
			sha256: '95e5002597af0824004aa57b1900fe019715db389e37640b1e58395e42f00cc5'
		}
	},
	{
		path: 'pdf/wasm/jbig2.wasm',
		bytes: 103_671,
		kind: 'wasm',
		from: {
			npm: 'pdfjs-dist/wasm/jbig2.wasm',
			sha256: '466f45c2a61a698152fb5400c27e56ff2ceb73dcb71fde3fc366a502308eaab0'
		}
	},
	{
		path: 'pdf/wasm/qcms_bg.wasm',
		bytes: 96_589,
		kind: 'wasm',
		from: {
			npm: 'pdfjs-dist/wasm/qcms_bg.wasm',
			sha256: '663d86126d5f5fcb1c61490f94353e2a8375660b8c5498ab3ebab5a34b08800e'
		}
	},
	// License texts (Apache-2.0 and the decoders' own notices), shipped next to the code they cover.
	...(
		[
			[
				'licenses/tesseract.js-LICENSE.md',
				11_357,
				'tesseract.js/LICENSE.md',
				'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1'
			],
			[
				'licenses/tesseract.min.js.LICENSE.txt',
				149,
				'tesseract.js/dist/tesseract.min.js.LICENSE.txt',
				'cdf963ced7d25a0f98901a547647b4d6e2dbe0197fd78c87a059a87b0e542fe2'
			],
			[
				'licenses/worker.min.js.LICENSE.txt',
				466,
				'tesseract.js/dist/worker.min.js.LICENSE.txt',
				'45f54171aeaa1d10c0c1a66f374b7bba1f02472b1487fbe892eec04f840002ac'
			],
			[
				'licenses/tesseract.js-core-LICENSE',
				11_358,
				'tesseract.js-core/LICENSE',
				'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'
			],
			[
				'licenses/pdfjs-LICENSE',
				10_174,
				'pdfjs-dist/LICENSE',
				'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594'
			],
			[
				'licenses/LICENSE_JBIG2',
				12_862,
				'pdfjs-dist/wasm/LICENSE_JBIG2',
				'9e66b7f1b934a28b37f3bc4dac97915de1674271e79a0a88182a18ed9731b4d1'
			],
			[
				'licenses/LICENSE_OPENJPEG',
				2_112,
				'pdfjs-dist/wasm/LICENSE_OPENJPEG',
				'a6af136f3e15038a666b61f376612a07d9a4e48cb7c01adbf3e33b3f14ab49b6'
			],
			[
				'licenses/LICENSE_PDFJS_JBIG2',
				555,
				'pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2',
				'aad3cce09842e00e9e11ad5e8fef8cc02fbc3a3768fe2f007443b9cee37aaee5'
			],
			[
				'licenses/LICENSE_PDFJS_OPENJPEG',
				1_285,
				'pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG',
				'717fc62da03292dbb4dd0c8280bd4ce7bb8550dcf31d772bc93455fb50313425'
			],
			[
				'licenses/LICENSE_PDFJS_QCMS',
				1_036,
				'pdfjs-dist/wasm/LICENSE_PDFJS_QCMS',
				'508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1'
			],
			[
				'licenses/LICENSE_QCMS',
				1_121,
				'pdfjs-dist/wasm/LICENSE_QCMS',
				'36d847ae882f6574ebc72f56a4f354e4f104fde4a584373496482e97d52d31bc'
			]
		] as const
	).map(([path, bytes, npm, sha256]): OcrAsset => ({
		path,
		bytes,
		kind: 'text',
		from: { npm, sha256 }
	}))
];

/** The notices file the build writes (not copied, so it has no pinned size). */
export const OCR_NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

export function ocrAsset(path: string): OcrAsset {
	const asset = OCR_ASSETS.find((a) => a.path === path);
	if (!asset) throw new Error('unknown OCR asset');
	return asset;
}

/** The URL a file is served at, on this origin. */
export const ocrAssetUrl = (path: string) => `${OCR_ASSET_BASE}/${path}`;

/**
 * Content types the client accepts for each kind: anything else (an HTML error or fallback page, most often)
 * means the file is not there and nothing is run.
 */
export function contentTypeFits(kind: OcrAssetKind, contentType: string | null): boolean {
	const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
	switch (kind) {
		case 'script':
		case 'module':
			return type === 'text/javascript' || type === 'application/javascript';
		case 'wasm':
			return type === 'application/wasm';
		case 'data':
			return type === 'application/octet-stream' || type === '';
		case 'text':
			return type.startsWith('text/') || type === 'application/octet-stream' || type === '';
	}
}

/** The files the first image run downloads (the core variant is chosen per device). */
export function imageRunAssets(core: OcrCoreVariant): OcrAsset[] {
	return [
		ocrAsset('tesseract.esm.min.js'),
		ocrAsset('worker.min.js'),
		ocrAsset(OCR_CORES[core]),
		...OCR_LANGUAGES.map((l) => ocrAsset(`lang/${l}.traineddata`))
	];
}

/** pdf.js files a scanned-PDF run needs on top of the engine (the decoders' wasm loads only on demand). */
export function pdfRunAssets(): OcrAsset[] {
	return [ocrAsset('pdf/pdf.min.mjs'), ocrAsset('pdf/pdf.worker.min.mjs')];
}
