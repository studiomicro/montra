<script lang="ts">
	import { skeletonRows } from '#lib/ui/motion';

	/** Loading placeholder; in the DOM only while a load is outstanding (every caller: `{#if loading}`). */
	let { rows = 3 }: { rows?: number } = $props();
	const count = $derived(skeletonRows(rows));
</script>

<div class="skeleton" aria-hidden="true">
	{#each Array.from({ length: count }, (_, i) => i) as i (i)}
		<div class="bar"></div>
	{/each}
</div>

<style>
	.skeleton {
		display: grid;
		gap: 10px;
	}
	.bar {
		position: relative;
		height: 56px;
		border-radius: var(--r-s);
		background: var(--panel-2);
		overflow: hidden;
	}
	/*
	 * FN-51: a light band sweeps each bar while the load is outstanding — the one `infinite` animation besides
	 * MascotLoading, allowed because the component leaves the DOM with the loading branch. Under reduced motion the
	 * bars are flat `--panel-2`: no band at all.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.bar::after {
			content: '';
			position: absolute;
			inset: 0;
			background: linear-gradient(
				90deg,
				transparent,
				color-mix(in srgb, var(--bg) 45%, transparent),
				transparent
			);
			animation: shimmer var(--duration-loop) var(--ease-in-out) infinite;
		}
	}
	@keyframes shimmer {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(100%);
		}
	}
</style>
