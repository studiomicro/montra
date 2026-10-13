import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP_DIRECTIVES, cspHeader, ocrAssetCsp } from './csp';

describe('cspHeader (prerendered site pages, FN-32)', () => {
	const header = cspHeader();
	const parsed = new Map(
		header.split('; ').map((d) => {
			const [name, ...values] = d.split(' ');
			return [name as string, values];
		})
	);

	it('carries every directive SvelteKit applies to rendered pages, frame-ancestors included', () => {
		expect([...parsed.keys()]).toEqual(Object.keys(CSP_DIRECTIVES));
		expect(parsed.get('frame-ancestors')).toEqual(["'none'"]);
		expect(parsed.get('script-src')).toEqual(["'self'"]);
		expect(parsed.get('style-src')).toEqual(["'self'"]);
		expect(parsed.get('img-src')).toEqual(["'self'", 'data:']);
		expect(parsed.get('object-src')).toEqual(["'none'"]);
	});

	it('quotes keywords and hashes, never schemes, and never allows unsafe-inline', () => {
		expect(parsed.get('style-src-attr')).toEqual([
			"'unsafe-hashes'",
			"'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='"
		]);
		expect(header).not.toContain('unsafe-inline');
	});

	it('is the same policy vite.config.ts hands to SvelteKit (one source)', () => {
		const config = readFileSync('vite.config.ts', 'utf8');
		expect(config).toContain('directives: CSP_DIRECTIVES');
		expect(config).not.toMatch(/'script-src'/);
	});
});

describe('on-device OCR policies (FN-16g, criteria 7 and 8)', () => {
	const page = cspHeader();

	it('pages get worker-src self and nothing that loosens script execution', () => {
		expect(page).toContain("worker-src 'self'");
		for (const banned of ['blob:', 'unsafe-inline', "'unsafe-eval'", 'wasm-unsafe-eval'])
			expect(page).not.toContain(banned);
		// Unchanged apart from worker-src.
		expect(page.replace("worker-src 'self'; ", '')).toBe(
			"default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-hashes' " +
				"'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='; img-src 'self' data:; font-src 'self'; " +
				"connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
		);
	});

	it('the engine files allow WebAssembly in their own workers only, from this origin only', () => {
		expect(ocrAssetCsp()).toBe(
			"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; base-uri 'none'"
		);
		expect(ocrAssetCsp()).not.toMatch(/blob:|data:|https?:|unsafe-inline|'unsafe-eval'/);
	});

	it('the root _headers file attaches exactly that policy, nosniff and an immutable cache to /_ocr/*', () => {
		const rules = readFileSync('_headers', 'utf8');
		const block = /^\/_ocr\/\*\n((?: {2}.+\n?)+)/m.exec(rules)?.[1] ?? '';
		expect(block).toContain(`Content-Security-Policy: ${ocrAssetCsp()}`);
		expect(block).toContain('Cache-Control: public, max-age=31536000, immutable');
		// nosniff comes from the /* rule, which applies to every static file.
		expect(/^\/\*\n(?: {2}.+\n)*? {2}X-Content-Type-Options: nosniff/m.test(rules)).toBe(true);
	});
});
