import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPost, listPosts, parsePosts } from './blog';

const post = (slug: string, date = '2026-10-08', title = 'Judul') =>
	`---\ntitle: ${title}\nslug: ${slug}\ndate: ${date}\nexcerpt: Ringkas.\n---\nIsi.\n`;

describe('the repo blog posts (FN-32)', () => {
	it('lists the three starter posts in both languages, newest first, with frontmatter fields', () => {
		const id = listPosts('id');
		const en = listPosts('en');
		expect(id.map((p) => p.slug)).toEqual([
			'file-unggahan-tidak-disimpan',
			'email-qris-jadi-transaksi',
			'struk-jadi-transaksi'
		]);
		expect(en.map((p) => p.slug)).toEqual(id.map((p) => p.slug));
		expect(id[2]).toEqual({
			slug: 'struk-jadi-transaksi',
			title: 'Dari struk ke transaksi dalam hitungan detik',
			date: '2026-10-06',
			excerpt: expect.any(String)
		});
		expect(en[2]?.title).toBe('From receipt to transaction in seconds');
	});

	it('renders a post by slug and answers null for an unknown or inherited one', () => {
		expect(getPost('id', 'struk-jadi-transaksi')?.html).toContain('<h2>');
		expect(getPost('en', 'email-qris-jadi-transaksi')?.title).toBe(
			'One QRIS e-mail, one transaction — no typing'
		);
		for (const slug of ['nope', 'constructor', '__proto__', '../struk-jadi-transaksi'])
			expect(getPost('id', slug)).toBeNull();
	});

	it('every post states its status honestly and none names another product', () => {
		for (const name of readdirSync('src/lib/content/blog')) {
			const text = readFileSync(`src/lib/content/blog/${name}`, 'utf8');
			expect(text.toLowerCase()).not.toMatch(new RegExp('oy' + 'en'));
		}
	});
});

describe('parsePosts', () => {
	const ok = {
		'/x/a.id.md': post('a'),
		'/x/a.en.md': post('a', '2026-10-08', 'Title')
	};

	it('pairs the two languages of one post', () => {
		const posts = parsePosts(ok);
		expect(posts.get('id')?.get('a')?.title).toBe('Judul');
		expect(posts.get('en')?.get('a')?.title).toBe('Title');
	});

	it('refuses a missing language, a mismatched slug or date, and a bad name or field', () => {
		expect(() => parsePosts({ '/x/a.id.md': post('a') })).toThrow(/no English/);
		expect(() => parsePosts({ '/x/a.en.md': post('a') })).toThrow(/no Indonesian/);
		expect(() => parsePosts({ ...ok, '/x/b.id.md': post('a') })).toThrow(/does not match/);
		expect(() =>
			parsePosts({ '/x/a.id.md': post('a'), '/x/a.en.md': post('a', '2026-10-07') })
		).toThrow(/two different dates/);
		expect(() => parsePosts({ '/x/A.id.md': post('a') })).toThrow(/unexpected file name/);
		expect(() =>
			parsePosts({ '/x/a.id.md': post('a', '8 Okt'), '/x/a.en.md': post('a', '8 Okt') })
		).toThrow();
	});
});
