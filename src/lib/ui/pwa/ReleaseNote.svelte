<script lang="ts">
	/**
	 * One release's card (FN-42 "Apa yang baru" on Tentang, FN-42b "Catatan rilis"): version heading, date and the
	 * note. Both pages render this one component so they cannot drift; the heading level fits the page (H3 under
	 * Tentang's "Apa yang baru" H2, H2 under the changelog's H1). `current` marks the running version.
	 */
	import { formatShortDate } from '#lib/shared/dates';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';

	let {
		note,
		level,
		current = false
	}: {
		note: { version: string; date: string; html: string };
		level: 2 | 3;
		current?: boolean;
	} = $props();
	const { tr, trf, locale } = useI18n();
</script>

<article class="release" aria-labelledby="release-{note.version}">
	<div class="head">
		<svelte:element this={`h${level}`} id="release-{note.version}">
			{trf('Versi {versi}', { versi: note.version })}
		</svelte:element>
		{#if current}<Badge>{tr('Versi kamu')}</Badge>{/if}
	</div>
	<p class="meta">
		<time datetime={note.date}>{formatShortDate(note.date, locale)}</time>
	</p>
	<!-- Trusted, repo-authored Markdown rendered by src/lib/server/content/markdown.ts (all text escaped). -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- repo files only, escaped by the renderer -->
	<div class="prose">{@html note.html}</div>
</article>

<style>
	.release {
		display: grid;
		gap: 4px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	h2,
	h3 {
		margin: 0;
		font-size: 17px;
		font-weight: 700;
	}
	/* The badge sits on the card's own panel colour: the page background keeps it visible. */
	.head :global(.badge) {
		background: var(--bg);
	}
	.meta {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.prose {
		margin-top: 8px;
		font-size: 15px;
	}
	.prose :global(p) {
		margin: 0;
	}
	/* Dot bullets drawn by hand (the global reset strips list markers), aligned with the title, 8 px apart. */
	.prose :global(ul) {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.prose :global(li) {
		position: relative;
		padding-left: 16px;
		line-height: 1.45;
	}
	.prose :global(li::before) {
		content: '';
		position: absolute;
		top: 0.6em;
		left: 2px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--muted);
	}
</style>
