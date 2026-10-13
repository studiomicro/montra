<script lang="ts">
	import { linePoints } from './chart-scale';

	let { thisMonth, lastMonth, label }: { thisMonth: number[]; lastMonth: number[]; label: string } =
		$props();

	const W = 300;
	const H = 120;
	const max = $derived(Math.max(0, ...thisMonth, ...lastMonth));
</script>

<svg viewBox="0 0 {W} {H}" class="lines" role="img" aria-label={label}>
	<polyline points={linePoints(lastMonth, W, H, max)} class="last" pathLength="1" />
	<polyline points={linePoints(thisMonth, W, H, max)} class="this" pathLength="1" />
</svg>

<style>
	.lines {
		display: block;
		width: 100%;
		height: auto;
	}
	polyline {
		fill: none;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.this {
		stroke: var(--accent);
	}
	.last {
		stroke: var(--faint);
	}
	/* FN-40: each line draws from the month's first day when the chart appears (pathLength="1"). */
	@media (prefers-reduced-motion: no-preference) {
		polyline {
			stroke-dasharray: 1;
			animation: draw var(--duration-slow) var(--ease) backwards;
		}
	}
	@keyframes draw {
		from {
			stroke-dashoffset: 1;
		}
	}
</style>
