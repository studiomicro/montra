import { z } from 'zod';
import { isDateString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import { compareVersionsDesc, VERSION_PATTERN } from '#lib/shared/versions';
import { renderMarkdown, splitFrontmatter } from './markdown.ts';

/**
 * "Apa yang baru" on /pengaturan/tentang (FN-42), the full list on /pengaturan/tentang/catatan-rilis and the
 * one-time "Baru di Montra" notice (FN-42b): one Markdown file per user-visible release and language in
 * src/lib/content/release-notes, named `<version>.<id|en>.md`, bundled and rendered at build time exactly like the
 * blog. Written for users, separately from the engineering CHANGELOG.md (which the app never reads): plain bullets,
 * no "Behind the scenes" line. A note in one language only fails the build. The newest CHANGELOG.md release must
 * have its pair: `npm test` fails otherwise (release-notes.test.ts; docs/RUNBOOK.md "Release notes"). An older
 * internal build without a note still loads (no release date, no notice).
 */

export { compareVersionsDesc };

export interface ReleaseNote {
	/** `MAJOR.MINOR.PATCH`, the same value as `APP_VERSION` for that release. */
	version: string;
	/** Release date, `YYYY-MM-DD` (a calendar day, not an instant). */
	date: string;
	html: string;
}

/** How many releases "Apa yang baru" lists (owner decision 2). */
const RELEASE_NOTES_SHOWN = 3;

const frontmatter = z.object({
	version: z.string().regex(VERSION_PATTERN),
	date: z.string().refine(isDateString)
});

const FILE = /\/(\d+\.\d+\.\d+)\.(id|en)\.md$/;

/** Parses every note file; throws on a malformed file, a version that does not match its name, or a lone language. */
export function parseReleaseNotes(files: Record<string, string>): Map<Locale, ReleaseNote[]> {
	const byLocale = new Map<Locale, Map<string, ReleaseNote>>([
		['id', new Map()],
		['en', new Map()]
	]);
	for (const [name, source] of Object.entries(files)) {
		const m = FILE.exec(name);
		if (!m) throw new Error(`release-notes: unexpected file name ${name}`);
		const { data, body } = splitFrontmatter(source);
		const meta = frontmatter.parse(data);
		if (meta.version !== m[1])
			throw new Error(`release-notes: version ${meta.version} does not match ${name}`);
		byLocale.get(m[2] as Locale)?.set(meta.version, { ...meta, html: renderMarkdown(body) });
	}
	const id = byLocale.get('id') as Map<string, ReleaseNote>;
	const en = byLocale.get('en') as Map<string, ReleaseNote>;
	for (const [version, note] of id) {
		const other = en.get(version);
		if (!other) throw new Error(`release-notes: ${version} has no English version`);
		if (other.date !== note.date)
			throw new Error(`release-notes: ${version} has two different dates`);
	}
	for (const version of en.keys())
		if (!id.has(version)) throw new Error(`release-notes: ${version} has no Indonesian version`);
	const sorted = (notes: Map<string, ReleaseNote>) =>
		[...notes.values()].sort((a, b) => compareVersionsDesc(a.version, b.version));
	return new Map([
		['id', sorted(id)],
		['en', sorted(en)]
	]);
}

const NOTES = parseReleaseNotes(
	import.meta.glob<string>('../../content/release-notes/*.md', {
		query: '?raw',
		import: 'default',
		eager: true
	})
);

/** The newest `limit` releases in `locale`, newest first. */
export function listReleaseNotes(locale: Locale, limit = RELEASE_NOTES_SHOWN): ReleaseNote[] {
	return (NOTES.get(locale) ?? []).slice(0, limit);
}

/** The release date of `version`, or null when that release has no note. */
export function releaseDateOf(version: string): string | null {
	return (NOTES.get('id') ?? []).find((n) => n.version === version)?.date ?? null;
}

/** Every release in `locale`, newest first (the changelog page). */
export function listAllReleaseNotes(locale: Locale): ReleaseNote[] {
	return [...(NOTES.get(locale) ?? [])];
}

/** The note for `version` in `locale`, or null when that release has none. */
export function releaseNoteFor(locale: Locale, version: string): ReleaseNote | null {
	return (NOTES.get(locale) ?? []).find((n) => n.version === version) ?? null;
}
