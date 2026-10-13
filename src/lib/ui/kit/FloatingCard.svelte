<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<div class="card glass">{@render children()}</div>

<style>
	.card {
		padding: 16px;
		border-radius: var(--r-m);
	}
</style>
