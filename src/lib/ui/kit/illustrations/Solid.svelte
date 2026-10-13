<svelte:options namespace="svg" />

<script lang="ts">
	import type { Faces } from './iso';

	/**
	 * One isometric solid (a box or a disc from iso.ts) in a tone: n neutral, a accent, g gold (coins), p paper,
	 * d device. The colours are the Illustration's CSS classes, never values here.
	 */
	let { faces, tone = 'n' }: { faces: Faces; tone?: 'n' | 'a' | 'g' | 'p' | 'd' } = $props();
</script>

<path class="{tone}-l" d={faces.left} />
<path class="{tone}-r" d={faces.right} />
<path class="{tone}-t" d={faces.top} />
