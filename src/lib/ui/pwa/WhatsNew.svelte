<script lang="ts">
	/**
	 * "Baru di Montra {versi}" (FN-42b): the running version's note, once per device, the first time it runs a
	 * newer version than the one it saw last (`decideWhatsNew`). Never on a first install, never on the two pages
	 * that already list the notes (visiting them counts as seen). The seen version is written when the notice is
	 * shown (owner decision D3), so a reload, another tab or the next day never shows it again. Storage blocked:
	 * nothing can be remembered, so it never shows. Rendered after hydration only; an inline status card, not a
	 * dialog; "Tutup" returns focus to <main>.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { decideWhatsNew, isReleaseNotesPath, LAST_SEEN_VERSION_KEY } from '#lib/shared/whats-new';
	import { focusMain } from '#lib/ui/focus-main';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';

	let {
		version,
		note
	}: {
		/** The running version (APP_VERSION). */
		version: string;
		/** Its note in the user's language, or null when the release has none. */
		note: { version: string; html: string } | null;
	} = $props();
	const { tr, trf } = useI18n();

	let open = $state(false);
	const shown = $derived(open && note !== null && !isReleaseNotesPath(page.url.pathname));

	onMount(() => {
		try {
			const decision = decideWhatsNew({
				stored: localStorage.getItem(LAST_SEEN_VERSION_KEY),
				current: version,
				hasNote: note !== null
			});
			if (decision.store !== null) localStorage.setItem(LAST_SEEN_VERSION_KEY, decision.store);
			open = decision.show && !isReleaseNotesPath(page.url.pathname);
		} catch {
			// Storage blocked: nothing can be remembered, and showing it on every load would nag.
		}
	});

	function close() {
		open = false;
		focusMain();
	}
</script>

{#if shown && note}
	<aside class="whats-new" role="status" aria-labelledby="whats-new-title">
		<p class="title" id="whats-new-title">
			{trf('Baru di Montra {versi}', { versi: note.version })}
		</p>
		<!-- Trusted, repo-authored Markdown rendered by src/lib/server/content/markdown.ts (all text escaped). -->
		<!-- A scrollable region must be reachable by keyboard. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="prose" role="region" aria-labelledby="whats-new-title" tabindex="0">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- repo files only, escaped by the renderer -->
			{@html note.html}
		</div>
		<div class="actions">
			<a class="all" href="/pengaturan/tentang/catatan-rilis">{tr('Lihat semua catatan rilis')}</a>
			<Button variant="secondary" size="md" onclick={close}>{tr('Tutup')}</Button>
		</div>
	</aside>
{/if}

<style>
	/* FN-51: mounts after hydration, so it slides in instead of popping (full height from the first frame). */
	@media (prefers-reduced-motion: no-preference) {
		.whats-new {
			animation: banner-in var(--duration-base) var(--ease) backwards;
		}
	}
	@keyframes banner-in {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
	}
	.whats-new {
		display: grid;
		gap: 8px;
		margin-top: 12px;
		padding: 12px 16px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
	}
	.title {
		margin: 0;
		font-weight: 600;
	}
	/* A long note scrolls inside the card; the page below stays reachable. */
	.prose {
		max-height: 40vh;
		overflow-y: auto;
		font-size: 15px;
	}
	.prose:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.prose :global(ul) {
		margin: 0;
		padding-left: 18px;
	}
	.prose :global(li + li) {
		margin-top: 6px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 4px 12px;
	}
	.all {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
</style>
