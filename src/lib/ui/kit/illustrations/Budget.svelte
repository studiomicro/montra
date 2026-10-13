<svelte:options namespace="svg" />

<script lang="ts">
	import { disc } from './iso';
	import Solid from './Solid.svelte';

	// A budget: a round plan with one slice set aside, and a stack of coins.
	const plan = disc(-14, -8, 0, 26, 8);
	const slice = (() => {
		const a = (-125 * Math.PI) / 180;
		const ex = Math.round((plan.cx + plan.rx * Math.cos(a)) * 10) / 10;
		const ey = Math.round((plan.cy + plan.ry * Math.sin(a)) * 10) / 10;
		return `M${plan.cx} ${plan.cy}L${Math.round((plan.cx + plan.rx) * 10) / 10} ${plan.cy}A${plan.rx} ${plan.ry} 0 0 0 ${ex} ${ey}Z`;
	})();
	const coins = [0, 3, 6, 9, 12].map((z) => disc(28, 12, z, 9, 3));
</script>

<Solid faces={plan} tone="n" />
<path class="a-t" d={slice} />
{#each coins as coin, i (i)}<Solid faces={coin} tone="g" />{/each}
