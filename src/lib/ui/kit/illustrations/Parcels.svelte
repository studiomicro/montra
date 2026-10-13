<svelte:options namespace="svg" />

<script lang="ts">
	import { box, line } from './iso';
	import Solid from './Solid.svelte';

	// Things you keep: two parcels and a small box on top, taped.
	const big = box(-32, -22, 0, 36, 30, 24);
	const top = box(-28, -18, 24, 26, 22, 16);
	const small = box(-6, 6, 0, 30, 24, 18);
	const tape = [
		line([
			[-14, -22, 24],
			[-14, 8, 24]
		]),
		line([
			[-15, -18, 40],
			[-15, 4, 40]
		]),
		line([
			[9, 6, 18],
			[9, 30, 18]
		])
	];
</script>

<Solid faces={big} tone="n" />
<path class="ink" d={tape[0]} />
<Solid faces={top} tone="a" />
<path class="mark" d={tape[1]} />
<Solid faces={small} tone="g" />
<path class="ink" d={tape[2]} />
