<script lang="ts">
	import { navigating } from '$app/state';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';

	let { children } = $props();
	// Loading state while another /ruang page's data is on its way (client-side navigation).
	const loading = $derived(
		!!navigating.to?.route.id?.startsWith('/(app)/ruang') &&
			navigating.to.url.pathname !== navigating.from?.url.pathname
	);
</script>

{#if loading}
	<div class="loading" aria-busy="true"><Skeleton rows={4} /></div>
{:else}
	{@render children()}
{/if}

<style>
	.loading {
		padding-top: 64px;
	}
</style>
