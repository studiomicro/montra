<svelte:options namespace="svg" />

<script lang="ts">
	import { box, disc, pt } from './iso';
	import Solid from './Solid.svelte';

	// A shared space: two people on one platform.
	const platform = box(-36, -24, 0, 72, 48, 6);
	const people = [
		{ x: -12, y: -8, h: 24, tone: 'a' as const },
		{ x: 14, y: 8, h: 19, tone: 'g' as const }
	].map((p) => {
		const [hx, hy] = pt(p.x, p.y, 6 + p.h + 9);
		return { body: disc(p.x, p.y, 6, 8, p.h), hx, hy, tone: p.tone };
	});
</script>

<Solid faces={platform} tone="n" />
{#each people as p, i (i)}
	<Solid faces={p.body} tone={p.tone} />
	<circle class="{p.tone}-l" cx={p.hx} cy={p.hy} r="8" />
	<circle class="{p.tone}-t" cx={p.hx - 2} cy={p.hy - 2} r="5" />
{/each}
