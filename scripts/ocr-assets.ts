import { createHash } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	OCR_ASSET_VERSION,
	OCR_ASSETS,
	OCR_NOTICES_FILE,
	TESSDATA_FAST_COMMIT,
	type OcrAsset
} from '../src/lib/shared/ocr/assets.ts';

/**
 * `npm run ocr:assets` (FN-16g): puts the on-device OCR engine into the git-ignored `static/_ocr/<version>/`,
 * which SvelteKit then ships as static assets served from the app's own origin. Engine, worker and pdf.js files
 * are copied from the pinned npm packages; the two tessdata_fast language files are downloaded once from the
 * pinned commit into the git-ignored `.ocr-cache/`. Every file is checked against its pinned size and SHA-256,
 * also when the "already built" shortcut applies. Any mismatch, or a missing file, fails the run (and so the build). Older version folders are removed.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

export const OCR_STATIC_DIR = join(root, 'static', '_ocr');
export const OCR_CACHE_DIR = join(root, '.ocr-cache');

/** The pinned download of one tessdata_fast language file. */
export const tessdataUrl = (file: string) =>
	`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_FAST_COMMIT}/${file}`;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class OcrAssetError extends Error {}

/** Checks one file's bytes against its pinned size and SHA-256 (npm files and language data alike). */
export function verifyAsset(asset: OcrAsset, bytes: Uint8Array): void {
	if (bytes.byteLength !== asset.bytes)
		throw new OcrAssetError(
			`ocr-assets: ${asset.path} is ${bytes.byteLength} bytes, pinned ${asset.bytes}`
		);
	if (sha256(bytes) !== asset.from.sha256)
		throw new OcrAssetError(`ocr-assets: ${asset.path} does not match its pinned SHA-256`);
}

export interface OcrAssetOptions {
	/** Output folder (the parent of the version folder). */
	outDir: string;
	cacheDir: string;
	nodeModules: string;
	/** Fetches a URL's bytes (injected by tests; never called when the cache holds a good copy). */
	download: (url: string) => Promise<Uint8Array>;
	/** The pinned list (tests pass a fictional one with their own sizes and hashes). */
	assets?: readonly OcrAsset[];
}

async function realDownload(url: string): Promise<Uint8Array> {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) throw new OcrAssetError(`ocr-assets: download failed (${response.status})`);
	return new Uint8Array(await response.arrayBuffer());
}

/** A language file: the cached copy when it verifies, else a fresh download that must verify. */
async function languageBytes(asset: OcrAsset, options: OcrAssetOptions): Promise<Uint8Array> {
	if (!('tessdata' in asset.from)) throw new OcrAssetError('not a language file');
	const cached = join(options.cacheDir, TESSDATA_FAST_COMMIT, asset.from.tessdata);
	if (existsSync(cached)) {
		const bytes = new Uint8Array(readFileSync(cached));
		try {
			verifyAsset(asset, bytes);
			return bytes;
		} catch {
			rmSync(cached);
		}
	}
	const bytes = await options.download(tessdataUrl(asset.from.tessdata));
	verifyAsset(asset, bytes);
	mkdirSync(dirname(cached), { recursive: true });
	writeFileSync(`${cached}.tmp`, bytes);
	renameSync(`${cached}.tmp`, cached);
	return bytes;
}

const NOTICE = `Third-party software in this folder (FN-16g on-device OCR)

tesseract.js 7.0.0 - Apache License 2.0 - https://github.com/naptha/tesseract.js
tesseract.js-core 7.0.0 - Apache License 2.0 - https://github.com/naptha/tesseract.js-core
  (Tesseract OCR, Apache License 2.0; Leptonica, BSD-2-Clause style licence)
pdf.js (pdfjs-dist 6.4.299) - Apache License 2.0 - https://github.com/mozilla/pdf.js
  (OpenJPEG, JBIG2 and qcms decoders: see licenses/LICENSE_*)
tessdata_fast (ind, eng) commit ${TESSDATA_FAST_COMMIT} - Apache License 2.0 -
  https://github.com/tesseract-ocr/tessdata_fast

Full licence texts are in licenses/.
`;

/**
 * Writes every pinned file into `<outDir>/<version>/`, verified. Built in a temporary folder and renamed into
 * place, so a failed run never leaves a half-filled version folder that would be served.
 */
export async function buildOcrAssets(options: OcrAssetOptions): Promise<string> {
	const target = join(options.outDir, OCR_ASSET_VERSION);
	const staging = `${target}.tmp`;
	rmSync(staging, { recursive: true, force: true });
	try {
		for (const asset of options.assets ?? OCR_ASSETS) {
			const dest = join(staging, asset.path);
			mkdirSync(dirname(dest), { recursive: true });
			if ('npm' in asset.from) {
				const source = join(options.nodeModules, asset.from.npm);
				if (!existsSync(source)) throw new OcrAssetError(`ocr-assets: missing ${asset.from.npm}`);
				verifyAsset(asset, new Uint8Array(readFileSync(source)));
				copyFileSync(source, dest);
			} else {
				writeFileSync(dest, await languageBytes(asset, options));
			}
		}
		writeFileSync(join(staging, OCR_NOTICES_FILE), NOTICE);
		rmSync(target, { recursive: true, force: true });
		renameSync(staging, target);
	} catch (e) {
		rmSync(staging, { recursive: true, force: true });
		throw e;
	}
	// Only the current version is served.
	for (const entry of readdirSync(options.outDir))
		if (entry !== OCR_ASSET_VERSION) rmSync(join(options.outDir, entry), { recursive: true });
	return target;
}

/** Every file under `dir`, as `/`-separated paths relative to it (folders themselves are not listed). */
function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => !e.isDirectory())
		.map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'));
}

/**
 * True when the version folder holds exactly the pinned files, each with its pinned size and SHA-256, plus the
 * notices file with its own text, and nothing else (red team L4: a planted extra file would ship under the
 * `/_ocr/*` policy; the rebuild removes it). The fast path reads and hashes about 20 MB, so an altered file of the
 * same size is rebuilt, not trusted.
 */
export function ocrAssetsCurrent(
	outDir: string,
	assets: readonly OcrAsset[] = OCR_ASSETS
): boolean {
	const target = join(outDir, OCR_ASSET_VERSION);
	if (!existsSync(target)) return false;
	const expected = new Set([...assets.map((a) => a.path), OCR_NOTICES_FILE]);
	const present = filesUnder(target);
	if (present.length !== expected.size || present.some((p) => !expected.has(p))) return false;
	return (
		readFileSync(join(target, OCR_NOTICES_FILE), 'utf8') === NOTICE &&
		assets.every((a) => {
			const file = join(target, a.path);
			if (!existsSync(file) || statSync(file).size !== a.bytes) return false;
			try {
				verifyAsset(a, new Uint8Array(readFileSync(file)));
				return true;
			} catch {
				return false;
			}
		})
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	mkdirSync(OCR_STATIC_DIR, { recursive: true });
	if (ocrAssetsCurrent(OCR_STATIC_DIR) && !process.argv.includes('--force')) {
		console.log(`ocr-assets: ${OCR_ASSET_VERSION} is current`);
	} else {
		try {
			await buildOcrAssets({
				outDir: OCR_STATIC_DIR,
				cacheDir: OCR_CACHE_DIR,
				nodeModules: join(root, 'node_modules'),
				download: realDownload
			});
			console.log(`ocr-assets: wrote static/_ocr/${OCR_ASSET_VERSION}`);
		} catch (e) {
			console.error(e instanceof Error ? e.message : 'ocr-assets: failed');
			process.exit(1);
		}
	}
}
