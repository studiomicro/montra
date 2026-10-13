import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP_DIRECTIVES } from '../src/lib/server/csp';

// Owner decision 2026-10-10: Geist is the UI font, self-hosted (SIL OFL 1.1, npm `geist`). These checks keep the
// font URL identical everywhere it is written, the files and their licence in the repo, and every request on the
// app origin.

const VERSION = '1.7.2';
const SANS = `/fonts/geist/${VERSION}/Geist-Variable.woff2`;
const MONO = `/fonts/geist-mono/${VERSION}/GeistMono-Variable.woff2`;
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (path: string) => readFileSync(path, 'utf8');

describe('self-hosted Geist', () => {
	it('ships both variable files, unmodified size, with the OFL text beside each', () => {
		for (const [file, dir] of [
			[SANS, 'static/fonts/geist'],
			[MONO, 'static/fonts/geist-mono']
		] as const) {
			expect(statSync(`static${file}`).size).toBeGreaterThan(30_000);
			expect(statSync(`static${file}`).size).toBeLessThan(120_000);
			const ofl = read(`${dir}/${VERSION}/OFL.txt`);
			expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
			expect(ofl).toContain('Vercel');
		}
		// A WOFF2 file starts with "wOF2".
		expect(readFileSync(`static${SANS}`).subarray(0, 4).toString('latin1')).toBe('wOF2');
	});

	it('keeps the files byte-identical to the geist@1.7.2 npm package', () => {
		expect(sha256(`static${SANS}`)).toBe(
			'a369fcf5628ea2aa4e1b9e2ec6a5b3624e365bda588e1f0f2f12b564f728fbb8'
		);
		expect(sha256(`static${MONO}`)).toBe(
			'fba8f577f38a2bbcbe818efa6348dd58f36303a10b8737c42fefad275be563ab'
		);
	});

	it('declares Geist with swap and the full weight range, from this origin only', () => {
		const css = read('src/app.css');
		const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
		expect(faces).toHaveLength(2);
		for (const face of faces) {
			expect(face).toMatch(/font-display:\s*swap/);
			expect(face).toMatch(/font-weight:\s*100 900/);
			expect(face).toMatch(/url\('\/fonts\//);
			expect(face).not.toMatch(/https?:/);
		}
		expect(css).toContain(`url('${SANS}')`);
		expect(css).toContain(`url('${MONO}')`);
		expect(read('static/offline.css')).toContain(`url('${SANS}')`);
	});

	it('preloads exactly the file the CSS declares, as a CORS font', () => {
		const html = read('src/app.html');
		const preload = html.match(/<link\s+rel="preload"[^>]*>/s)?.[0] ?? '';
		expect(preload).toContain(`href="%sveltekit.assets%${SANS}"`);
		expect(preload).toContain('as="font"');
		expect(preload).toContain('type="font/woff2"');
		expect(preload).toContain('crossorigin');
		expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)[^"' ]*font/i);
	});

	it('puts Geist first in the font stack, with a system fallback and mono kept for code only', () => {
		const tokens = read('docs/design/tokens.css');
		expect(tokens).toMatch(
			/--font:\s*'Geist', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;/
		);
		expect(tokens).toMatch(/--font-mono:\s*'Geist Mono', ui-monospace/);
		expect(read('static/offline.css')).toMatch(/font-family:\s*'Geist',\s*system-ui/);
		expect(read('src/app.css')).toMatch(/html\s*\{[^}]*font-family:\s*var\(--font\)/s);
	});

	it('keeps tabular figures on the shared number class', () => {
		expect(read('src/app.css')).toMatch(/\.num\s*\{\s*font-variant-numeric:\s*tabular-nums;/);
	});

	it('needs no CSP change: fonts load from the app origin only', () => {
		expect(CSP_DIRECTIVES['font-src']).toEqual(['self']);
	});

	it('is cached as immutable, and the service worker names the same Geist file', () => {
		const headers = read('_headers');
		expect(headers).toMatch(/\/fonts\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
		expect(existsSync('static/_headers')).toBe(false);
		expect(read('src/lib/shared/sw-policy.ts')).toContain(`'${SANS}'`);
	});
});
