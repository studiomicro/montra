<script lang="ts">
	/**
	 * "Pasang Montra di layar utama" (FN-13b): shown once on iPhone/iPad Safari, outside the installed app, with a
	 * link to the steps. Closing it, or opening the steps from it, writes one localStorage key and it never
	 * returns on this browser. Never in standalone, in an in-app browser, on Android or on desktop (the browser
	 * is checked here: iPadOS reports a desktop agent the server cannot tell from a Mac). Rendered after
	 * hydration only, so a person who dismissed it never sees it flash. Storage blocked: it shows, and hides for
	 * the page lifetime once closed. An inline card, not a dialog; closing returns focus to <main>.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { detectIosBrowser } from '#lib/shared/user-agent';
	import { focusMain } from '#lib/ui/focus-main';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import { INSTALL_HINT_DISMISSED, isStandalone } from './install.svelte';

	const { tr } = useI18n();
	let open = $state(false);
	const shown = $derived(open && page.url.pathname !== '/pengaturan/instal');

	onMount(() => {
		if (detectIosBrowser(navigator.userAgent, navigator.maxTouchPoints) !== 'safari') return;
		if (isStandalone()) return;
		try {
			open = localStorage.getItem(INSTALL_HINT_DISMISSED) !== '1';
		} catch {
			// Storage blocked: nothing can be remembered, so the hint shows until it is closed.
			open = true;
		}
	});

	function dismiss() {
		open = false;
		try {
			localStorage.setItem(INSTALL_HINT_DISMISSED, '1');
		} catch {
			// Storage blocked: hidden for this page lifetime only.
		}
	}

	function close() {
		dismiss();
		focusMain();
	}
</script>

{#if shown}
	<aside class="hint" aria-labelledby="install-hint-title">
		<p class="title" id="install-hint-title">{tr('Pasang Montra di layar utama')}</p>
		<div class="actions">
			<a class="how" href="/pengaturan/instal" onclick={dismiss}>{tr('Lihat caranya')}</a>
			<Button variant="secondary" size="md" onclick={close}>{tr('Tutup')}</Button>
		</div>
	</aside>
{/if}

<style>
	/* FN-51: mounts after hydration, so it slides in instead of popping (full height from the first frame). */
	@media (prefers-reduced-motion: no-preference) {
		.hint {
			animation: banner-in var(--duration-base) var(--ease) backwards;
		}
	}
	@keyframes banner-in {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
	}
	.hint {
		display: grid;
		gap: 4px;
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
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 4px 12px;
	}
	.how {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
</style>
