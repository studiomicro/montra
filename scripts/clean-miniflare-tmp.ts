import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Test infrastructure: miniflare (wrangler's getPlatformProxy in the integration tests, `wrangler dev` in e2e)
 * leaves `miniflare-*` directories in the temp directory; on 2026-10-08 they filled /tmp and caused flaky
 * workerd / SQLITE_FULL failures. Run as `posttest` and by hand (`npm run clean:tmp`).
 */
export const MINIFLARE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Removes the `miniflare-*` directories in `dir` owned by `uid` and last modified more than
 * MINIFLARE_MAX_AGE_MS before `now` (an hour, so a run in progress keeps its own). Never follows a link, never
 * touches another user's directory or a plain file. Returns the removed paths.
 */
export function removeStaleMiniflareDirs(
	dir: string,
	opts: { uid: number; now: number; maxAgeMs?: number }
): string[] {
	const maxAge = opts.maxAgeMs ?? MINIFLARE_MAX_AGE_MS;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names) {
		if (!name.startsWith('miniflare-')) continue;
		const path = join(dir, name);
		try {
			const st = lstatSync(path);
			if (!st.isDirectory() || st.uid !== opts.uid || opts.now - st.mtimeMs <= maxAge) continue;
			rmSync(path, { recursive: true, force: true });
			removed.push(path);
		} catch {
			// Gone meanwhile or not ours to remove: leave it.
		}
	}
	return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const uid = process.getuid?.();
	if (uid === undefined) process.exit(0);
	const removed = removeStaleMiniflareDirs(tmpdir(), { uid, now: Date.now() });
	console.log(
		`clean:tmp: removed ${removed.length} stale miniflare director${removed.length === 1 ? 'y' : 'ies'}`
	);
}
