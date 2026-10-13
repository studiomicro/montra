<svelte:options namespace="svg" />

<script lang="ts">
	import { box, disc, line, poly } from './iso';
	import Solid from './Solid.svelte';

	// An empty inbox: an open tray, one envelope hovering above it.
	const tray = box(-34, -24, 0, 68, 48, 14);
	const floor = poly([
		[-30, -20, 5],
		[30, -20, 5],
		[30, 20, 5],
		[-30, 20, 5]
	]);
	const backWall = poly([
		[-30, -20, 5],
		[30, -20, 5],
		[30, -20, 14],
		[-30, -20, 14]
	]);
	const sideWall = poly([
		[-30, -20, 5],
		[-30, 20, 5],
		[-30, 20, 14],
		[-30, -20, 14]
	]);
	const envelope = box(-20, -14, 32, 40, 28, 4);
	const flapPoints: [number, number, number][] = [
		[-20, 14, 36],
		[0, -2, 36],
		[20, 14, 36]
	];
	const flapFill = poly(flapPoints);
	const flap = line(flapPoints);
	const seal = disc(0, -2, 36, 3.5, 1);
</script>

<Solid faces={tray} tone="n" />
<path class="n-r" d={floor} />
<path class="n-l" d={backWall} />
<path class="n-r" d={sideWall} />
<Solid faces={envelope} tone="p" />
<path class="p-l" d={flapFill} />
<path class="ink" d={flap} />
<Solid faces={seal} tone="a" />
