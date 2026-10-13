<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<span class="badge">{@render children()}</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		height: 28px;
		padding: 0 12px;
		border-radius: var(--r-pill);
		background: var(--panel);
		/* The hairline keeps the pill visible on a --panel card too. */
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 16%, transparent);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
	}
</style>
