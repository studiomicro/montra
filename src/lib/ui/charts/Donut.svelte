<script lang="ts">
	import { donutSegments } from './geometry';
	import './series.css';

	let {
		slices,
		title,
		value,
		sub,
		label
	}: {
		/** Largest first; `series` is a tile key (category hue) or 'other'; `href` opens that category. */
		slices: { series: string; minor: number; label: string; href: string | null }[];
		title: string;
		value: string;
		sub: string;
		label: string;
	} = $props();

	// r chosen so the circumference is 100: dash lengths are then percentages of the ring.
	const R = 15.9155;
	const C = 100;
	const segments = $derived(
		donutSegments(
			slices.map((s) => s.minor),
			C
		)
	);
</script>

<figure class="donut">
	<svg viewBox="0 0 42 42" role="group" aria-label={label}>
		<circle class="track" cx="21" cy="21" r={R} />
		<g class="slices">
			{#each slices as s, i (i)}
				{@const seg = segments[i]}
				{#if seg && seg.length > 0}
					{#if s.href}
						<a href={s.href} aria-label={s.label}>
							<circle
								class="slice series-{s.series}"
								cx="21"
								cy="21"
								r={R}
								stroke-dasharray="{seg.length} {C - seg.length}"
								stroke-dashoffset={25 - seg.offset}
							/>
						</a>
					{:else}
						<circle
							class="slice series-{s.series}"
							cx="21"
							cy="21"
							r={R}
							stroke-dasharray="{seg.length} {C - seg.length}"
							stroke-dashoffset={25 - seg.offset}
							role="img"
							aria-label={s.label}
						/>
					{/if}
				{/if}
			{/each}
		</g>
	</svg>
	<figcaption class="centre">
		<span class="title">{title}</span>
		<span class="value num">{value}</span>
		<span class="sub">{sub}</span>
	</figcaption>
</figure>

<style>
	.donut {
		position: relative;
		display: grid;
		place-items: center;
		width: min(100%, 240px);
		margin: 0 auto;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	circle {
		fill: none;
		stroke-width: 5;
	}
	.track {
		stroke: var(--chart-track);
	}
	.slice {
		stroke: var(--c);
		cursor: pointer;
	}
	a:focus-visible .slice {
		stroke-width: 7;
	}
	.centre {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 2px;
		pointer-events: none;
		text-align: center;
	}
	.title,
	.sub {
		color: var(--muted);
		font-size: 12px;
	}
	.value {
		font-size: 20px;
		font-weight: 700;
	}
	/*
	 * FN-51: on mount the slices turn in from −18° about the centre and fade in; the centre text follows. Keyed
	 * slices and a stable group: a filter re-render does not replay it. Dash lengths are untouched.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.slices {
			transform-box: view-box;
			transform-origin: 21px 21px;
			animation: slices-in var(--duration-slow) var(--ease) backwards;
		}
		.centre {
			animation: centre-in var(--duration-base) var(--ease) var(--duration-fast) backwards;
		}
	}
	@keyframes slices-in {
		from {
			opacity: 0;
			transform: rotate(-18deg);
		}
	}
	@keyframes centre-in {
		from {
			opacity: 0;
		}
	}
</style>
