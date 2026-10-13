<svelte:options namespace="svg" />

<script lang="ts">
	import { box, disc, line } from './iso';
	import Solid from './Solid.svelte';

	// An empty wallet: a card standing behind the open flap, the clasp, one coin beside it.
	const card = box(-22, -27, 10, 40, 3, 26);
	const body = box(-32, -22, 0, 64, 44, 16);
	const flap = box(-32, -22, 16, 64, 26, 3);
	const clasp = box(-5, 2, 12, 10, 4, 9);
	const coin = disc(36, 16, 0, 9, 3);
</script>

<Solid faces={card} tone="p" />
<path
	class="ink"
	d={line([
		[-18, -24, 30],
		[6, -24, 30]
	])}
/>
<Solid faces={body} tone="a" />
<Solid faces={flap} tone="a" />
<path
	class="mark"
	d={line([
		[-28, 4, 19],
		[28, 4, 19]
	])}
/>
<Solid faces={clasp} tone="g" />
<Solid faces={coin} tone="g" />
