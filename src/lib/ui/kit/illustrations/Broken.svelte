<svelte:options namespace="svg" />

<script lang="ts">
	import { box, line } from './iso';
	import Solid from './Solid.svelte';

	// Something broke: a block split in two, the halves apart, two chips on the ground.
	const left = box(-30, -18, 0, 22, 36, 34);
	const right = box(-2, -14, 6, 22, 36, 30);
	const crack = line([
		[-8, -12, 30],
		[-8, -4, 22],
		[-8, 4, 26],
		[-8, 12, 14]
	]);
	const chips = [box(4, 26, 0, 6, 6, 6), box(26, 24, 0, 5, 5, 4)];
</script>

<Solid faces={left} tone="n" />
<path class="ink" d={crack} />
<Solid faces={right} tone="p" />
{#each chips as chip, i (i)}<Solid faces={chip} tone="a" />{/each}
