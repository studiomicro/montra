<svelte:options namespace="svg" />

<script lang="ts">
	import { box, disc, line } from './iso';
	import Solid from './Solid.svelte';

	// An empty history: two blank receipts standing, a day block and a coin.
	const back = box(-34, -10, 0, 36, 4, 56);
	const backLines = [44, 36, 28].map((z) =>
		line([
			[-30, -6, z],
			[-4, -6, z]
		])
	);
	const day = box(14, -20, 0, 22, 22, 22);
	const front = box(-16, 6, 0, 30, 4, 38);
	const frontLines = [28, 20].map((z) =>
		line([
			[-12, 10, z],
			[8, 10, z]
		])
	);
	const coin = disc(30, 18, 0, 8, 3);
</script>

<Solid faces={back} tone="p" />
{#each backLines as d, i (i)}<path class="ink" {d} />{/each}
<Solid faces={day} tone="a" />
<Solid faces={front} tone="p" />
{#each frontLines as d, i (i)}<path class="ink" {d} />{/each}
<path
	class="ink strong"
	d={line([
		[-12, 10, 10],
		[10, 10, 10]
	])}
/>
<Solid faces={coin} tone="g" />
