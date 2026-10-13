<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/ui/Icon.svelte';
	let { children }: { children: Snippet } = $props();
</script>

<span class="tag"><span class="dot"><Icon name="check" size={10} /></span>{@render children()}</span
>

<style>
	.tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--money-in);
		font-size: 13px;
		font-weight: 600;
	}
	.dot {
		display: grid;
		place-items: center;
		width: 14px;
		height: 14px;
		border-radius: var(--r-pill);
		background: var(--money-in);
		color: var(--bg);
	}
</style>
