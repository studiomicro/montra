<script lang="ts">
	import { formatShortDate } from '#lib/shared/dates';
	import { localizedSitePath } from '#lib/shared/site-locale';
	import { useI18n } from '#lib/ui/i18n-context';
	import SiteHead from '#lib/ui/site/SiteHead.svelte';

	let { data } = $props();
	const { tr, locale } = useI18n();
</script>

<SiteHead
	title={data.post.title}
	description={data.post.excerpt}
	path="/blog/{data.post.slug}"
	type="article"
/>
<article class="post">
	<a class="back" href={localizedSitePath(locale, '/blog')}>{tr('Semua artikel')}</a>
	<h1>{data.post.title}</h1>
	<p class="meta">
		<time datetime={data.post.date}>{formatShortDate(data.post.date, locale)}</time>
	</p>
	<!-- Trusted, repo-authored Markdown rendered by src/lib/server/content/markdown.ts (all text escaped). -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- repo files only, escaped by the renderer -->
	<div class="prose">{@html data.post.html}</div>
	<p class="disclaimer">{tr('Artikel ini informasi umum, bukan nasihat keuangan.')}</p>
</article>

<style>
	.post {
		max-width: 680px;
		padding: 32px 0 0;
	}
	.back {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink-2);
	}
	h1 {
		margin: 8px 0 0;
		font-size: clamp(32px, 5vw, 48px);
		line-height: 1.08;
		font-weight: 700;
		letter-spacing: -0.035em;
		text-wrap: balance;
	}
	.meta {
		margin: 12px 0 0;
		color: var(--muted);
		font-size: 15px;
	}
	.prose {
		margin-top: 24px;
		color: var(--ink-2);
	}
	.prose :global(h2) {
		margin: 40px 0 8px;
		font-size: 24px;
		font-weight: 650;
		letter-spacing: -0.022em;
		color: var(--ink);
	}
	.prose :global(h3) {
		margin: 28px 0 8px;
		font-size: 19px;
		font-weight: 600;
		color: var(--ink);
	}
	.prose :global(p),
	.prose :global(ul),
	.prose :global(ol) {
		margin: 0 0 16px;
		text-wrap: pretty;
	}
	.prose :global(li + li) {
		margin-top: 6px;
	}
	.prose :global(strong) {
		color: var(--ink);
	}
	.prose :global(a) {
		color: var(--brand);
	}
	.prose :global(blockquote) {
		margin: 24px 0;
		padding: 16px 20px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.prose :global(blockquote p) {
		margin: 0;
	}
	.disclaimer {
		margin: 40px 0 0;
		padding-top: 16px;
		border-top: 1px solid var(--line);
		color: var(--muted);
		font-size: 14px;
	}
</style>
