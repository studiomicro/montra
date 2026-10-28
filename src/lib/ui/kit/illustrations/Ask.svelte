<svelte:options namespace="svg" />

<script lang="ts">
	import { box, line } from './iso';
	import Solid from './Solid.svelte';

	// Asking your records: a question on a paper card, the answer on a panel in front with a small bar chart.
	const question = box(-34, -22, 0, 40, 3, 42);
	const asked = box(-28, -19, 24, 26, 2, 9);
	const answer = box(-8, 4, 0, 40, 3, 34);
	const lines = [
		line([
			[-2, 7, 26],
			[26, 7, 26]
		]),
		line([
			[-2, 7, 20],
			[20, 7, 20]
		])
	];
	const bars = [5, 10, 7, 14].map((h, i) => box(-2 + i * 7, 8, 4, 4, 2, h));
</script>

<Solid faces={question} tone="p" />
<Solid faces={asked} tone="a" />
<Solid faces={answer} tone="n" />
{#each lines as d, i (i)}<path class="ink" {d} />{/each}
{#each bars as bar, i (i)}<Solid faces={bar} tone={i === 3 ? 'a' : 'p'} />{/each}
