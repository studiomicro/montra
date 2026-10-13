<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import { axisPoints, axisX } from './geometry';

	let {
		current,
		previous,
		axisLength,
		slotLabel,
		currentName,
		previousName,
		markerIndex = null,
		currency = 'IDR',
		label
	}: {
		/** Running totals of this period so far (may stop before the end of the axis). */
		current: number[];
		/** Running totals of the period before, over the whole axis. */
		previous: number[];
		axisLength: number;
		/** Label of one slot of the axis ("8 Okt", "Mar"). */
		slotLabel: (index: number) => string;
		currentName: string;
		previousName: string;
		/** A dashed vertical "today" marker at this slot; null for a period that is over. */
		markerIndex?: number | null;
		currency?: string;
		label: string;
	} = $props();

	const { locale } = useI18n();
	const W = 320;
	const H = 140;
	const PAD = 6;
	const max = $derived(Math.max(0, ...current, ...previous));
	const last = $derived(Math.max(0, current.length - 1));
	let picked: number | null = $state(null);
	const selected = $derived(Math.min(picked ?? last, axisLength - 1));

	let svg: SVGSVGElement | undefined = $state();
	function pick(event: PointerEvent) {
		if (!svg || axisLength < 2) return;
		const box = svg.getBoundingClientRect();
		const frac = (event.clientX - box.left) / Math.max(1, box.width);
		picked = Math.min(axisLength - 1, Math.max(0, Math.round(frac * (axisLength - 1))));
	}
	function step(event: KeyboardEvent) {
		const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (delta === 0) return;
		event.preventDefault();
		picked = Math.min(axisLength - 1, Math.max(0, selected + delta));
	}
	const value = (series: number[], i: number) =>
		series[i] === undefined
			? '—'
			: shown(formatMoney(series[i] as number, currency, 'auto', locale));
	const x = (i: number) => PAD + axisX(i, axisLength, W - PAD * 2);
</script>

<figure class="cumulative">
	<figcaption class="pill num" aria-live="polite">
		<span class="slot">{slotLabel(selected)}</span>
		<span class="now"
			><span class="dot accent" aria-hidden="true"></span>{currentName}
			{value(current, selected)}</span
		>
		<span class="then"
			><span class="dot grey" aria-hidden="true"></span>{previousName}
			{value(previous, selected)}</span
		>
	</figcaption>
	<!-- The chart is a keyboard-steppable image: arrows move the read-out, pointer picks a day. -->
	<svg
		bind:this={svg}
		viewBox="0 0 {W} {H + PAD * 2}"
		role="slider"
		tabindex="0"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={axisLength - 1}
		aria-valuenow={selected}
		aria-valuetext="{slotLabel(selected)}: {value(current, selected)}"
		onpointerdown={pick}
		onpointermove={(e) => e.buttons > 0 && pick(e)}
		onkeydown={step}
	>
		<g transform="translate({PAD} {PAD})">
			<polyline
				class="previous"
				pathLength="1"
				points={axisPoints(previous, axisLength, W - PAD * 2, H, max)}
			/>
			<polyline
				class="current"
				pathLength="1"
				points={axisPoints(current, axisLength, W - PAD * 2, H, max)}
			/>
		</g>
		{#if markerIndex !== null}
			<line class="marker" x1={x(markerIndex)} x2={x(markerIndex)} y1={PAD} y2={H + PAD} />
		{/if}
		<line class="cursor" x1={x(selected)} x2={x(selected)} y1={PAD} y2={H + PAD} />
	</svg>
	<p class="axis num" aria-hidden="true">
		<span>{slotLabel(0)}</span><span>{slotLabel(axisLength - 1)}</span>
	</p>
</figure>

<style>
	.cumulative {
		display: grid;
		gap: 8px;
		margin: 0;
	}
	.pill {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		justify-self: start;
		gap: 4px 10px;
		padding: 6px 12px;
		border-radius: var(--r-pill);
		background: var(--panel);
		font-size: 13px;
	}
	.slot {
		font-weight: 700;
	}
	.then {
		color: var(--muted);
	}
	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		margin-right: 4px;
		border-radius: 50%;
	}
	.accent {
		background: var(--accent);
	}
	.grey {
		background: var(--chart-bar);
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
		touch-action: pan-y;
		cursor: crosshair;
	}
	svg:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
		border-radius: 8px;
	}
	polyline {
		fill: none;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.current {
		stroke: var(--accent);
	}
	.previous {
		stroke: var(--chart-bar);
	}
	.marker {
		stroke: var(--faint);
		stroke-width: 1;
		stroke-dasharray: 4 4;
	}
	.cursor {
		stroke: var(--line);
		stroke-width: 1;
	}
	/* FN-51: both lines draw from the left when the chart mounts (pathLength="1"); the markers fade in after. */
	@media (prefers-reduced-motion: no-preference) {
		polyline {
			stroke-dasharray: 1;
			animation: draw var(--duration-slow) var(--ease) backwards;
		}
		.marker,
		.cursor {
			animation: line-in var(--duration-base) var(--ease) var(--duration-fast) backwards;
		}
	}
	@keyframes draw {
		from {
			stroke-dashoffset: 1;
		}
	}
	@keyframes line-in {
		from {
			opacity: 0;
		}
	}
	.axis {
		display: flex;
		justify-content: space-between;
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
</style>
