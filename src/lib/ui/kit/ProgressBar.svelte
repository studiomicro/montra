<script lang="ts">
	/**
	 * `tone`: ink by default, `warn` (amber, ahead of pace) or `over` (money-up) past a budget. `marker`: the pace
	 * marker, a thin tick at that percent of the track (Anggaran), drawn above the fill.
	 */
	let {
		percent,
		label,
		tone = 'ink',
		marker
	}: { percent: number; label: string; tone?: 'ink' | 'warn' | 'over'; marker?: number } = $props();
	const clamp = (v: number) => Math.min(100, Math.max(0, Number.isFinite(v) ? v : 0));
	/** The fill's width: the percent, clamped to 0–100 (the text beside it is never capped). */
	const fill = $derived(clamp(percent));
	/** The marker's left edge, kept inside the track (it is 1 unit wide). */
	const tick = $derived(marker === undefined ? null : Math.min(99, clamp(marker)));
</script>

<svg
	class="progress"
	class:marked={tick !== null}
	viewBox="0 0 100 10"
	preserveAspectRatio="none"
	role="progressbar"
	aria-label={label}
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={fill}
	aria-valuetext="{percent}%"
>
	<rect class="fill {tone}" x="0" y="0" width={fill} height="10" />
	{#if tick !== null}<rect class="marker" x={tick} y="0" width="1" height="10" />{/if}
</svg>

<style>
	.progress {
		display: block;
		width: 100%;
		height: 8px;
		border-radius: var(--r-pill);
		background: var(--chart-track);
		overflow: hidden;
	}
	.marked {
		height: 10px;
	}
	.fill {
		fill: var(--ink);
	}
	/*
	 * FN-51: the fill scales in from the left when the bar mounts (the rect's width, and aria-valuenow, are the
	 * final value from the first frame); a later percent change on the same bar does not replay it.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.fill {
			transform-box: fill-box;
			transform-origin: 0 50%;
			animation: fill-in var(--duration-slow) var(--ease) backwards;
		}
	}
	@keyframes fill-in {
		from {
			transform: scaleX(0);
		}
	}
	.fill.warn {
		fill: var(--warn);
	}
	.fill.over {
		fill: var(--money-up);
	}
	.marker {
		fill: var(--bg);
	}
</style>
