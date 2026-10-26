<script lang="ts">
	import type { Snippet } from 'svelte';
	// The big total on the money pages (Langganan, Barang, Koleksi): 44 px on a phone, 52 px on desktop.
	let { muted = false, children }: { muted?: boolean; children: Snippet } = $props();
</script>

<p class="figure num" class:muted>{@render children()}</p>

<style>
	.figure {
		margin: 0;
		font-size: 44px;
		font-weight: 700;
		line-height: 1.05;
		letter-spacing: -0.04em;
		overflow-wrap: anywhere;
	}
	.muted {
		color: var(--muted);
	}
	@media (min-width: 1024px) {
		.figure {
			font-size: 52px;
		}
	}
</style>
