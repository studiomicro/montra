<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { navigating } from '$app/state';
	import { statScreenForPath } from '#lib/shared/privacy';
	import { hasProLook } from '#lib/shared/pro-look';
	import { sessionStillSignedIn, watchSessionEnd } from '#lib/ui/account-key/device';
	import MascotLoading from '#lib/ui/kit/MascotLoading.svelte';
	import { setProLook } from '#lib/ui/kit/pro-look-context';
	import AddSheet from '#lib/ui/shell/AddSheet.svelte';
	import { addPaths } from '#lib/ui/shell/nav';
	import OfflineQueueStatus from '#lib/ui/offline-queue/OfflineQueueStatus.svelte';
	import InstallHint from '#lib/ui/pwa/InstallHint.svelte';
	import WhatsNew from '#lib/ui/pwa/WhatsNew.svelte';
	import FiturSheet from '#lib/ui/shell/FiturSheet.svelte';
	import Sidebar from '#lib/ui/shell/Sidebar.svelte';
	import TabBar from '#lib/ui/shell/TabBar.svelte';
	import { track } from '#lib/ui/track';
	import { isAddShortcut, isEditableTarget } from '#lib/ui/shell/shortcut';

	let { data, children } = $props();
	let adding = $state(false);
	// FN-46: every Koko on these pages wears the crown only while the server says a paid plan is in force.
	setProLook(() => hasProLook(data.shell.plan));
	// FN-21: the opened account key goes when the session ends in another tab or on another device.
	onMount(() => watchSessionEnd(document, sessionStillSignedIn));
	// FN-31 usage statistics: the tab destinations (and the privacy page) as named screens, nothing else.
	afterNavigate(({ to }) => {
		const screen = to ? statScreenForPath(to.url.pathname) : null;
		if (screen) track(screen, 'view');
	});
	function openAdd() {
		adding = true;
		track('tambah', 'open');
	}

	/** `N` outside text entry opens the Tambah sheet (APP_PARITY § 1). */
	function onkeydown(event: KeyboardEvent) {
		const shortcut = isAddShortcut({
			key: event.key,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
			altKey: event.altKey,
			repeat: event.repeat,
			defaultPrevented: event.defaultPrevented,
			editable: isEditableTarget(event.target),
			dialogOpen: document.querySelector('dialog[open]') !== null
		});
		if (!shortcut) return;
		event.preventDefault();
		openAdd();
	}
</script>

<svelte:window {onkeydown} />

<!-- FN-44: Koko walks at the top while a client-side navigation is in flight, and is gone once it lands. -->
<MascotLoading active={navigating.to !== null} />

<div class="app">
	<Sidebar hidden={data.hiddenModules} shell={data.shell} onadd={openAdd} />
	<main class="content">
		<!-- FN-42b: the one-time "Baru di Montra" notice, above the offline-queue status (never covering it). -->
		{#if data.appVersion}
			<WhatsNew version={data.appVersion} note={data.whatsNew} />
		{/if}
		<!-- FN-13b: the one-time iOS Safari "Pasang Montra di layar utama" card, below the notice above. -->
		<InstallHint />
		{#if data.queue}
			{#key data.queue.accountId}
				<OfflineQueueStatus accountId={data.queue.accountId} spaceId={data.queue.spaceId} />
			{/key}
		{/if}
		{@render children()}
	</main>
	<TabBar onadd={openAdd} open={adding} />
	<AddSheet bind:open={adding} paths={addPaths(data.receiptReady, data.forwardingReady)} />
	<FiturSheet hidden={data.hiddenModules} />
</div>

<style>
	.app {
		display: flex;
		min-height: calc(100dvh - var(--sai-top));
	}
	/* Phone first: one column, 20 px sides, room for the floating tab bar. */
	.content {
		flex: 1;
		min-width: 0;
		max-width: 640px;
		margin: 0 auto;
		padding: 0 max(20px, var(--sai-right)) calc(var(--tabbar-h) + 40px + var(--sai-bottom))
			max(20px, var(--sai-left));
	}
	/*
	 * Tablet tier (owner request 2026-10-26): from 860 px without the sidebar (iPhone Duo unfolded in landscape,
	 * 890 px; iPhone 17 / 17 Pro / 18 Pro in landscape, 874 px) a page with a two-column body spreads over the whole
	 * width and shows both columns; the tab bar stays.
	 */
	@media (min-width: 860px) and (max-width: 1023.98px) {
		.content:has(:global(.two-col)) {
			max-width: none;
			padding-inline: max(32px, var(--sai-left)) max(32px, var(--sai-right));
		}
	}
	/* Desktop (§ 1): left-aligned next to the sidebar; a page with a two-column body may use 1200 px. */
	@media (min-width: 1024px) {
		.content {
			max-width: calc(740px + 80px);
			margin: 0;
			padding: 8px 40px 48px;
		}
		.content:has(:global(.two-col)) {
			max-width: calc(1200px + 80px);
		}
	}
</style>
