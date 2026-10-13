import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OCR_ASSET_VERSION } from '../src/lib/shared/ocr/assets.ts';
import { checkOcrFile } from '../src/lib/shared/ocr/image-kind.ts';
import { buildPage, type OcrDocument, type RecognisedWord } from '../src/lib/shared/ocr/lines.ts';
import { readOcrDocument, type OcrReadResult } from '../src/lib/shared/ocr/read.ts';
import { wibTodayString } from '../src/lib/shared/dates.ts';
import { assertLocalOnly } from './local-guard.ts';

/**
 * `npm run compat:ocr [-- --dir .superpowers/ref/samples/ocr]` (FN-16g): runs every PNG/JPEG the owner put in the
 * local, git-ignored samples folder through tesseract.js in Node (the same pinned engine and language files the
 * browser downloads, from `static/_ocr/`) and the same shared reading pipeline the server uses, then prints
 * counts and shapes only — never row text, amounts or a file's name. Scanned PDFs are checked in the browser e2e
 * (Node has no canvas to render them). Always exits 0: a calibration report, not a gate.
 */

export const DEFAULT_OCR_SAMPLES = '.superpowers/ref/samples/ocr';
const ALLOWED_ROOT = '.superpowers/ref/samples';

export interface OcrSampleLine {
	size: string;
	meanConf: string;
	words: string;
	institution: string;
	rows: string;
	review: string;
	rejected: string;
	balance: string;
	ms: string;
}

/** Refuses a directory outside `.superpowers/ref/samples/` (symlinks resolved), so no other folder is read. */
export function allowedSamplesDir(dir: string, cwd: string = process.cwd()): boolean {
	const root = resolve(cwd, ALLOWED_ROOT);
	let target = resolve(cwd, dir);
	try {
		target = realpathSync(target);
	} catch {
		// A folder that does not exist yet is judged by its path.
	}
	let base = root;
	try {
		base = realpathSync(root);
	} catch {
		// idem
	}
	return target === base || target.startsWith(base + sep);
}

/** Image files under `dir` (recursive, sorted, dot-files skipped), by extension. */
export function sampleFiles(dir: string): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile() && !d.name.startsWith('.') && /\.(png|jpe?g)$/i.test(d.name))
		.map((d) => join(d.parentPath, d.name))
		.sort();
}

const REFUSALS: Readonly<Record<string, string>> = {
	institution_unknown: 'not recognised',
	institution_mismatch: 'mismatch',
	institution_conflict: 'two institutions',
	inconsistent: 'inconsistent (low-confidence figure or balance gap)',
	no_rows: 'no rows',
	section_required: 'several accounts',
	section_unknown: 'unknown account',
	section_unsupported: 'unsupported account'
};

/** One sample's line from its reading (counts and labels only). */
export function sampleLine(doc: OcrDocument, result: OcrReadResult, ms: number): OcrSampleLine {
	const page = doc.pages[0];
	const words = doc.pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.words.length, 0), 0);
	const base = {
		size: page ? `${page.widthPx}x${page.heightPx}` : '—',
		meanConf: page ? String(page.meanConf) : '—',
		words: String(words),
		ms: String(Math.round(ms))
	};
	if (!result.ok)
		return {
			...base,
			institution: '—',
			rows: String(result.counts.rows),
			review: '—',
			rejected: `— (${REFUSALS[result.error] ?? result.error})`,
			balance: result.counts.gapMinor === null ? '—' : `gap ${result.counts.gapMinor} minor units`
		};
	const { reading } = result;
	const review = new Map<string, number>();
	const rejected = new Map<string, number>();
	let ok = 0;
	for (const r of reading.rows) {
		if (r.ok) {
			ok++;
			if (r.review) review.set(r.review, (review.get(r.review) ?? 0) + 1);
		} else rejected.set(r.reason, (rejected.get(r.reason) ?? 0) + 1);
	}
	const list = (m: Map<string, number>) => [...m].map(([k, n]) => `${k}: ${n}`).join(', ');
	const b = reading.balance;
	return {
		...base,
		institution: reading.institution.id,
		rows: String(ok),
		review: review.size > 0 ? list(review) : '0',
		rejected: rejected.size > 0 ? list(rejected) : '0',
		balance: b.status === 'pass' ? 'pass' : b.status === 'gap' ? `gap ${b.gapMinor}` : 'not printed'
	};
}

const COLUMNS: [keyof OcrSampleLine, string][] = [
	['size', 'pixels'],
	['meanConf', 'mean conf'],
	['words', 'words'],
	['institution', 'institution'],
	['rows', 'rows read'],
	['review', 'review (reason: n)'],
	['rejected', 'rejected (reason: n)'],
	['balance', 'balance'],
	['ms', 'ms']
];

/** The table: a header and one numbered line per sample (file index, never its name). */
export function formatOcrTable(lines: readonly OcrSampleLine[]): string {
	const rows = [
		['#', ...COLUMNS.map(([, h]) => h)],
		...lines.map((l, i) => [String(i + 1), ...COLUMNS.map(([k]) => l[k])])
	];
	const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
	return rows
		.map((r) =>
			r
				.map((cell, c) => cell.padEnd(widths[c]!))
				.join('  ')
				.trimEnd()
		)
		.join('\n');
}

type Recognise = (bytes: Uint8Array) => Promise<RecognisedWord[]>;

/** The engine in Node with the pinned local files; terminated by the caller. */
async function nodeEngine(): Promise<{ recognise: Recognise; terminate: () => Promise<void> }> {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const langPath = join(root, 'static', '_ocr', OCR_ASSET_VERSION, 'lang');
	if (!existsSync(langPath)) throw new Error('run npm run ocr:assets first');
	const { default: T } = await import('tesseract.js');
	const cachePath = mkdtempSync(join(tmpdir(), 'compat-ocr-'));
	const worker = await T.createWorker(['ind', 'eng'], T.OEM.LSTM_ONLY, {
		langPath,
		cachePath,
		gzip: false,
		cacheMethod: 'none'
	});
	await worker.setParameters({ tessedit_pageseg_mode: T.PSM.AUTO, preserve_interword_spaces: '1' });
	return {
		async recognise(bytes) {
			const { data } = await worker.recognize(
				Buffer.from(bytes),
				{},
				{ blocks: true, text: false }
			);
			const out: RecognisedWord[] = [];
			for (const block of data.blocks ?? [])
				for (const p of block.paragraphs)
					for (const l of p.lines)
						for (const w of l.words)
							out.push({ text: w.text, confidence: w.confidence, ...w.bbox });
			return out;
		},
		async terminate() {
			await worker.terminate();
			rmSync(cachePath, { recursive: true, force: true });
		}
	};
}

export async function compatOcrReport(
	dir: string,
	engine: () => Promise<{ recognise: Recognise; terminate: () => Promise<void> }> = nodeEngine
): Promise<string> {
	if (!allowedSamplesDir(dir)) return `compat:ocr refuses a folder outside ${ALLOWED_ROOT}/.`;
	const files = sampleFiles(dir);
	if (files.length === 0)
		return `No OCR samples in ${relative(process.cwd(), resolve(dir)) || dir} (tidak ada sampel).`;
	const run = await engine();
	const lines: OcrSampleLine[] = [];
	try {
		for (const file of files) {
			const bytes = new Uint8Array(readFileSync(file));
			const checked = checkOcrFile(bytes, bytes.length);
			if ('refusal' in checked || !checked.size) {
				lines.push({
					size: '—',
					meanConf: '—',
					words: '—',
					institution: '—',
					rows: '—',
					review: '—',
					rejected: `— (${'refusal' in checked ? checked.refusal : 'no size'})`,
					balance: '—',
					ms: '0'
				});
				continue;
			}
			const started = performance.now();
			const words = await run.recognise(bytes);
			const doc: OcrDocument = {
				pages: [buildPage(words, checked.size.width, checked.size.height)]
			};
			const result = readOcrDocument({
				doc,
				institution: null,
				section: null,
				todayWib: wibTodayString()
			});
			lines.push(sampleLine(doc, result, performance.now() - started));
		}
	} finally {
		await run.terminate();
	}
	return [
		`OCR samples (${lines.length} files; unverified layouts until calibrated):`,
		formatOcrTable(lines)
	].join('\n');
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	assertLocalOnly(argv);
	const at = argv.indexOf('--dir');
	const dir = at >= 0 ? (argv[at + 1] ?? DEFAULT_OCR_SAMPLES) : DEFAULT_OCR_SAMPLES;
	try {
		console.log(await compatOcrReport(dir));
	} catch (e) {
		console.log(`compat:ocr stopped: ${e instanceof Error ? e.name : 'error'}`);
	}
	process.exit(0);
}
