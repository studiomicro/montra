<svelte:options namespace="svg" />

<script lang="ts">
	import { box, disc, line } from './iso';
	import Solid from './Solid.svelte';

	// A recurring charge: a calendar block with its rings, the paper grid on top, a coin beside it.
	const block = box(-28, -22, 0, 52, 40, 24);
	const paper = box(-26, -20, 24, 48, 36, 3);
	const grid = [
		line([
			[-26, -6, 27],
			[22, -6, 27]
		]),
		line([
			[-26, 6, 27],
			[22, 6, 27]
		]),
		line([
			[-10, -20, 27],
			[-10, 16, 27]
		]),
		line([
			[6, -20, 27],
			[6, 16, 27]
		])
	];
	const rings = [-14, 10].map((x) => disc(x, -18, 27, 2.5, 6));
	const today = box(8, 8, 27, 12, 6, 1);
	const coin = disc(34, 18, 0, 8, 3);
</script>

<Solid faces={block} tone="a" />
<Solid faces={paper} tone="p" />
{#each grid as d, i (i)}<path class="ink" {d} />{/each}
<Solid faces={today} tone="a" />
{#each rings as ring, i (i)}<Solid faces={ring} tone="d" />{/each}
<Solid faces={coin} tone="g" />
