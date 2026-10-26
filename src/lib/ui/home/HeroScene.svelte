<script lang="ts" module>
	import { box, disc, guides, line, nodes, type Faces } from '#lib/ui/kit/illustrations/iso';

	/**
	 * The city once (module scope): six blocks along the street and a coin tower in the middle, built from the FN-40
	 * isometric boxes and discs. Blocks stand on the line y = -x, so they sit side by side on one ground line.
	 */
	const BLOCKS: { faces: Faces; tone: 'n' | 'p' | 'a' }[] = [
		{ x: -74, h: 26, tone: 'p' as const },
		{ x: -48, h: 44, tone: 'n' as const },
		{ x: -24, h: 30, tone: 'a' as const },
		{ x: 22, h: 38, tone: 'n' as const },
		{ x: 46, h: 24, tone: 'p' as const },
		{ x: 70, h: 34, tone: 'n' as const }
	].map(({ x, h, tone }) => ({ faces: box(x - 7, -x - 7, 0, 14, 14, h), tone }));
	const COINS = [0, 5, 10].map((z) => disc(0, 0, z, 9, 5));

	/**
	 * Blueprint ground (owner request 2026-10-14): a grid band under the street (the line y = -x), dashed guides
	 * along its edges and diamond handles at their ends. One path each, so the strip stays within its shape budget.
	 */
	const along = (c: number, from: number, to: number): [number, number, number][] => [
		[from + c / 2, -from + c / 2, 0],
		[to + c / 2, -to + c / 2, 0]
	];
	const across = (u: number, w: number): [number, number, number][] => [
		[u - w / 2, -u - w / 2, 0],
		[u + w / 2, -u + w / 2, 0]
	];
	const GRID = [
		...[-8, 0, 8].map((c) => line(along(c, -96, 96))),
		...Array.from({ length: 17 }, (_, i) => line(across(-96 + i * 12, 16)))
	].join('');
	const GUIDES = guides([along(-16, -112, 112), along(16, -112, 112)]);
	const NODES = nodes([...along(-16, -88, 88), ...along(16, -88, 88)]);
</script>

<script lang="ts">
	import type { GreetingPeriod } from '#lib/shared/greeting';
	import Solid from '#lib/ui/kit/illustrations/Solid.svelte';
	import '#lib/ui/kit/illustrations/tones.css';

	/**
	 * FN-54 B5: Beranda's hero strip, an original Montra scene (not a copy of any other app's art). Inline SVG coloured
	 * only through the shared tone classes, so light, dark, mono and the Pro themes repaint it; no image, gradient,
	 * filter or style attribute (CSP). Static: only the sky follows the server's time of day (a low sun in the
	 * morning, a high one at midday, a low warm one in the afternoon, a moon and two stars at night). A fixed height
	 * and `meet` mean the whole scene always shows, never stretched (a wide card leaves sky at the sides; QA FN-54 #2:
	 * `slice` cropped the sun and moon off the top from 1280 px), and the strip never shifts layout.
	 */
	let { period }: { period: GreetingPeriod } = $props();
</script>

<svg
	class="scene iso-art"
	width="100%"
	height="96"
	viewBox="0 0 320 96"
	preserveAspectRatio="xMidYMax meet"
	aria-hidden="true"
	focusable="false"
	data-period={period}
>
	{#if period === 'pagi'}
		<circle class="g-t" cx="58" cy="44" r="10" />
	{:else if period === 'siang'}
		<circle class="g-t" cx="160" cy="16" r="10" />
	{:else if period === 'sore'}
		<circle class="g-r" cx="262" cy="46" r="10" />
	{:else}
		<path class="d-t" d="M252 12a11 11 0 1 0 10 17a9 9 0 1 1-10-17z" />
		<path class="ink" d="M70 20h6M73 17v6" />
		<path class="ink" d="M104 34h6M107 31v6" />
	{/if}
	<g transform="translate(160 86)">
		<path class="grid" d={GRID} />
		<path class="guide" d={GUIDES} />
		<path class="node" d={NODES} />
		{#each BLOCKS as block, i (i)}<Solid faces={block.faces} tone={block.tone} />{/each}
		{#each COINS as coin, i (i)}<Solid faces={coin} tone="g" />{/each}
	</g>
</svg>

<style>
	.scene {
		display: block;
		width: 100%;
		height: 96px;
		color: var(--muted);
		pointer-events: none;
	}
	@media (min-width: 1024px) {
		.scene {
			height: 120px;
		}
	}
</style>
