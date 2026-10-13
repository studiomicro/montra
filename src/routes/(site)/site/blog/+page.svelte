<script lang="ts">
	import { formatShortDate } from '#lib/shared/dates';
	import { localizedSitePath } from '#lib/shared/site-locale';
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import SiteHead from '#lib/ui/site/SiteHead.svelte';

	let { data } = $props();
	const { tr, locale } = useI18n();
</script>

<SiteHead
	title={tr('Blog')}
	description={tr(
		'Cara kerja pencatatan otomatis, privasi data, dan kebiasaan kecil mengatur uang.'
	)}
	path="/blog"
/>
<h1 class="title">{tr('Blog')}</h1>
<p class="lead">
	{tr('Cara kerja pencatatan otomatis, privasi data, dan kebiasaan kecil mengatur uang.')}
</p>

{#if data.posts.length === 0}
	<EmptyState text={tr('Belum ada artikel.')} />
{:else}
	<ul class="posts">
		{#each data.posts as post (post.slug)}
			<li>
				<a class="post" href={localizedSitePath(locale, `/blog/${post.slug}`)}>
					<time datetime={post.date}>{formatShortDate(post.date, locale)}</time>
					<h2>{post.title}</h2>
					<p>{post.excerpt}</p>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.title {
		margin: 48px 0 0;
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	.lead {
		max-width: 60ch;
		margin: 8px 0 0;
		color: var(--muted);
	}
	.posts {
		display: grid;
		gap: 16px;
		margin: 32px 0 0;
		padding: 0;
		list-style: none;
	}
	.post {
		display: block;
		padding: 24px;
		border-radius: var(--r-l);
		background: var(--panel);
		color: var(--ink);
		text-decoration: none;
	}
	time {
		color: var(--muted);
		font-size: 14px;
	}
	h2 {
		margin: 6px 0 0;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.022em;
		text-wrap: balance;
	}
	p {
		margin: 8px 0 0;
		color: var(--ink-2);
	}
</style>
