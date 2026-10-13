/**
 * A small Markdown subset for the blog's repo-authored posts (FN-32), rendered on the server at build time —
 * no dependency, no client-side parsing. Trusted content only (files in src/lib/content), yet every character of
 * text is HTML-escaped and links are limited to site paths and https, so a careless post cannot inject markup.
 *
 * Supported: `## ` and `### ` headings (a post's title is its page's h1, so `# ` is refused), paragraphs,
 * `- ` and `1. ` lists, `> ` notes, and inline `**strong**`, `*em*`, `` `code` `` and `[text](href)`.
 * Anything malformed throws, so `npm run build` fails instead of publishing a broken post.
 */

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/** Site-relative paths and https URLs only; never `javascript:`, `data:` or protocol-relative `//`. */
function safeHref(href: string): string {
	if (/^\/(?!\/)[\w\-./#]*$/.test(href) || /^https:\/\/[\w.-]+(\/[\w\-./#?=&%]*)?$/.test(href))
		return href;
	throw new Error(`markdown: link target not allowed: ${href}`);
}

function inline(text: string): string {
	// Split out code and links before escaping so their contents are handled on their own.
	const parts: string[] = [];
	const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
	let last = 0;
	for (const m of text.matchAll(pattern)) {
		parts.push(emphasis(escapeHtml(text.slice(last, m.index))));
		if (m[1] !== undefined) parts.push(`<code>${escapeHtml(m[1])}</code>`);
		else {
			const href = safeHref(m[3] as string);
			const external = href.startsWith('https://') ? ' rel="noopener noreferrer"' : '';
			parts.push(
				`<a href="${escapeHtml(href)}"${external}>${emphasis(escapeHtml(m[2] as string))}</a>`
			);
		}
		last = m.index + m[0].length;
	}
	parts.push(emphasis(escapeHtml(text.slice(last))));
	return parts.join('');
}

function emphasis(escaped: string): string {
	return escaped
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

const LIST_ITEM = { ul: /^- (.+)$/, ol: /^\d+\. (.+)$/ } as const;

function block(lines: string[]): string {
	const first = lines[0] as string;
	if (/^#(?!#)/.test(first)) throw new Error(`markdown: "# " headings are not allowed: ${first}`);
	const heading = /^(#{2,3}) (.+)$/.exec(first);
	if (heading) {
		if (lines.length > 1) throw new Error(`markdown: a heading must stand alone: ${first}`);
		const level = (heading[1] as string).length;
		return `<h${level}>${inline((heading[2] as string).trim())}</h${level}>`;
	}
	for (const tag of ['ul', 'ol'] as const) {
		if (LIST_ITEM[tag].test(first)) {
			const items = lines.map((line) => {
				const m = LIST_ITEM[tag].exec(line);
				if (!m) throw new Error(`markdown: mixed list or stray line: ${line}`);
				return `<li>${inline((m[1] as string).trim())}</li>`;
			});
			return `<${tag}>${items.join('')}</${tag}>`;
		}
	}
	if (first.startsWith('> ')) {
		const text = lines.map((line) => {
			if (!line.startsWith('> ')) throw new Error(`markdown: stray line in a note: ${line}`);
			return line.slice(2).trim();
		});
		return `<blockquote><p>${inline(text.join(' '))}</p></blockquote>`;
	}
	return `<p>${inline(lines.map((l) => l.trim()).join(' '))}</p>`;
}

export function renderMarkdown(source: string): string {
	const blocks: string[][] = [];
	let current: string[] = [];
	for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
		const line = raw.trimEnd();
		if (line.trim() === '') {
			if (current.length > 0) blocks.push(current);
			current = [];
		} else current.push(line);
	}
	if (current.length > 0) blocks.push(current);
	return blocks.map(block).join('\n');
}

/** Splits `---` frontmatter (`key: value` lines) from the body. */
export function splitFrontmatter(source: string): { data: Record<string, string>; body: string } {
	const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n?/g, '\n'));
	if (!m) throw new Error('markdown: missing frontmatter');
	const data: Record<string, string> = {};
	for (const line of (m[1] as string).split('\n')) {
		const kv = /^([a-z]+):\s*(.*)$/.exec(line);
		if (!kv) throw new Error(`markdown: bad frontmatter line: ${line}`);
		data[kv[1] as string] = (kv[2] as string).trim();
	}
	return { data, body: m[2] as string };
}
