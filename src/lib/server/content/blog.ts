import { z } from 'zod';
import { isDateString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import { renderMarkdown, splitFrontmatter } from './markdown.ts';

/**
 * Blog posts (FN-32): Markdown files in src/lib/content/blog, one per language, named `<slug>.<id|en>.md`.
 * Read and rendered at build time (the blog is prerendered); edited by a commit, never by an admin screen.
 */

export interface PostMeta {
	slug: string;
	title: string;
	/** Publication date, `YYYY-MM-DD`. */
	date: string;
	excerpt: string;
}

export interface Post extends PostMeta {
	html: string;
}

const frontmatter = z.object({
	title: z.string().min(1).max(120),
	slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
	date: z.string().refine(isDateString),
	excerpt: z.string().min(1).max(240)
});

const FILE = /\/([a-z0-9-]+)\.(id|en)\.md$/;

/** Parses every post file; throws on a malformed file, a slug that does not match its name, or a missing language. */
export function parsePosts(files: Record<string, string>): Map<Locale, Map<string, Post>> {
	const posts = new Map<Locale, Map<string, Post>>([
		['id', new Map()],
		['en', new Map()]
	]);
	for (const [name, source] of Object.entries(files)) {
		const m = FILE.exec(name);
		if (!m) throw new Error(`blog: unexpected file name ${name}`);
		const { data, body } = splitFrontmatter(source);
		const meta = frontmatter.parse(data);
		if (meta.slug !== m[1]) throw new Error(`blog: slug ${meta.slug} does not match ${name}`);
		posts.get(m[2] as Locale)?.set(meta.slug, { ...meta, html: renderMarkdown(body) });
	}
	const id = posts.get('id') as Map<string, Post>;
	const en = posts.get('en') as Map<string, Post>;
	for (const [slug, post] of id) {
		const other = en.get(slug);
		if (!other) throw new Error(`blog: ${slug} has no English version`);
		if (other.date !== post.date) throw new Error(`blog: ${slug} has two different dates`);
	}
	for (const slug of en.keys())
		if (!id.has(slug)) throw new Error(`blog: ${slug} has no Indonesian version`);
	return posts;
}

const POSTS = parsePosts(
	import.meta.glob<string>('../../content/blog/*.md', {
		query: '?raw',
		import: 'default',
		eager: true
	})
);

/** Newest first; ties by slug, so the order never depends on file system order. */
export function listPosts(locale: Locale): PostMeta[] {
	return [...(POSTS.get(locale) as Map<string, Post>).values()]
		.map(({ slug, title, date, excerpt }) => ({ slug, title, date, excerpt }))
		.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function getPost(locale: Locale, slug: string): Post | null {
	return POSTS.get(locale)?.get(slug) ?? null;
}
