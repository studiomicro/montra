import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PLATFORM = /platform\??\.env|event\.platform/;
const CF_IMPORT = /from\s+['"]cloudflare:workers['"]|import\(\s*['"]cloudflare:workers['"]\s*\)/;
const ALLOWED = join('src', 'lib', 'server', 'env.ts');

const files = readdirSync('src', { recursive: true, withFileTypes: true })
	.filter((d) => d.isFile() && /\.(ts|js|svelte)$/.test(d.name) && !/\.test\.ts$/.test(d.name))
	.map((d) => join(d.parentPath, d.name));

describe('Cloudflare bindings accessor (SvelteKit 3 passes no event.platform)', () => {
	it('detectors match what they should', () => {
		expect(PLATFORM.test('platform.env.DB')).toBe(true);
		expect(PLATFORM.test('platform?.env')).toBe(true);
		expect(PLATFORM.test('event.platform')).toBe(true);
		expect(CF_IMPORT.test("import { env } from 'cloudflare:workers';")).toBe(true);
		expect(PLATFORM.test('getEnv()')).toBe(false);
	});

	it('no source file reads platform.env or event.platform', () => {
		const offenders = files.filter((f) => f !== ALLOWED && PLATFORM.test(readFileSync(f, 'utf8')));
		expect(offenders).toEqual([]);
	});

	it('only src/lib/server/env.ts imports cloudflare:workers', () => {
		const offenders = files.filter((f) => f !== ALLOWED && CF_IMPORT.test(readFileSync(f, 'utf8')));
		expect(offenders).toEqual([]);
	});
});
