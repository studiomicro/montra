import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	compareVersionsDesc,
	listAllReleaseNotes,
	listReleaseNotes,
	parseReleaseNotes,
	releaseDateOf,
	releaseNoteFor
} from './release-notes';

/**
 * The release rule (FN-42b, docs/RUNBOOK.md "Release notes"): the newest `## vX.Y.Z — YYYY-MM-DD …` heading of
 * CHANGELOG.md has an Indonesian and an English note dated that same (UTC) day. Returns what is wrong, or null.
 */
function newestReleaseProblem(changelog: string): string | null {
	const m = /^## v(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})\b/m.exec(changelog);
	if (!m) return 'CHANGELOG.md has no "## vX.Y.Z — YYYY-MM-DD" heading';
	const [, version, date] = m;
	for (const locale of ['id', 'en'] as const) {
		const note = listReleaseNotes(locale, 100).find((n) => n.version === version);
		if (!note) return `v${version} has no ${version}.${locale}.md release note`;
		if (note.date !== date)
			return `${version}.${locale}.md is dated ${note.date}, CHANGELOG.md ${date}`;
	}
	return null;
}

const note = (version: string, date = '2026-10-08', body = '- Satu hal baru.') =>
	`---\nversion: ${version}\ndate: ${date}\n---\n\n${body}\n`;
const pair = (version: string, date?: string) => ({
	[`/x/${version}.id.md`]: note(version, date),
	[`/x/${version}.en.md`]: note(version, date, '- One new thing.')
});

describe('the bundled release notes (FN-42)', () => {
	it('lists the three newest releases, newest first, in both languages', () => {
		// Every release adds a pair, so the list is checked by order and count, not by fixed versions.
		const all = listReleaseNotes('id', 100).map((n) => n.version);
		const byNewest = [...all].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
		expect(all).toEqual(byNewest);
		expect(all).toEqual(expect.arrayContaining(['0.4.0', '0.3.0', '0.2.0', '0.1.0']));
		expect(listReleaseNotes('id').map((n) => n.version)).toEqual(all.slice(0, 3));
		expect(listReleaseNotes('en').map((n) => n.version)).toEqual(all.slice(0, 3));
		const pick = (locale: 'id' | 'en') =>
			listReleaseNotes(locale, 100).find((n) => n.version === '0.4.0');
		const [id, en] = [pick('id'), pick('en')];
		expect(id?.date).toBe('2026-10-09');
		expect(id?.html).toContain('<li>');
		expect(id?.html).toContain('pesan-antar makanan');
		expect(en?.html).toContain('food delivery');
		expect(id?.html).not.toBe(en?.html);
	});

	it('knows the release date of a version, and null for one without a note', () => {
		expect(releaseDateOf('0.4.0')).toBe('2026-10-09');
		expect(releaseDateOf('0.1.0')).toBe('2026-10-08');
		expect(releaseDateOf('9.9.9')).toBeNull();
	});

	it('never carries an engineering line, a file name, another product or the old working name', () => {
		for (const name of readdirSync('src/lib/content/release-notes')) {
			const text = readFileSync(`src/lib/content/release-notes/${name}`, 'utf8');
			expect(text, name).not.toMatch(/behind the scenes|di balik layar/i);
			expect(text, name).not.toMatch(/\b\d{4}_|\.sql\b|\.ts\b|src\/|migration|migrasi/i);
			expect(text.toLowerCase(), name).not.toMatch(new RegExp('oy' + 'en|fin' + 'ancer'));
		}
	});
});

describe('the full list, one release, and the release rule (FN-42b)', () => {
	it('lists every release, newest first, in each language', () => {
		const files = readdirSync('src/lib/content/release-notes');
		for (const locale of ['id', 'en'] as const) {
			const all = listAllReleaseNotes(locale);
			expect(all).toHaveLength(files.length / 2);
			expect(all.map((n) => n.version)).toEqual(
				listReleaseNotes(locale, 100).map((n) => n.version)
			);
			expect(all.slice(0, 3)).toEqual(listReleaseNotes(locale));
		}
		expect(listAllReleaseNotes('id').at(-1)?.version).toBe('0.1.0');
	});

	it('finds one release in a language, or null', () => {
		expect(releaseNoteFor('id', '0.4.0')?.html).toContain('pesan-antar makanan');
		expect(releaseNoteFor('en', '0.4.0')?.html).toContain('food delivery');
		expect(releaseNoteFor('id', '9.9.9')).toBeNull();
	});

	it('every note renders to at most 4 KB (the app layout carries the running one)', () => {
		for (const locale of ['id', 'en'] as const)
			for (const n of listAllReleaseNotes(locale))
				expect(
					new TextEncoder().encode(n.html).length,
					`${n.version}.${locale}`
				).toBeLessThanOrEqual(4096);
	});

	it('the newest CHANGELOG.md release has its note pair, dated the same day', () => {
		expect(newestReleaseProblem(readFileSync('CHANGELOG.md', 'utf8'))).toBeNull();
	});

	it('the release rule catches a release without notes or with another date', () => {
		expect(
			newestReleaseProblem('# Changelog\n\n## v9.9.9 — 2026-10-10 08:00 UTC (staging)\n')
		).toBe('v9.9.9 has no 9.9.9.id.md release note');
		expect(newestReleaseProblem('## v0.4.0 — 2026-10-10 08:00 UTC\n')).toMatch(/dated 2026-10-09/);
		expect(newestReleaseProblem('# Changelog\n')).toMatch(/no "## vX.Y.Z/);
	});
});

describe('compareVersionsDesc', () => {
	it('sorts by number, not by text: 0.10.0 is newer than 0.4.0', () => {
		expect(['0.4.0', '0.10.0', '1.0.0', '0.9.12', '0.9.2'].sort(compareVersionsDesc)).toEqual([
			'1.0.0',
			'0.10.0',
			'0.9.12',
			'0.9.2',
			'0.4.0'
		]);
		expect(compareVersionsDesc('0.4.0', '0.4.0')).toBe(0);
	});
});

describe('parseReleaseNotes', () => {
	it('pairs the two languages and orders them newest first by semantic version', () => {
		const notes = parseReleaseNotes({ ...pair('0.4.0'), ...pair('0.10.0'), ...pair('0.9.0') });
		expect(notes.get('id')?.map((n) => n.version)).toEqual(['0.10.0', '0.9.0', '0.4.0']);
		expect(notes.get('en')?.[0]?.html).toBe('<ul><li>One new thing.</li></ul>');
	});

	it('fails the build for a release in one language only', () => {
		const ok = pair('0.4.0');
		expect(() => parseReleaseNotes({ '/x/0.4.0.id.md': ok['/x/0.4.0.id.md']! })).toThrow(
			/0\.4\.0 has no English version/
		);
		expect(() => parseReleaseNotes({ '/x/0.4.0.en.md': ok['/x/0.4.0.en.md']! })).toThrow(
			/0\.4\.0 has no Indonesian version/
		);
	});

	it('accepts no notes at all (an internal build without a note still loads)', () => {
		expect(parseReleaseNotes({}).get('id')).toEqual([]);
	});

	it('refuses a version that does not match the file name, a bad date, a bad name or two dates', () => {
		expect(() => parseReleaseNotes({ '/x/0.4.0.id.md': note('0.5.0') })).toThrow(/does not match/);
		expect(() => parseReleaseNotes({ '/x/0.4.0.id.md': note('0.4.0', '2026-02-30') })).toThrow();
		expect(() => parseReleaseNotes({ '/x/v0.4.id.md': note('0.4.0') })).toThrow(
			/unexpected file name/
		);
		expect(() => parseReleaseNotes({ '/x/0.4.0.fr.md': note('0.4.0') })).toThrow(
			/unexpected file name/
		);
		expect(() =>
			parseReleaseNotes({
				'/x/0.4.0.id.md': note('0.4.0', '2026-10-08'),
				'/x/0.4.0.en.md': note('0.4.0', '2026-10-09')
			})
		).toThrow(/two different dates/);
		expect(() => parseReleaseNotes({ '/x/01.4.0.id.md': note('01.4.0') })).toThrow();
	});
});
