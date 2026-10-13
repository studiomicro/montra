<svelte:options namespace="svg" />

<script lang="ts">
	import { box, disc } from './iso';
	import Solid from './Solid.svelte';

	// Net worth: three columns rising, a coin on the tallest.
	const bars = [
		{ faces: box(-34, -4, 0, 16, 16, 16), tone: 'n' as const },
		{ faces: box(-12, -4, 0, 16, 16, 30), tone: 'p' as const },
		{ faces: box(10, -4, 0, 16, 16, 46), tone: 'a' as const }
	];
	const coins = [46, 49].map((z) => disc(18, 4, z, 6, 3));
</script>

{#each bars as bar, i (i)}<Solid faces={bar.faces} tone={bar.tone} />{/each}
{#each coins as coin, i (i)}<Solid faces={coin} tone="g" />{/each}
