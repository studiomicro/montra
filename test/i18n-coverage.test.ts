import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '#lib/shared/i18n-en';

const CALL = /\b(?:tr|trf|msg)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;

function sourceFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile() && /\.(svelte|ts)$/.test(d.name) && !d.name.endsWith('.test.ts'))
		.map((d) => join(d.parentPath, d.name));
}

export function phrasesIn(text: string): string[] {
	return [...text.matchAll(CALL)].map((m) => (m[2] ?? '').replace(/\\(['"])/g, '$1'));
}

describe('i18n coverage', () => {
	it('extracts phrases from tr, trf and msg calls', () => {
		expect(phrasesIn(`tr('A') trf("B {n}", {n}) msg('C\\'s') str('X')`)).toEqual([
			'A',
			'B {n}',
			"C's"
		]);
	});

	it('every Indonesian phrase has an English entry', () => {
		const missing = new Set<string>();
		for (const dir of ['src', 'workers']) {
			for (const file of sourceFiles(dir)) {
				for (const phrase of phrasesIn(readFileSync(file, 'utf8'))) {
					if (!Object.hasOwn(en, phrase)) missing.add(`${phrase}  (${file})`);
				}
			}
		}
		expect([...missing]).toEqual([]);
	});

	it('reports unused English entries without failing', () => {
		const used = new Set<string>();
		for (const dir of ['src', 'workers']) {
			for (const file of sourceFiles(dir))
				phrasesIn(readFileSync(file, 'utf8')).forEach((p) => used.add(p));
		}
		const unused = Object.keys(en).filter((k) => !used.has(k));
		if (unused.length > 0) console.warn(`i18n: unused English entries: ${unused.join(' | ')}`);
		expect(true).toBe(true);
	});
});
