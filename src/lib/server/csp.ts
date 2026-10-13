/**
 * The one Content-Security-Policy. SvelteKit applies it to every rendered response (`csp` in vite.config.ts,
 * adding nonces or hashes); the prerendered site pages (FN-32), which the Worker serves without SvelteKit, get
 * the same directives from cspHeader(). Never `'unsafe-inline'`.
 */
import type { Config } from '@sveltejs/kit/vite';

type Directives = NonNullable<NonNullable<Config['csp']>['directives']>;

export const CSP_DIRECTIVES: Directives = {
	'default-src': ['self'],
	'script-src': ['self'],
	'style-src': ['self'],
	// SvelteKit's own route announcer carries one fixed inline style attribute; allow exactly that hash.
	'style-src-attr': ['unsafe-hashes', 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='],
	'img-src': ['self', 'data:'],
	'font-src': ['self'],
	'connect-src': ['self'],
	// FN-16g: workers only from this origin, never `blob:` (tesseract.js runs with `workerBlobURL: false`). This
	// is already the fallback through script-src; written out so a later loosening has to be explicit.
	'worker-src': ['self'],
	'object-src': ['none'],
	'base-uri': ['none'],
	'frame-ancestors': ['none'],
	'form-action': ['self']
};

/** Keywords and hash sources are quoted in the header; schemes such as `data:` are not (as SvelteKit writes them). */
function source(value: string): string {
	return /^(self|none|unsafe-hashes|unsafe-eval|wasm-unsafe-eval|strict-dynamic|sha(256|384|512)-.+)$/.test(
		value
	)
		? `'${value}'`
		: value;
}

export function cspHeader(): string {
	return Object.entries(CSP_DIRECTIVES)
		.map(([name, values]) => `${name} ${(values as string[]).map(source).join(' ')}`)
		.join('; ');
}

/**
 * The policy of the on-device OCR engine's own files under `/_ocr/` (FN-16g). A dedicated Web Worker runs under
 * the CSP of its script response, not the page's, so WebAssembly compilation is allowed there and only there:
 * pages keep `script-src 'self'` without `'wasm-unsafe-eval'`. The workers import the engine core and fetch
 * language data and pdf.js decoders from this origin only, and start no workers of their own. Attached by the
 * root `_headers` file (Workers Assets serves these files without running the Worker); a test keeps the two
 * identical.
 */
export const OCR_ASSET_DIRECTIVES = {
	'default-src': ['none'],
	'script-src': ['self', 'wasm-unsafe-eval'],
	'connect-src': ['self'],
	'worker-src': ['none'],
	'base-uri': ['none']
} as const;

export function ocrAssetCsp(): string {
	return Object.entries(OCR_ASSET_DIRECTIVES)
		.map(([name, values]) => `${name} ${(values as readonly string[]).map(source).join(' ')}`)
		.join('; ');
}
