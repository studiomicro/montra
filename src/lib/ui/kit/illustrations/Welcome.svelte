<svelte:options namespace="svg" />

<script lang="ts">
	import { box, disc, line, poly } from './iso';
	import Solid from './Solid.svelte';

	// Sign-in and sign-up: a phone showing a rising line, a stack of coins and a card.
	const phone = box(-30, -12, 0, 30, 6, 60);
	const screen = poly([
		[-27, -6, 6],
		[-3, -6, 6],
		[-3, -6, 56],
		[-27, -6, 56]
	]);
	const trend = line([
		[-23, -6, 18],
		[-17, -6, 28],
		[-11, -6, 24],
		[-6, -6, 40]
	]);
	const coins = [0, 3, 6, 9].map((z) => disc(24, 2, z, 9, 3));
	const card = box(2, 18, 0, 32, 20, 2);
	const stripe = line([
		[6, 30, 2],
		[30, 30, 2]
	]);
</script>

<Solid faces={phone} tone="d" />
<path class="a-t" d={screen} />
<path class="mark" d={trend} />
{#each coins as coin, i (i)}<Solid faces={coin} tone="g" />{/each}
<Solid faces={card} tone="a" />
<path class="mark" d={stripe} />
