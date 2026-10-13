/**
 * Text of an uploaded PDF statement (FN-16a), read in memory in the app Worker and never stored or logged.
 * Uses unpdf's Workers-targeted PDF.js build (`unpdf/pdfjs`, https://github.com/unjs/unpdf#readme), loaded on
 * first use so the 1.6 MB bundle is not evaluated at Worker startup (1 s startup limit,
 * https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time).
 *
 * Untrusted input (unpdf README › "Processing Untrusted PDFs"; red team cycle 1 H1/H2/M1):
 * - inside PDF.js itself (scripts/pdfjs-bounded.ts): only Flate, ASCIIHex, ASCII85, RunLength and unfiltered
 *   streams are decoded (any other filter outside an image refuses the document); Flate never takes the native
 *   `DecompressionStream` path; every decoded byte is charged before allocation against a per-page and a
 *   per-document cap (repeated references count each time); a page may reference at most
 *   PDF_MAX_CONTENT_REFS content streams; image codecs never run;
 * - text is streamed and the character, item and time caps are checked per chunk, not per page;
 * - pages are capped before extraction; the loading task is destroyed on every exit, timeouts included;
 * - one read at a time per isolate (a budget always belongs to exactly one document), with a bounded wait; the
 *   route reserves a place (`reservePdfRead`) before reading the request body: one upload per user, and the
 *   bytes the isolate's uploads hold are charged as they arrive against PDF_READ_BUFFER_BYTES (red team L4: a
 *   slow uploader holds only what it has sent, never a whole slot).
 */
import { hasReadableText } from '../../shared/statements/text-layer.ts';
import type { PageLayout } from '../../shared/statements/types.ts';

/** Most pages one request reads (owner decision B); the rest are reported as not processed. */
export const PDF_MAX_PAGES = 200;
/** Most bytes PDF.js's decoders may produce for one file, decryption included (owner decision B). */
export const PDF_MAX_DECODED_BYTES = 40 * 1024 * 1024;
/** Most decoded bytes for one page (its content streams, fonts and forms; loading counts as page 0). */
export const PDF_MAX_PAGE_DECODED_BYTES = 8 * 1024 * 1024;
/** Most content streams one page's `/Contents` array may reference. */
export const PDF_MAX_CONTENT_REFS = 64;
/** Most characters of text kept from the whole file (a 200-page statement is far below). */
export const PDF_MAX_TEXT_CHARS = 1_000_000;
/** Most text items (runs) read from the whole file; empty runs count too. */
export const PDF_MAX_TEXT_ITEMS = 100_000;
/**
 * Request-body bytes the isolate's statement uploads may hold at once (reading, waiting or parsing): what three
 * full 15 MB uploads held under the earlier three-slot lane (red team N2), now charged as bytes arrive (L4).
 */
export const PDF_READ_BUFFER_BYTES = 3 * (15 * 1024 * 1024 + 64 * 1024);
/** Longest wait for this isolate's PDF reader before answering "busy". */
export const PDF_READ_WAIT_MS = 10_000;
/** Longest wait for PDF.js to release a document. */
const DESTROY_TIMEOUT_MS = 2_000;
/** Wall-clock budget of one extraction (checked per text chunk and raced at every await). */
export const PDF_READ_TIMEOUT_MS = 15_000;
/** Longest PDF password accepted (used once for this read, never stored or logged). */
export const PDF_PASSWORD_MAX_LENGTH = 128;
/** Largest declared image PDF.js decodes (pixels); text extraction never needs image data. */
const MAX_IMAGE_PIXELS = 1;

export type PdfTextFailure =
	/** Password-protected and no password was given. */
	| 'encrypted'
	/** The given password does not open the file. */
	| 'wrong_password'
	/** Not a readable PDF (truncated, broken cross-reference table, garbage). */
	| 'corrupt'
	/** Decodes past the cap, too much text, or slower than the deadline. */
	| 'too_complex'
	/** No page carries readable text: a scanned or image-only PDF (needs FN-16's AI read). */
	| 'no_text'
	/** This isolate's PDF reader stayed busy past PDF_READ_WAIT_MS. */
	| 'reader_busy';

export type PdfTextResult =
	| {
			ok: true;
			/** Text of each read page, in order (at most PDF_MAX_PAGES). */
			pages: string[];
			/** Each read page's width and the left edge of each of its text lines (PDF user-space units). */
			layout: PageLayout[];
			/** Pages the file declares. */
			totalPages: number;
			/** Declared pages past PDF_MAX_PAGES, not read. */
			pagesNotProcessed: number;
	  }
	| { ok: false; reason: PdfTextFailure };

export interface PdfLimits {
	maxPages: number;
	maxDecodedBytes: number;
	maxPageDecodedBytes: number;
	maxContentRefs: number;
	maxTextChars: number;
	maxTextItems: number;
	timeoutMs: number;
	/** Longest wait for this isolate's reader before `reader_busy`. */
	waitMs: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = {
	maxPages: PDF_MAX_PAGES,
	maxDecodedBytes: PDF_MAX_DECODED_BYTES,
	maxPageDecodedBytes: PDF_MAX_PAGE_DECODED_BYTES,
	maxContentRefs: PDF_MAX_CONTENT_REFS,
	maxTextChars: PDF_MAX_TEXT_CHARS,
	maxTextItems: PDF_MAX_TEXT_ITEMS,
	timeoutMs: PDF_READ_TIMEOUT_MS,
	waitMs: PDF_READ_WAIT_MS
};

/** The decode budget the patched PDF.js charges (scripts/pdfjs-bounded.ts). */
interface DecodeBudget {
	used: number;
	cap: number;
	page: number;
	pageCap: number;
	maxContentRefs: number;
}
type BoundedPdfjs = typeof import('unpdf/pdfjs') & {
	montraDecodeBudget?: (budget: DecodeBudget | null) => void;
};

/** Whether the bytes start like a PDF (`%PDF-` within the first 1024 bytes, as PDF.js accepts). */
export function looksLikePdf(bytes: Uint8Array): boolean {
	const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
	return head.includes('%PDF-');
}

export { hasReadableText };

class Timeout extends Error {}
class TooComplex extends Error {}

/** PDF.js's password errors carry `name: 'PasswordException'` and code 1 (needed) or 2 (incorrect). */
function failureOf(e: unknown): PdfTextFailure {
	if (e instanceof Timeout || e instanceof TooComplex) return 'too_complex';
	const err = e as { name?: unknown; code?: unknown } | null;
	if (err && err.name === 'PasswordException')
		return err.code === 2 ? 'wrong_password' : 'encrypted';
	return 'corrupt';
}

interface TextItem {
	str?: string;
	hasEOL?: boolean;
	/** PDF.js's text matrix: `transform[4]` is the item's x. */
	transform?: number[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The left edge of each line of a page's text as it is built from text items: the x of the line's first item
 * with visible text (null when none), one entry per `text.split('\n')` line (FN-16f/16h red team L1).
 */
export class LineStarts {
	private readonly xs: (number | null)[] = [];
	private current: number | null = null;

	add(piece: string, x: number | undefined) {
		const parts = piece.split('\n');
		parts.forEach((part, i) => {
			if (i > 0) {
				this.xs.push(this.current);
				this.current = null;
			}
			if (this.current === null && part.trim() !== '' && Number.isFinite(x)) this.current = x!;
		});
	}

	done(): (number | null)[] {
		return [...this.xs, this.current];
	}
}

/** Users with a statement upload in this isolate (reading its body, waiting, or being parsed). */
const lane = new Set<string>();
/** Bytes those uploads hold, charged by `PdfReadPlace.charge`. */
let buffered = 0;

/** A user's place in the statement lane: charge body bytes as they are buffered, release once on every exit. */
export interface PdfReadPlace {
	/** Charges `bytes` more against PDF_READ_BUFFER_BYTES; false (nothing charged) when they do not fit. */
	charge(bytes: number): boolean;
	/** Gives the place and every charged byte back; a second call does nothing. */
	release(): void;
}

/**
 * A place in this isolate's statement lane, taken before the request body is read (red team N2): null when the
 * user already has an upload in flight. The body's bytes are charged as they arrive (red team L4), so uploads
 * that trickle bytes hold almost nothing and other users' uploads still fit.
 */
export function reservePdfRead(userId: string): PdfReadPlace | null {
	if (lane.has(userId)) return null;
	lane.add(userId);
	let held = 0;
	let released = false;
	return {
		charge(bytes) {
			if (released || buffered + bytes > PDF_READ_BUFFER_BYTES) return false;
			buffered += bytes;
			held += bytes;
			return true;
		},
		release() {
			if (released) return;
			released = true;
			lane.delete(userId);
			buffered -= held;
			held = 0;
		}
	};
}

/** The tail of the per-isolate queue: one PDF read at a time; it never rejects. */
let queue: Promise<void> = Promise.resolve();

/** Runs `work` once every earlier read has finished, or answers `busy` after `waitMs` without running it. */
async function exclusive(
	work: () => Promise<PdfTextResult>,
	waitMs: number
): Promise<PdfTextResult> {
	const before = queue;
	const enqueuedAt = Date.now();
	let done!: () => void;
	const mine = new Promise<void>((resolve) => (done = resolve));
	queue = before.then(() => mine);
	const turn = await Promise.race([before.then(() => true), sleep(waitMs).then(() => false)]);
	// A busy event loop can hold the timer back; a turn that came too late is answered "busy" all the same.
	if (!turn || Date.now() - enqueuedAt > waitMs) {
		// Give the place back once the reads ahead of it are done, so the queue keeps moving.
		void before.then(done);
		return { ok: false, reason: 'reader_busy' };
	}
	try {
		return await work();
	} finally {
		done();
	}
}

/**
 * The text of each page (at most `limits.maxPages`), or why it cannot be read. Never throws: a malformed,
 * truncated, oversized, password-protected or image-only PDF answers a typed reason. `password` (if any) is
 * passed to PDF.js for this read only. Takes ownership of `bytes`: PDF.js receives the buffer itself (no copy)
 * and may detach it.
 */
export async function extractPdfText(
	bytes: Uint8Array,
	options: { password?: string | null } = {},
	limits: PdfLimits = DEFAULT_PDF_LIMITS
): Promise<PdfTextResult> {
	if (!looksLikePdf(bytes)) return { ok: false, reason: 'corrupt' };
	return exclusive(() => read(bytes, options.password ?? null, limits), limits.waitMs);
}

async function read(
	bytes: Uint8Array,
	password: string | null,
	limits: PdfLimits
): Promise<PdfTextResult> {
	const pdfjs = (await import('unpdf/pdfjs')) as BoundedPdfjs;
	// Fail closed: a PDF.js build without the decode budget never reads an upload.
	if (typeof pdfjs.montraDecodeBudget !== 'function') return { ok: false, reason: 'too_complex' };
	const budget: DecodeBudget = {
		used: 0,
		cap: limits.maxDecodedBytes,
		page: 0,
		pageCap: limits.maxPageDecodedBytes,
		maxContentRefs: limits.maxContentRefs
	};
	const overBudget = () => budget.used > budget.cap || budget.page > budget.pageCap;
	const startedAt = Date.now();
	const check = (chars: number, items: number) => {
		if (
			overBudget() ||
			chars > limits.maxTextChars ||
			items > limits.maxTextItems ||
			Date.now() - startedAt >= limits.timeoutMs
		)
			throw new TooComplex();
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Timeout()), limits.timeoutMs);
	});
	deadline.catch(() => {});
	const race = <T>(p: Promise<T>) => Promise.race([p, deadline]);

	pdfjs.montraDecodeBudget(budget);
	const task = pdfjs.getDocument({
		data: bytes,
		password: password || undefined,
		maxImageSize: MAX_IMAGE_PIXELS,
		disableFontFace: true,
		useSystemFonts: false,
		isOffscreenCanvasSupported: false,
		stopAtErrors: false,
		verbosity: 0
	});
	task.promise.catch(() => {});
	try {
		const doc = await race(task.promise);
		check(0, 0);
		const totalPages = doc.numPages;
		const pageCount = Math.min(totalPages, limits.maxPages);
		const pages: string[] = [];
		const layout: PageLayout[] = [];
		let chars = 0;
		let items = 0;
		for (let n = 1; n <= pageCount; n++) {
			check(chars, items);
			budget.page = 0;
			const page = await race(doc.getPage(n));
			const reader = page.streamTextContent().getReader();
			let text = '';
			const lines = new LineStarts();
			// A cap firing mid-stream throws out of this loop; `task.destroy()` below then stops PDF.js's
			// evaluation of the page (cancelling the reader instead races PDF.js's own enqueue).
			for (;;) {
				const { done, value } = await race(reader.read());
				if (done) break;
				for (const item of (value as { items: TextItem[] }).items) {
					items++;
					if (typeof item.str !== 'string') continue;
					const piece = item.str + (item.hasEOL ? '\n' : '');
					chars += piece.length;
					if (chars > limits.maxTextChars) break;
					text += piece;
					lines.add(piece, item.transform?.[4]);
				}
				check(chars, items);
			}
			const [x0 = 0, , x1 = 0] = (page as { view?: number[] }).view ?? [];
			page.cleanup();
			pages.push(text);
			layout.push({ width: x1 - x0, lineX: lines.done() });
		}
		check(chars, items);
		if (!pages.some(hasReadableText)) return { ok: false, reason: 'no_text' };
		return { ok: true, pages, layout, totalPages, pagesNotProcessed: totalPages - pageCount };
	} catch (e) {
		return { ok: false, reason: overBudget() ? 'too_complex' : failureOf(e) };
	} finally {
		clearTimeout(timer);
		// Always, timeouts included (red team L1): stops any parsing still running for this document.
		await Promise.race([task.destroy().catch(() => {}), sleep(DESTROY_TIMEOUT_MS)]);
		pdfjs.montraDecodeBudget(null);
	}
}
