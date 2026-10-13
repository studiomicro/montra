import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Node's native type stripping needs explicit `.ts` extensions; Vite does not.
// Every scripts/*.ts entry that pulls in src/ must import cleanly under plain Node.
const root = new URL('..', import.meta.url).pathname;
// Entries that run commands on import (seed-local, migrate-local, reset-local) have no exports; the src/ modules
// they use are covered through the exporting entries that share them.
function isSideEffectFreeSrcImporter(f: string) {
	const t = readFileSync(`${root}scripts/${f}`, 'utf8');
	return /\.\.\/src\//.test(t) && /^export /m.test(t);
}
const entries = readdirSync(`${root}scripts`).filter(
	(f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && isSideEffectFreeSrcImporter(f)
);

describe('scripts are Node-resolvable', () => {
	it('finds entries that import from src/', () => expect(entries.length).toBeGreaterThan(0));
	for (const f of entries) {
		it(`imports scripts/${f} under plain Node`, () => {
			const r = spawnSync(
				process.execPath,
				['--input-type=module', '-e', `await import('./scripts/${f}')`],
				{ cwd: root, encoding: 'utf8' }
			);
			expect(r.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
			expect(r.status).toBe(0);
		});
	}
});
