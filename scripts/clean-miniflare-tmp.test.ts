import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MINIFLARE_MAX_AGE_MS, removeStaleMiniflareDirs } from './clean-miniflare-tmp.ts';

describe('removeStaleMiniflareDirs (test-infra /tmp cleanup)', () => {
	let root = '';
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('removes only this user’s miniflare-* directories older than an hour', () => {
		root = mkdtempSync(join(tmpdir(), 'clean-miniflare-test-'));
		const now = Date.now();
		const aged = (name: string, ageMs: number, file = false) => {
			const path = join(root, name);
			if (file) writeFileSync(path, 'x');
			else {
				mkdirSync(path);
				writeFileSync(join(path, 'db.sqlite'), 'x');
			}
			const t = (now - ageMs) / 1000;
			utimesSync(path, t, t);
			return path;
		};
		const old = aged('miniflare-0a1b2c', MINIFLARE_MAX_AGE_MS + 60_000);
		const fresh = aged('miniflare-3d4e5f', 5 * 60_000);
		const other = aged('playwright-artifacts-x', MINIFLARE_MAX_AGE_MS * 3);
		const oldFile = aged('miniflare-file', MINIFLARE_MAX_AGE_MS * 3, true);
		const uid = process.getuid?.() ?? -1;

		// Another user's directory is never touched.
		expect(removeStaleMiniflareDirs(root, { uid: uid + 1, now })).toEqual([]);
		expect(existsSync(old)).toBe(true);

		expect(removeStaleMiniflareDirs(root, { uid, now })).toEqual([old]);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(other)).toBe(true);
		expect(existsSync(oldFile)).toBe(true);
	});

	it('a missing directory removes nothing', () => {
		root = join(tmpdir(), `clean-miniflare-missing-${Date.now()}`);
		expect(removeStaleMiniflareDirs(root, { uid: 0, now: Date.now() })).toEqual([]);
	});
});
