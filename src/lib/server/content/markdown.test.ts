import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown, splitFrontmatter } from './markdown';

describe('renderMarkdown', () => {
	it('renders headings, paragraphs, lists and notes', () => {
		const html = renderMarkdown(
			[
				'Satu baris',
				'lanjut.',
				'',
				'## Judul',
				'',
				'### Sub',
				'',
				'- a',
				'- b',
				'',
				'1. x',
				'2. y',
				'',
				'> catatan',
				'> dua'
			].join('\n')
		);
		expect(html).toBe(
			[
				'<p>Satu baris lanjut.</p>',
				'<h2>Judul</h2>',
				'<h3>Sub</h3>',
				'<ul><li>a</li><li>b</li></ul>',
				'<ol><li>x</li><li>y</li></ol>',
				'<blockquote><p>catatan dua</p></blockquote>'
			].join('\n')
		);
	});

	it('renders strong, em, code and safe links', () => {
		expect(renderMarkdown('**tebal** dan *miring* dan `kode` dan [privasi](/privasi)')).toBe(
			'<p><strong>tebal</strong> dan <em>miring</em> dan <code>kode</code> dan <a href="/privasi">privasi</a></p>'
		);
		expect(renderMarkdown('[luar](https://example.com/a?b=1&c=2)')).toBe(
			'<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">luar</a></p>'
		);
	});

	it('escapes every character of markup in text, code and link text', () => {
		expect(renderMarkdown('<script>alert(1)</script> & "x"')).toBe(
			'<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>'
		);
		expect(renderMarkdown('`<b>`')).toBe('<p><code>&lt;b&gt;</code></p>');
		expect(renderMarkdown('[<img src=x>](/a)')).toBe('<p><a href="/a">&lt;img src=x&gt;</a></p>');
	});

	it('refuses unsafe link targets', () => {
		for (const href of [
			'javascript:alert(1)',
			'data:text/html,x',
			'//evil.example',
			'http://plain.example',
			'/a"onmouseover=x'
		])
			expect(() => renderMarkdown(`[x](${href})`)).toThrow(/not allowed/);
	});

	it('refuses h1 (the page title is the h1) and malformed blocks', () => {
		expect(() => renderMarkdown('# Judul')).toThrow(/not allowed/);
		expect(() => renderMarkdown('## Judul\nteks')).toThrow(/stand alone/);
		expect(() => renderMarkdown('- a\nb')).toThrow(/stray line/);
		expect(() => renderMarkdown('> a\nb')).toThrow(/stray line/);
	});

	it('normalises CRLF line endings', () => {
		expect(renderMarkdown('a\r\n\r\nb')).toBe('<p>a</p>\n<p>b</p>');
	});
});

describe('splitFrontmatter', () => {
	it('splits key: value lines from the body', () => {
		expect(splitFrontmatter('---\ntitle: Halo: dunia\nslug: halo\n---\nIsi\n')).toEqual({
			data: { title: 'Halo: dunia', slug: 'halo' },
			body: 'Isi\n'
		});
	});
	it('throws without frontmatter or on a malformed line', () => {
		expect(() => splitFrontmatter('Isi saja')).toThrow(/missing frontmatter/);
		expect(() => splitFrontmatter('---\nbukan baris\n---\nIsi')).toThrow(/bad frontmatter/);
	});
});

describe('escapeHtml', () => {
	it('escapes the five HTML-significant characters', () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
			'&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
		);
	});
});
