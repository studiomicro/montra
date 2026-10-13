<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { isStaleItem } from '#lib/shared/offline-queue';
	import { useI18n } from '#lib/ui/i18n-context';
	import OfflineBadge from './OfflineBadge.svelte';
	import PendingSheet from './PendingSheet.svelte';
	import {
		offlineState,
		retryOffline,
		startOfflineQueue,
		stopOfflineQueue
	} from './runtime.svelte';

	/** FN-02 in the (app) shell: starts this account's queue and shows its state. */
	let { accountId, spaceId }: { accountId: string; spaceId: string | null } = $props();
	const { tr } = useI18n();
	let open = $state(false);
	/** Confirmations shown in the pill for a few seconds ("N perubahan tersimpan."). */
	let justConfirmed = $state(0);
	let seen = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		void startOfflineQueue(accountId);
		return () => {
			clearTimeout(timer);
			stopOfflineQueue();
		};
	});

	const queue = $derived(offlineState.queue);
	const items = $derived(queue?.items ?? []);
	/** Stale items (not kept for 7 days) wait for the user like failed ones: never shown as being sent. */
	const waitingForUser = $derived(
		items.filter((i) => i.status === 'failed' || isStaleItem(i, Date.now())).length
	);

	// Success is only ever the server's ok: the store counts confirmations, this shows them.
	$effect(() => {
		const confirmed = queue?.confirmed ?? 0;
		if (confirmed <= seen) {
			seen = confirmed;
			return;
		}
		justConfirmed += confirmed - seen;
		seen = confirmed;
		clearTimeout(timer);
		timer = setTimeout(() => (justConfirmed = 0), 4000);
		// Lists that show the new rows reload; a form page keeps what the user is typing.
		const path = page.url.pathname;
		if (path === '/' || path === '/riwayat') void invalidateAll();
	});
</script>

{#if offlineState.discarded > 0}
	<p class="notice" role="status">
		{tr('Perubahan yang belum terkirim dari akun lain di perangkat ini sudah dibuang.')}
	</p>
{/if}
<OfflineBadge
	pending={items.length - waitingForUser}
	failed={waitingForUser}
	online={offlineState.online}
	sessionEnded={queue?.sessionEnded ?? false}
	confirmed={justConfirmed}
	onopen={() => (open = true)}
/>
<PendingSheet
	bind:open
	{items}
	currentSpaceId={spaceId}
	sessionEnded={queue?.sessionEnded ?? false}
	now={Date.now()}
	onretry={(id) => void retryOffline(id)}
	ondiscard={(id) => void queue?.remove(id)}
/>

<style>
	.notice {
		margin: 8px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink-2);
		font-size: 15px;
	}
	/* FN-51: mounts after hydration, so it slides in instead of popping (full height from the first frame). */
	@media (prefers-reduced-motion: no-preference) {
		.notice {
			animation: banner-in var(--duration-base) var(--ease) backwards;
		}
	}
	@keyframes banner-in {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
	}
</style>
