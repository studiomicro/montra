<svelte:options namespace="svg" />

<script lang="ts">
	import { box, disc, poly } from './iso';
	import Solid from './Solid.svelte';

	// A goal: a flag on a two-step pedestal.
	const base = disc(0, 0, 0, 28, 6);
	const step = disc(0, 0, 6, 18, 6);
	const pole = box(-1.5, -1.5, 12, 3, 3, 48);
	const flag = poly([
		[1.5, 0, 58],
		[30, 0, 51],
		[1.5, 0, 44]
	]);
	const flagShade = poly([
		[1.5, 0, 44],
		[30, 0, 51],
		[16, 0, 47]
	]);
</script>

<Solid faces={base} tone="n" />
<Solid faces={step} tone="p" />
<Solid faces={pole} tone="d" />
<path class="a-l" d={flag} />
<path class="a-r" d={flagShade} />
