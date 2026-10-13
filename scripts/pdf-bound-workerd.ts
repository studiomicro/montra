import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { build } from 'esbuild';
import { buildPdf, deflateStream, textContent, type PdfPage } from '../test/helpers/pdf.ts';
import { patchPdfjs, PDFJS_MODULE } from './pdfjs-bounded.ts';

/**
 * `npm run test:pdf-workerd` (FN-16a cycle 3, red team N1): proves the PDF decode bound in **workerd**, the
 * production runtime, not only in Node. `src/lib/server/statements/pdf-text.ts` is bundled with the same
 * PDF.js patch the app build applies. Each fictional file runs in a fresh `workerd` process: one warm-up read
 * of a small text PDF loads PDF.js, then the process's VmHWM (peak RSS) is the baseline, the file is posted,
 * and VmHWM is read again. Every bomb shape from both security reports must answer `too_complex` with peak
 * growth under GROWTH_LIMIT_MIB; honest files must read. Exits 1 on any miss. Run under the heavy lock; every
 * workerd it starts is killed, also on failure.
 */

/** Allowed peak RSS growth per file: the Worker isolate limit is 128 MB. */
const GROWTH_LIMIT_MIB = 64;
const MiB = 1024 * 1024;
const PREFIX = 'BT /F1 10 Tf 40 800 Td (Contoh fiktif satu dua tiga) Tj ET ';

interface Case {
	name: string;
	pdf: Uint8Array;
	expect: 'ok' | 'too_complex';
	password?: string;
}

const raw = (dict: string, data: Uint8Array, gap?: string): PdfPage => ({
	content: '',
	raw: { dict, data, gap }
});

/** 64 MiB of spaces as Brotli (about 1 KB): a bomb no allowlisted reader may decode. */
const brotliBomb = () => new Uint8Array(brotliCompressSync(Buffer.alloc(64 * MiB, 0x20)));

async function cases(): Promise<Case[]> {
	const statement = buildPdf([
		{
			content: textContent([
				'BANK CONTOH FIKTIF',
				'PERIODE 01/12/2025 - 31/01/2026',
				'SALDO AWAL 1.000.000,00'
			])
		},
		{
			content: textContent(['01/12 KOPI CONTOH 25.000,00 DB', '15/12 GAJI FIKTIF 5.000.000,00 CR']),
			flate: true
		},
		{ content: textContent(['02/01 LISTRIK CONTOH 200.000,00 DB', 'SALDO AKHIR 5.775.000,00']) }
	]);
	const bomb300 = await deflateStream(300 * MiB, PREFIX);
	const form = textContent(
		Array.from({ length: 40 }, (_, i) => `Baris fiktif nomor ${i} xxxxxxxxxx`)
	);
	const runLength = new Uint8Array(700_000 * 2 + 1);
	for (let i = 0; i < 700_000; i++) runLength.set([129, 0x20], i * 2);
	runLength[runLength.length - 1] = 128;
	return [
		{ name: 'honest 3-page statement', pdf: statement, expect: 'ok' },
		{
			name: 'honest, password-protected',
			pdf: buildPdf([{ content: textContent(['PT Contoh Fiktif satu dua']) }], {
				password: 'sandi'
			}),
			password: 'sandi',
			expect: 'ok'
		},
		{
			name: 'honest, JPEG logo 60000×60000',
			pdf: buildPdf([{ content: textContent(['PT Contoh Fiktif satu dua']), image: true }], {
				jpegImage: true
			}),
			expect: 'ok'
		},
		{
			name: 'Flate ≈ 30 MB (cycle 2 N1)',
			pdf: buildPdf([raw('/Filter /FlateDecode', await deflateStream(30 * MiB, PREFIX))]),
			expect: 'too_complex'
		},
		{
			name: '46 KB → 45 MiB (QA)',
			pdf: buildPdf([raw('/Filter /FlateDecode', await deflateStream(45 * MiB, PREFIX))]),
			expect: 'too_complex'
		},
		{
			name: '/Flate#44ecode 300 MB (H1.1)',
			pdf: buildPdf([raw('/Filter /Flate#44ecode', bomb300)]),
			expect: 'too_complex'
		},
		{
			name: 'comment before stream 300 MB (H1.2)',
			pdf: buildPdf([raw('/Filter /FlateDecode', bomb300, '\n%c\n')]),
			expect: 'too_complex'
		},
		{
			name: 'nested DecodeParms first 300 MB (H1.3)',
			pdf: buildPdf([raw('/DecodeParms << /Filter /None >> /Filter /FlateDecode', bomb300)]),
			expect: 'too_complex'
		},
		{
			name: '/Filter > 4 KiB before stream 300 MB (H1.4)',
			pdf: buildPdf([raw(`/Filter /FlateDecode /Pad (${'x'.repeat(5000)})`, bomb300)]),
			expect: 'too_complex'
		},
		{
			name: 'RC4 empty password 300 MB (H2)',
			pdf: buildPdf([raw('/Filter /FlateDecode', bomb300)], { password: '' }),
			expect: 'too_complex'
		},
		{
			name: 'Brotli 64 MB (N1)',
			pdf: buildPdf([raw('/Filter /BrotliDecode', brotliBomb())]),
			expect: 'too_complex'
		},
		{
			name: 'LZW content stream',
			pdf: buildPdf([raw('/Filter /LZWDecode', new Uint8Array(2048).fill(0x80))]),
			expect: 'too_complex'
		},
		{
			name: 'RunLength#44 ≈ 90 MB',
			pdf: buildPdf([raw('/Filter /RunLength#44ecode', runLength)]),
			expect: 'too_complex'
		},
		{
			name: '/Contents 50 refs × 30 MB (N1)',
			pdf: buildPdf([
				{ ...raw('/Filter /FlateDecode', await deflateStream(30 * MiB, PREFIX)), contentsRefs: 50 }
			]),
			expect: 'too_complex'
		},
		{
			name: 'Form XObject × 60,000 (M1)',
			pdf: buildPdf([{ content: '/X1 Do '.repeat(60_000), flate: true }], { form }),
			expect: 'too_complex'
		},
		{
			name: 'Form XObject × 300,000 (M1 re-check)',
			pdf: buildPdf([{ content: '/X1 Do '.repeat(300_000), flate: true }], { form }),
			expect: 'too_complex'
		}
	];
}

const ENTRY = `
import { extractPdfText } from ${JSON.stringify(new URL('../src/lib/server/statements/pdf-text.ts', import.meta.url).pathname)};
export default {
	async fetch(request) {
		const url = new URL(request.url);
		const r = await extractPdfText(new Uint8Array(await request.arrayBuffer()), { password: url.searchParams.get('pw') });
		return Response.json(r.ok ? { verdict: 'ok', pages: r.pages.length } : { verdict: r.reason });
	}
};`;

async function bundle(dir: string): Promise<void> {
	writeFileSync(join(dir, 'entry.mjs'), ENTRY);
	await build({
		entryPoints: [join(dir, 'entry.mjs')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		mainFields: ['module', 'main'],
		conditions: ['workerd', 'worker', 'import'],
		outfile: join(dir, 'worker.mjs'),
		logLevel: 'error',
		plugins: [
			{
				name: 'pdfjs-bounded',
				setup(b) {
					b.onLoad({ filter: PDFJS_MODULE }, (a) => ({
						contents: patchPdfjs(readFileSync(a.path, 'utf8')),
						loader: 'js'
					}));
				}
			}
		]
	});
}

function config(port: number): string {
	return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .w)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
);
const w :Workerd.Worker = (
  modules = [(name = "worker", esModule = embed "worker.mjs")],
  compatibilityDate = "2026-10-01",
  compatibilityFlags = ["nodejs_als"]
);`;
}

const vmHwmMiB = (pid: number) => {
	const line = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmHWM:\s+(\d+) kB/);
	return line ? Number(line[1]) / 1024 : NaN;
};

async function post(port: number, pdf: Uint8Array, password?: string) {
	const res = await fetch(`http://127.0.0.1:${port}/${password ? `?pw=${password}` : ''}`, {
		method: 'POST',
		body: pdf as BodyInit
	});
	return ((await res.json()) as { verdict: string }).verdict;
}

async function runOne(dir: string, port: number, c: Case) {
	const workerd = createRequire(import.meta.url).resolve(
		'@cloudflare/workerd-linux-64/bin/workerd'
	);
	const child: ChildProcess = spawn(workerd, ['serve', join(dir, 'config.capnp')], {
		stdio: 'ignore'
	});
	try {
		for (let i = 0; ; i++) {
			try {
				await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: new Uint8Array() });
				break;
			} catch {
				if (i > 100) throw new Error('workerd did not start');
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		await post(port, buildPdf([{ content: textContent(['Pemanasan contoh fiktif satu']) }]));
		const base = vmHwmMiB(child.pid!);
		const started = Date.now();
		const verdict = await post(port, c.pdf, c.password);
		const growth = vmHwmMiB(child.pid!) - base;
		return { verdict, base, growth, ms: Date.now() - started };
	} finally {
		child.kill('SIGKILL');
	}
}

export async function main(): Promise<number> {
	const dir = mkdtempSync(join(tmpdir(), 'fin-pdf-workerd-'));
	try {
		await bundle(dir);
		const port = 18_000 + Math.floor(Math.random() * 1000);
		writeFileSync(join(dir, 'config.capnp'), config(port));
		let failures = 0;
		console.log('| File (fictional) | Size | Verdict | Baseline RSS | Peak growth | Time |');
		console.log('| - | - | - | - | - | - |');
		for (const c of await cases()) {
			const r = await runOne(dir, port, c);
			const pass = r.verdict === c.expect && r.growth < GROWTH_LIMIT_MIB;
			if (!pass) failures++;
			console.log(
				`| ${c.name} | ${(c.pdf.byteLength / 1024).toFixed(1)} KB | ${r.verdict}${pass ? '' : ` ✗ (want ${c.expect})`} | ${r.base.toFixed(0)} MiB | ${r.growth.toFixed(1)} MiB | ${r.ms} ms |`
			);
		}
		console.log(
			failures === 0 ? 'pdf-bound-workerd: all passed' : `pdf-bound-workerd: ${failures} failed`
		);
		return failures === 0 ? 0 : 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (import.meta.main) process.exit(await main());
