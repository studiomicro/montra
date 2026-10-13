import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	OCR_ASSET_VERSION,
	OCR_ASSETS,
	OCR_NOTICES_FILE,
	TESSDATA_FAST_COMMIT,
	type OcrAsset
} from '../src/lib/shared/ocr/assets.ts';
import {
	buildOcrAssets,
	OcrAssetError,
	ocrAssetsCurrent,
	tessdataUrl,
	verifyAsset
} from './ocr-assets.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const temps: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'ocr-assets-'));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fictional pinned set: one npm file and one language file with their own sizes and hashes. */
function fixture() {
	const nodeModules = temp();
	mkdirSync(join(nodeModules, 'pkg'), { recursive: true });
	const script = new TextEncoder().encode('self.x = 1;');
	writeFileSync(join(nodeModules, 'pkg', 'worker.js'), script);
	const lang = new TextEncoder().encode('fictional traineddata bytes');
	const assets: OcrAsset[] = [
		{
			path: 'worker.min.js',
			bytes: script.length,
			kind: 'script',
			from: { npm: 'pkg/worker.js', sha256: sha(script) }
		},
		{
			path: 'lang/ind.traineddata',
			bytes: lang.length,
			kind: 'data',
			from: { tessdata: 'ind.traineddata', sha256: sha(lang) }
		}
	];
	return { nodeModules, assets, lang };
}

describe('scripts/ocr-assets (criterion 2)', () => {
	it('pins tessdata_fast commit 87416418…41c29bd and the PRD hashes and sizes', () => {
		expect(TESSDATA_FAST_COMMIT).toBe('87416418657359cb625c412a48b6e1d6d41c29bd');
		expect(tessdataUrl('ind.traineddata')).toBe(
			'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/ind.traineddata'
		);
		const lang = (l: string) => OCR_ASSETS.find((a) => a.path === `lang/${l}.traineddata`)!;
		expect(lang('ind')).toMatchObject({
			bytes: 1_122_661,
			from: { sha256: '69786901da87ab8766c1ea7fbb10b28f2110c14da3f6c8f2735df131fba95d88' }
		});
		expect(lang('eng')).toMatchObject({
			bytes: 4_113_088,
			from: { sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' }
		});
	});

	it('writes the version folder from node_modules and a verified download, then serves it from cache', async () => {
		const { nodeModules, assets, lang } = fixture();
		const outDir = temp();
		const cacheDir = temp();
		const urls: string[] = [];
		const download = async (url: string) => {
			urls.push(url);
			return lang;
		};
		const target = await buildOcrAssets({ outDir, cacheDir, nodeModules, download, assets });
		expect(relative(outDir, target)).toBe(OCR_ASSET_VERSION);
		expect(readFileSync(join(target, 'lang/ind.traineddata'))).toEqual(Buffer.from(lang));
		expect(existsSync(join(target, OCR_NOTICES_FILE))).toBe(true);
		expect(urls).toEqual([tessdataUrl('ind.traineddata')]);
		// Second run: the cached copy verifies, nothing is downloaded.
		await buildOcrAssets({ outDir, cacheDir, nodeModules, download, assets });
		expect(urls).toHaveLength(1);
	});

	it('fails on a SHA-256 mismatch, a tampered cache, a missing file and a wrong size; no half folder is left', async () => {
		const { nodeModules, assets, lang } = fixture();
		const outDir = temp();
		const cacheDir = temp();
		const tampered = Uint8Array.from(lang, (b, i) => (i === 0 ? b ^ 1 : b));
		await expect(
			buildOcrAssets({ outDir, cacheDir, nodeModules, assets, download: async () => tampered })
		).rejects.toBeInstanceOf(OcrAssetError);
		expect(readdirSync(outDir)).toEqual([]);
		// A tampered cached copy is dropped and downloaded again (and must verify).
		mkdirSync(join(cacheDir, TESSDATA_FAST_COMMIT), { recursive: true });
		writeFileSync(join(cacheDir, TESSDATA_FAST_COMMIT, 'ind.traineddata'), tampered);
		let downloads = 0;
		await buildOcrAssets({
			outDir,
			cacheDir,
			nodeModules,
			assets,
			download: async () => (downloads++, lang)
		});
		expect(downloads).toBe(1);
		rmSync(join(nodeModules, 'pkg', 'worker.js'));
		await expect(
			buildOcrAssets({ outDir: temp(), cacheDir, nodeModules, assets, download: async () => lang })
		).rejects.toThrow(/missing/);
		expect(() => verifyAsset(assets[0]!, new Uint8Array(3))).toThrow(OcrAssetError);
	});
});

describe('npm engine files and the already-built shortcut are hash-checked (red team L1)', () => {
	it('every shipped file has a pinned SHA-256, and the pinned files in node_modules match when present', () => {
		for (const a of OCR_ASSETS) expect(a.from.sha256).toMatch(/^[0-9a-f]{64}$/);
		for (const a of OCR_ASSETS) {
			if (!('npm' in a.from)) continue;
			const file = join('node_modules', a.from.npm);
			if (existsSync(file)) expect(sha(readFileSync(file))).toBe(a.from.sha256);
		}
	});

	it('an npm file altered to the same size is refused by the build', async () => {
		const { nodeModules, assets, lang } = fixture();
		const same = new TextEncoder().encode('self.x = 2;');
		expect(same.length).toBe(assets[0]!.bytes);
		writeFileSync(join(nodeModules, 'pkg', 'worker.js'), same);
		await expect(
			buildOcrAssets({
				outDir: temp(),
				cacheDir: temp(),
				nodeModules,
				assets,
				download: async () => lang
			})
		).rejects.toThrow(/SHA-256/);
		expect(() => verifyAsset(assets[0]!, same)).toThrow(/SHA-256/);
	});

	it('the shortcut accepts an intact folder and rejects a same-size altered file', async () => {
		const { nodeModules, assets, lang } = fixture();
		const outDir = temp();
		const target = await buildOcrAssets({
			outDir,
			cacheDir: temp(),
			nodeModules,
			assets,
			download: async () => lang
		});
		expect(ocrAssetsCurrent(outDir, assets)).toBe(true);
		const file = join(target, 'worker.min.js');
		writeFileSync(file, new TextEncoder().encode('self.x = 2;'));
		expect(ocrAssetsCurrent(outDir, assets)).toBe(false);
	});

	it('red team L4: a planted extra file or edited notices makes the folder not current (rebuilt)', async () => {
		const { nodeModules, assets, lang } = fixture();
		const outDir = temp();
		const options = { outDir, cacheDir: temp(), nodeModules, assets, download: async () => lang };
		const target = await buildOcrAssets(options);
		expect(ocrAssetsCurrent(outDir, assets)).toBe(true);
		mkdirSync(join(target, 'extra'), { recursive: true });
		writeFileSync(join(target, 'extra', 'page.html'), '<script>alert(1)</script>');
		expect(ocrAssetsCurrent(outDir, assets)).toBe(false);
		await buildOcrAssets(options);
		expect(ocrAssetsCurrent(outDir, assets)).toBe(true);
		writeFileSync(join(target, 'evil.svg'), '<svg/>');
		expect(ocrAssetsCurrent(outDir, assets)).toBe(false);
		await buildOcrAssets(options);
		writeFileSync(join(target, OCR_NOTICES_FILE), 'edited');
		expect(ocrAssetsCurrent(outDir, assets)).toBe(false);
	});
});

describe('the shipped asset set (criterion 3)', () => {
	it('is only the LSTM cores, worker, page module, pdf.js and its decoders, ind/eng and licences', () => {
		const paths = OCR_ASSETS.map((a) => a.path);
		const cores = paths.filter((p) => p.startsWith('core/'));
		expect(cores.sort()).toEqual([
			'core/tesseract-core-lstm.wasm.js',
			'core/tesseract-core-relaxedsimd-lstm.wasm.js',
			'core/tesseract-core-simd-lstm.wasm.js'
		]);
		expect(paths.some((p) => p.endsWith('.map'))).toBe(false);
		expect(paths.filter((p) => p.startsWith('lang/')).sort()).toEqual([
			'lang/eng.traineddata',
			'lang/ind.traineddata'
		]);
		expect(paths.filter((p) => !/^(core|lang|licenses)\//.test(p)).sort()).toEqual([
			'pdf/pdf.min.mjs',
			'pdf/pdf.worker.min.mjs',
			'pdf/wasm/jbig2.wasm',
			'pdf/wasm/openjpeg.wasm',
			'pdf/wasm/qcms_bg.wasm',
			'tesseract.esm.min.js',
			'worker.min.js'
		]);
		// Largest file well under the 25 MiB Workers static asset limit.
		expect(Math.max(...OCR_ASSETS.map((a) => a.bytes))).toBeLessThan(25 * 1024 * 1024);
	});

	it('a built folder, when present, holds exactly that set at the pinned sizes', () => {
		for (const dir of ['static/_ocr', '.svelte-kit/cloudflare/_ocr']) {
			const target = join(dir, OCR_ASSET_VERSION);
			if (!existsSync(target)) continue;
			const files = readdirSync(target, { recursive: true, withFileTypes: true })
				.filter((d) => d.isFile())
				.map((d) => relative(target, join(d.parentPath, d.name)))
				.sort();
			expect(files).toEqual([...OCR_ASSETS.map((a) => a.path), OCR_NOTICES_FILE].sort());
			expect(ocrAssetsCurrent(dir)).toBe(true);
			expect(readdirSync(dir)).toEqual([OCR_ASSET_VERSION]);
		}
	});
});
