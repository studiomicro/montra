/**
 * The decode budget and filter allowlist inside PDF.js (FN-16a; red team cycle 1 H1/H2, cycle 2 N1/N3). Applied
 * at build time to the pinned `unpdf/dist/pdfjs.mjs` (unpdf 1.8.1, PDF.js 6.1.200) by the Vite plugin below
 * (app build, dev server, Vitest) and by the compatibility harness through a Node load hook.
 *
 * While a budget is set (only during a statement read, `src/lib/server/statements/pdf-text.ts`):
 * - **Allowlist** (`Parser.makeFilter`): a content, object, font or xref stream may use only Flate, ASCIIHex,
 *   ASCII85, RunLength or no filter. An image stream (Subtype Image, or an inline image's W/Width) may also
 *   name DCT, JPX, JBIG2 or CCITT, because those are never decoded for text. Any other filter (Brotli, LZW,
 *   Crypt, unknown) poisons the budget and the read answers "too complex".
 * - **No native decompression**: `FlateStream`/`BrotliStream.isAsync` is false, so Flate runs through PDF.js's
 *   own decoder. workerd's `DecompressionStream` produces output eagerly, before any charge can stop it.
 * - **Budget** (`DecodeStream.prototype.ensureBuffer`): every decoder (Flate, ASCII85/Hex, RunLength, CCITT,
 *   Predictor, decryption, and the concatenation of a page's content streams) grows its buffer only here. Each
 *   growth is charged *before* the allocation, against a per-page cap and a per-document cap. A stream that
 *   is referenced again is decoded and charged again, so a contents array of 50 references to one stream
 *   counts 50 times.
 * - **Content references**: a page whose `/Contents` array has more than `maxContentRefs` entries poisons the
 *   budget.
 * - **Image decoders** (JPEG, JPX, JBIG2) refuse to run.
 *
 * Each anchor must match the pinned build exactly once, so a PDF.js upgrade fails the build. The plugin also
 * fails the build when `unpdf/pdfjs` no longer resolves to the patched path (N3). At runtime, `pdf-text.ts`
 * refuses every PDF when the loaded module lacks `montraDecodeBudget`.
 */

/** Module id the patch applies to. */
export const PDFJS_MODULE = /[\\/]unpdf[\\/]dist[\\/]pdfjs\.mjs$/;

/** Message of the error thrown inside PDF.js past the budget (never shown to a user). */
export const BUDGET_ERROR = 'MONTRA_PDF_DECODE_BUDGET';

/** Each anchor, what it becomes, and how often it must occur in PDF.js 6.1.200. */
const EDITS: { what: string; anchor: string; replacement: string; count: number }[] = [
	{
		what: 'DecodeStream.ensureBuffer',
		anchor:
			'ensureBuffer(e){let t=this.buffer;if(e<=t.byteLength)return t;let n=this.minBufferLength;for(;n<e;)n*=2;',
		replacement:
			'ensureBuffer(e){let t=this.buffer;if(e<=t.byteLength)return t;let n=this.minBufferLength;for(;n<e;)n*=2;__finCharge(n-t.byteLength);',
		count: 1
	},
	{
		// Kept as a second line of defence; with isAsync off below it is not reached while a budget is set.
		what: 'DecompressionStream read loop',
		anchor: 'for await(let e of n)a.push(e),o+=e.byteLength;let s=new Uint8Array(o)',
		replacement:
			'for await(let e of n){__finCharge(e.byteLength);a.push(e),o+=e.byteLength}__finCharge(o);let s=new Uint8Array(o)',
		count: 1
	},
	{
		what: 'FlateStream/BrotliStream isAsync',
		anchor: 'get isAsync(){return this.#e}',
		replacement: 'get isAsync(){return!__finBudget&&this.#e}',
		count: 2
	},
	{
		what: 'Parser.makeFilter',
		anchor: 'makeFilter(e,t,n,r,i=null){',
		replacement:
			'makeFilter(e,t,n,r,i=null){if(__finBudget&&!__finFilterOk(t,e)){__finBudget.used=1/0;return new NullStream}',
		count: 1
	},
	{
		what: 'StreamsSequenceStream constructor',
		anchor: 'StreamsSequenceStream=class extends DecodeStream{constructor(e,t=null){',
		replacement:
			'StreamsSequenceStream=class extends DecodeStream{constructor(e,t=null){if(__finBudget&&Array.isArray(e)&&e.length>__finBudget.maxContentRefs){__finBudget.used=1/0;e=[]}',
		count: 1
	}
];
const DECODE_IMAGE = /((?:async )?decodeImage\([a-z,]*\)\{)/g;
/** JpegStream, JpxStream, Jbig2Stream and the async JBIG2 variant in PDF.js 6.1.200. */
const DECODE_IMAGE_COUNT = 4;

const RUNTIME = `
var __finBudget=null;
var __finText=new Set(["Fl","FlateDecode","AHx","ASCIIHexDecode","A85","ASCII85Decode","RL","RunLengthDecode"]);
var __finImage=new Set(["DCT","DCTDecode","JPX","JPXDecode","JBIG2Decode","CCF","CCITTFaxDecode"]);
function __finFilterOk(t,e){if(__finText.has(t))return!0;if(!__finImage.has(t))return!1;let d=e&&e.dict;if(!d||typeof d.get!=="function")return!1;let s=d.get("Subtype");return s&&s.name==="Image"||typeof d.has==="function"&&(d.has("W")||d.has("Width"))}
function __finCharge(n){let b=__finBudget;if(b&&((b.used+=n)>b.cap||(b.page+=n)>b.pageCap))throw new Error(${JSON.stringify(BUDGET_ERROR)})}
function __finNoImage(){if(__finBudget)throw new Error(${JSON.stringify(BUDGET_ERROR)})}
export function montraDecodeBudget(budget){__finBudget=budget}
`;

/** The pinned PDF.js source with the budget and allowlist wired in. Throws when an anchor does not match. */
export function patchPdfjs(code: string): string {
	let out = code;
	for (const edit of EDITS) {
		const found = out.split(edit.anchor).length - 1;
		if (found !== edit.count)
			throw new Error(
				`pdfjs-bounded: ${edit.what} anchor found ${found} times, expected ${edit.count}`
			);
		out = out.split(edit.anchor).join(edit.replacement);
	}
	const images = out.match(DECODE_IMAGE)?.length ?? 0;
	if (images !== DECODE_IMAGE_COUNT)
		throw new Error(
			`pdfjs-bounded: expected ${DECODE_IMAGE_COUNT} decodeImage methods, found ${images}`
		);
	return out.replace(DECODE_IMAGE, '$1__finNoImage();') + RUNTIME;
}

/** Vite plugin (app build, dev server and Vitest): patches the pinned PDF.js build as it is bundled. */
export function pdfjsBounded() {
	return {
		name: 'montra-pdfjs-bounded',
		enforce: 'pre' as const,
		/** N3: a moved PDF.js module is a build failure, not a silently unpatched read. */
		async buildStart(this: {
			resolve(id: string, importer?: string): Promise<{ id: string } | null>;
			error(message: string): never;
		}) {
			const resolved = await this.resolve('unpdf/pdfjs', import.meta.filename);
			if (!resolved || !PDFJS_MODULE.test(resolved.id.split('?')[0]!))
				this.error(
					`pdfjs-bounded: unpdf/pdfjs resolves to ${resolved?.id ?? 'nothing'}, not dist/pdfjs.mjs — the decode budget would not apply`
				);
		},
		transform(code: string, id: string) {
			return PDFJS_MODULE.test(id.split('?')[0]!) ? { code: patchPdfjs(code), map: null } : null;
		}
	};
}
