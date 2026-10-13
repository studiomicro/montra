import { describe, expect, it } from 'vitest';
import {
	deflateStream,
	buildPdf,
	positionedContent,
	textContent,
	type PdfPage
} from '../../../../test/helpers/pdf';
import {
	DEFAULT_PDF_LIMITS,
	extractPdfText,
	LineStarts,
	PDF_MAX_CONTENT_REFS,
	PDF_READ_BUFFER_BYTES,
	reservePdfRead,
	hasReadableText,
	looksLikePdf,
	PDF_MAX_DECODED_BYTES,
	PDF_MAX_PAGES,
	type PdfLimits
} from './pdf-text';

// Every PDF here is built in test code from invented text (test/helpers/pdf.ts); none is a real statement.
// extractPdfText takes ownership of its bytes (PDF.js may detach the buffer), so each call gets a fresh copy.
const LINES = ['PT Contoh Fiktif', 'Mutasi rekening 1234 5678 9012', 'Saldo awal 1.000.000'];
const textPage = (lines: string[] = LINES): PdfPage => ({ content: textContent(lines) });
const read = (pdf: Uint8Array, options: { password?: string | null } = {}, limits?: PdfLimits) =>
	extractPdfText(pdf.slice(), options, limits);
const limits = (over: Partial<PdfLimits>): PdfLimits => ({ ...DEFAULT_PDF_LIMITS, ...over });
const MiB = 1024 * 1024;
const TOO_COMPLEX = { ok: false, reason: 'too_complex' };

/** Peak growth of heap + ArrayBuffers while `work` runs (sampled every millisecond, as the red team did). */
async function peakGrowth<T>(work: () => Promise<T>): Promise<{ result: T; peakMiB: number }> {
	const used = () => {
		const m = process.memoryUsage();
		return m.heapUsed + m.arrayBuffers;
	};
	globalThis.gc?.();
	const base = used();
	let peak = base;
	const timer = setInterval(() => (peak = Math.max(peak, used())), 1);
	try {
		const result = await work();
		peak = Math.max(peak, used());
		return { result, peakMiB: Math.round((peak - base) / MiB) };
	} finally {
		clearInterval(timer);
	}
}

describe('extractPdfText', () => {
	it('reads every page of a multi-page text PDF in order (plain and Flate content)', async () => {
		const pdf = buildPdf([
			textPage(),
			{ content: textContent(['Halaman dua contoh fiktif']), flate: true },
			textPage(['Halaman tiga contoh fiktif'])
		]);
		const r = await read(pdf);
		expect(r).toMatchObject({ ok: true, totalPages: 3, pagesNotProcessed: 0 });
		if (!r.ok) return;
		expect(r.pages[0]).toContain('PT Contoh Fiktif');
		expect(r.pages[1]).toContain('Halaman dua');
		expect(r.pages[2]).toContain('Halaman tiga');
		expect(looksLikePdf(pdf)).toBe(true);
	});

	it('gives each page’s width and where each text line starts (FN-16f/16h red team L1)', async () => {
		const placed = [
			{ text: '02-Jul-2026 02-Jul-2026 Transfer', x: 30 },
			{ text: 'Catatan pengirim fiktif', x: 150 },
			{ text: '0.00 10.00 1,000,010.00', x: 400 }
		];
		const r = await read(buildPdf([{ content: positionedContent(placed) }]));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const lines = r.pages[0]!.split('\n');
		expect(r.layout[0]!.lineX).toHaveLength(lines.length);
		expect(r.layout[0]!.width).toBeGreaterThan(500);
		const xOf = (text: string) => r.layout[0]!.lineX[lines.findIndex((l) => l.includes(text))];
		expect(xOf('Transfer')).toBeCloseTo(30);
		expect(xOf('Catatan')).toBeCloseTo(150);
		expect(xOf('1,000,010.00')).toBeCloseTo(400);
	});

	it('LineStarts keeps one entry per text line, from the first visible piece', () => {
		const lines = new LineStarts();
		lines.add(' ', 5);
		lines.add('A', 10);
		lines.add('B\n', 20);
		lines.add('\n', 30);
		lines.add('C\nD', 40);
		expect(lines.done()).toEqual([10, null, 40, 40]);
	});

	it('hands its buffer to PDF.js without a copy (red team L2)', async () => {
		const pdf = buildPdf([textPage()]);
		await extractPdfText(pdf);
		expect(pdf.byteLength).toBe(0);
	});

	it('password-protected: refused without a password, refused with a wrong one, read with the right one', async () => {
		const pdf = buildPdf([textPage()], { password: 'sandi-fiktif' });
		expect(await read(pdf)).toEqual({ ok: false, reason: 'encrypted' });
		expect(await read(pdf, { password: 'salah' })).toEqual({ ok: false, reason: 'wrong_password' });
		const r = await read(pdf, { password: 'sandi-fiktif' });
		expect(r.ok && r.pages[0]).toContain('PT Contoh Fiktif');
	});

	it('an image-only (scanned) PDF is no_text, never an empty success', async () => {
		const scanned = buildPdf([
			{ content: '', image: true },
			{ content: '', image: true }
		]);
		expect(await read(scanned)).toEqual({ ok: false, reason: 'no_text' });
		const nearlyEmpty = buildPdf([{ content: textContent(['1']), image: true }]);
		expect(await read(nearlyEmpty)).toEqual({ ok: false, reason: 'no_text' });
	});

	it('a page with a huge JPEG logo still reads: the image is never decoded', async () => {
		const pdf = buildPdf([{ content: textContent(LINES), image: true }], { jpegImage: true });
		const r = await read(pdf);
		expect(r.ok && r.pages[0]).toContain('PT Contoh Fiktif');
	});

	it(`stops at ${PDF_MAX_PAGES} pages and reports the rest as not processed`, async () => {
		const pdf = buildPdf([textPage()], { repeatPages: PDF_MAX_PAGES + 5 });
		const r = await read(pdf);
		expect(r).toMatchObject({ ok: true, totalPages: PDF_MAX_PAGES + 5, pagesNotProcessed: 5 });
		expect(r.ok && r.pages).toHaveLength(PDF_MAX_PAGES);
	});

	it('malformed input is a typed refusal, never a throw', async () => {
		const good = buildPdf([textPage(), textPage(['Halaman dua contoh fiktif'])]);
		const cases: Uint8Array[] = [
			new TextEncoder().encode('%PDF-1.4\nthis is not a pdf at all\n%%EOF'),
			new TextEncoder().encode('%PDF-'),
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			good.subarray(0, Math.floor(good.length / 2)),
			good.subarray(0, 40),
			Uint8Array.from(
				new TextDecoder('latin1').decode(good).replace(/\d{10} 00000 n/g, '9999999999 00000 n'),
				(c) => c.charCodeAt(0)
			)
		];
		for (const bytes of cases) {
			const r = await read(bytes);
			// PDF.js recovers some damage by scanning objects: then the readable pages come back.
			if (r.ok) expect(r.pages.join('\n')).toContain('Contoh Fiktif');
			else expect(['corrupt', 'no_text']).toContain(r.reason);
		}
		expect(await read(cases[2]!)).toEqual({ ok: false, reason: 'corrupt' });
	});

	it('a read past its deadline is too_complex, and the next read works (loading task destroyed, L1)', async () => {
		const pdf = buildPdf([textPage(), textPage()]);
		expect(await read(pdf, {}, limits({ timeoutMs: 0 }))).toEqual(TOO_COMPLEX);
		expect(await read(pdf)).toMatchObject({ ok: true });
	});

	it('text and item caps fire mid-page, not after it', async () => {
		const pdf = buildPdf([textPage(), textPage()]);
		expect(await read(pdf, {}, limits({ maxTextChars: 10 }))).toEqual(TOO_COMPLEX);
		expect(await read(pdf, {}, limits({ maxTextItems: 2 }))).toEqual(TOO_COMPLEX);
	});

	it('a read that waits past its limit answers reader_busy and the queue keeps moving (N2)', async () => {
		const slow = buildPdf([{ content: '/X1 Do '.repeat(20_000), flate: true }], {
			form: textContent(Array.from({ length: 40 }, (_, i) => `Baris fiktif ${i} xxxxxxxxxxxxxxxx`))
		});
		const first = read(slow);
		const second = read(buildPdf([textPage()]), {}, limits({ waitMs: 1 }));
		expect(await second).toEqual({ ok: false, reason: 'reader_busy' });
		await first;
		expect(await read(buildPdf([textPage()]))).toMatchObject({ ok: true });
	});

	it('the statement lane holds one upload per user; bytes, not slots, bound the isolate (N2, L4)', () => {
		// Slow uploaders that have sent little hold little: any number of other users still get a place.
		const slow = Array.from({ length: 10 }, (_, i) => reservePdfRead(`langsat${i}`)!);
		expect(slow.every((p) => p.charge(64 * 1024))).toBe(true);
		expect(reservePdfRead('langsat0')).toBeNull();
		const other = reservePdfRead('lain')!;
		expect(other.charge(PDF_READ_BUFFER_BYTES - 10 * 64 * 1024)).toBe(true);
		// The budget is full: one more byte is refused and nothing is charged for it.
		expect(other.charge(1)).toBe(false);
		expect(slow[1]!.charge(1)).toBe(false);
		// Released bytes come back, once.
		other.release();
		other.release();
		expect(other.charge(1)).toBe(false);
		expect(slow[1]!.charge(1024)).toBe(true);
		slow.forEach((p) => p.release());
		const solo = reservePdfRead('langsat0')!;
		expect(solo.charge(PDF_READ_BUFFER_BYTES)).toBe(true);
		solo.release();
	});

	it('concurrent reads are serialised and each gets its own budget', async () => {
		const pdf = buildPdf([textPage()]);
		const results = await Promise.all(Array.from({ length: 5 }, () => read(pdf)));
		expect(results.every((r) => r.ok)).toBe(true);
	});
});

// Red team cycle 1 H1/H2 and QA criterion 13: each shape made PDF.js inflate hundreds of MB past the old regex
// pre-scan. The budget now counts inside PDF.js's decoders, so each is refused while decoding.
describe('decode budget (adversarial shapes, fictional files)', () => {
	const PREFIX = 'BT /F1 10 Tf 40 800 Td (Contoh fiktif satu dua tiga) Tj ET ';
	const bombPage = (dict: string, data: Uint8Array, gap?: string): PdfPage => ({
		content: '',
		raw: { dict, data, gap }
	});

	it('a 46 KB file inflating to 45 MiB is refused with bounded memory', async () => {
		const data = await deflateStream(45 * MiB, PREFIX);
		const pdf = buildPdf([bombPage('/Filter /FlateDecode', data)]);
		expect(pdf.byteLength).toBeLessThan(60 * 1024);
		const { result, peakMiB } = await peakGrowth(() => read(pdf));
		expect(result).toEqual(TOO_COMPLEX);
		console.info(`decode budget: 46 KB → 45 MiB bomb, peak growth ${peakMiB} MiB`);
		expect(peakMiB).toBeLessThan(128);
	});

	it('fail-before: with the budget lifted, the same 45 MiB file is decoded and read', async () => {
		const data = await deflateStream(45 * MiB, PREFIX);
		const pdf = buildPdf([bombPage('/Filter /Flate#44ecode', data)]);
		const r = await read(
			pdf,
			{},
			limits({ maxDecodedBytes: Infinity, maxPageDecodedBytes: Infinity })
		);
		expect(r.ok && r.pages[0]).toContain('Contoh fiktif');
	});

	const SHAPES: [string, string, string?][] = [
		['hex-escaped filter name', '/Filter /Flate#44ecode'],
		['comment between >> and stream', '/Filter /FlateDecode', '\n%kommentar fiktif\n'],
		['nested DecodeParms /Filter first', '/DecodeParms << /Filter /None >> /Filter /FlateDecode'],
		['/Filter more than 4 KiB before stream', `/Filter /FlateDecode /Pad (${'x'.repeat(5000)})`]
	];
	for (const [name, dict, gap] of SHAPES) {
		it(`${name}: a 300 MB stream is refused while decoding`, async () => {
			const data = await deflateStream(300 * MiB, PREFIX);
			const pdf = buildPdf([bombPage(dict, data, gap)]);
			const { result, peakMiB } = await peakGrowth(() => read(pdf));
			expect(result).toEqual(TOO_COMPLEX);
			console.info(`decode budget: ${name}, ${pdf.byteLength} B file, peak growth ${peakMiB} MiB`);
			expect(peakMiB).toBeLessThan(128);
		});
	}

	it('RC4 with an empty user password: decrypted and inflated bytes are both counted', async () => {
		const data = await deflateStream(300 * MiB, PREFIX);
		const pdf = buildPdf([bombPage('/Filter /FlateDecode', data)], { password: '' });
		const { result, peakMiB } = await peakGrowth(() => read(pdf));
		expect(result).toEqual(TOO_COMPLEX);
		console.info(
			`decode budget: empty-password RC4, ${pdf.byteLength} B, peak growth ${peakMiB} MiB`
		);
		expect(peakMiB).toBeLessThan(128);
	});

	it('a non-Flate expander (RunLength behind a name escape) is counted too', async () => {
		// 700k pairs "repeat the next byte 128 times" → about 90 MB.
		const data = new Uint8Array(700_000 * 2 + 1);
		for (let i = 0; i < 700_000; i++) data.set([129, 0x20], i * 2);
		data[data.length - 1] = 128;
		const pdf = buildPdf([bombPage('/Filter /RunLength#44ecode', data)]);
		expect(await read(pdf)).toEqual(TOO_COMPLEX);
	});

	it('an image-only filter on a content stream refuses the document without decoding it', async () => {
		const pdf = buildPdf([
			bombPage('/Filter /DCTDecode', new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
			textPage()
		]);
		expect(await read(pdf)).toEqual(TOO_COMPLEX);
	});

	for (const [name, dict] of [
		['Brotli', '/Filter /BrotliDecode'],
		['Brotli behind a name escape', '/Filter /Brotli#44ecode'],
		['LZW', '/Filter /LZWDecode'],
		['Crypt filter', '/Filter /Crypt'],
		['unknown filter', '/Filter /FiktifDecode'],
		['filter chain with LZW', '/Filter [/FlateDecode /LZWDecode]']
	] as const)
		it(`a ${name} content stream refuses the document (allowlist)`, async () => {
			const pdf = buildPdf([bombPage(dict, new Uint8Array(1100).fill(0x41)), textPage()]);
			expect(await read(pdf)).toEqual(TOO_COMPLEX);
		});

	it('a contents array of 50 references to one 30 MB stream counts 50×: refused early, memory bounded', async () => {
		const data = await deflateStream(30 * MiB, PREFIX);
		const pdf = buildPdf([
			{ content: '', raw: { dict: '/Filter /FlateDecode', data }, contentsRefs: 50 }
		]);
		const { result, peakMiB } = await peakGrowth(() => read(pdf));
		expect(result).toEqual(TOO_COMPLEX);
		console.info(`decode budget: 50 refs × 30 MB, ${pdf.byteLength} B, peak growth ${peakMiB} MiB`);
		expect(peakMiB).toBeLessThan(128);
	});

	it(`more than ${PDF_MAX_CONTENT_REFS} content references on one page refuse the document`, async () => {
		const pdf = buildPdf([{ ...textPage(), contentsRefs: PDF_MAX_CONTENT_REFS + 1 }]);
		expect(await read(pdf)).toEqual(TOO_COMPLEX);
		const ok = buildPdf([{ ...textPage(), contentsRefs: 3 }]);
		expect(await read(ok)).toMatchObject({ ok: true });
	});

	it('the per-page cap fires before the document cap', async () => {
		const data = await deflateStream(12 * MiB, PREFIX);
		const pdf = buildPdf([bombPage('/Filter /FlateDecode', data)]);
		expect(await read(pdf)).toEqual(TOO_COMPLEX);
		expect(await read(pdf, {}, limits({ maxPageDecodedBytes: 64 * MiB }))).toMatchObject({
			ok: true
		});
	});

	it('a large honest page still reads (no false refusal under the caps)', async () => {
		const data = await deflateStream(3 * MiB, PREFIX);
		const r = await read(buildPdf([bombPage('/Filter /FlateDecode', data)]));
		expect(r.ok && r.pages[0]).toContain('Contoh fiktif');
		expect(PDF_MAX_DECODED_BYTES).toBe(40 * MiB);
	});

	it('red team M1: a Form XObject redrawn 60,000 times stops early (text cap per chunk)', async () => {
		const form = textContent(
			Array.from({ length: 40 }, (_, i) => `Baris fiktif nomor ${i} xxxxxxxxxx`)
		);
		const pdf = buildPdf([{ content: '/X1 Do '.repeat(60_000), flate: true }], { form });
		expect(pdf.byteLength).toBeLessThan(20 * 1024);
		const cpu = process.cpuUsage();
		const started = Date.now();
		expect(await read(pdf)).toEqual(TOO_COMPLEX);
		const cpuMs = Math.round(process.cpuUsage(cpu).user / 1000);
		console.info(`M1: Form XObject ×60000, ${Date.now() - started} ms wall, ${cpuMs} ms CPU`);
		expect(Date.now() - started).toBeLessThan(5000);
	});
});

describe('hasReadableText', () => {
	it('needs three words of two or more letters or digits', () => {
		expect(hasReadableText('Saldo awal 1.000')).toBe(true);
		expect(hasReadableText('1')).toBe(false);
		expect(hasReadableText('  \n ')).toBe(false);
		expect(hasReadableText('a b c d')).toBe(false);
	});
});
