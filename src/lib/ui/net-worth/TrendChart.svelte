<script lang="ts">
	import { formatShortDay } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import { trendPoints } from '#lib/ui/charts/geometry';
	import { useI18n } from '#lib/ui/i18n-context';
	import { amounts, shown } from '#lib/ui/kit/amounts.svelte';

	// FN-25b: the net-worth trend, a hand-drawn SVG line of the stored daily totals (no chart library, nothing
	// interpolated). A day whose total left a price or rate out is drawn with a lighter dot. Fewer than two
	// days cannot make a line: the caller shows the empty text instead. While amounts are hidden the line, its area,
	// its dots and its rising/falling colour are not drawn (owner decision 2026-10-13: hiding covers everything that
	// reveals an amount); the dates stay.
	let {
		points,
		label
	}: {
		/** Oldest first, at least two. */
		points: { date: string; totalMinor: number; partial: boolean }[];
		label: string;
	} = $props();

	const { tr, locale } = useI18n();
	const W = 320;
	const H = 120;
	const PAD = 6;
	const xy = $derived(
		trendPoints(
			points.map((p) => p.totalMinor),
			W - PAD * 2,
			H
		).map((p) => ({ x: p.x + PAD, y: p.y + PAD }))
	);
	const line = $derived(xy.map((p) => `${p.x},${p.y}`).join(' '));
	const area = $derived(
		xy.length > 1
			? `M${xy[0]?.x},${H + PAD} L${line.replaceAll(' ', ' L')} L${xy[xy.length - 1]?.x},${H + PAD} Z`
			: ''
	);
	const last = $derived(points.length - 1);
	const down = $derived(
		!amounts.hidden && (points[last]?.totalMinor ?? 0) < (points[0]?.totalMinor ?? 0)
	);

	let picked: number | null = $state(null);
	const selected = $derived(Math.min(picked ?? last, last));
	let svg: SVGSVGElement | undefined = $state();
	function pick(event: PointerEvent) {
		if (!svg || points.length < 2) return;
		const box = svg.getBoundingClientRect();
		const frac = (event.clientX - box.left) / Math.max(1, box.width);
		picked = Math.min(last, Math.max(0, Math.round(frac * last)));
	}
	function step(event: KeyboardEvent) {
		const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (delta === 0) return;
		event.preventDefault();
		picked = Math.min(last, Math.max(0, selected + delta));
	}
	const day = (i: number) => (points[i] ? formatShortDay(points[i].date, locale) : '');
	const value = (i: number) =>
		points[i] ? shown(formatMoney(points[i].totalMinor, 'IDR', 'auto', locale)) : '';
	const at = $derived(xy[selected]);
</script>

<figure class="trend" class:down>
	<figcaption class="pill num" aria-live="polite">
		<span class="slot">{day(selected)}</span>
		<span>{value(selected)}</span>
		{#if points[selected]?.partial}
			<span class="partial-note">{tr('Sebagian harga belum tersedia hari itu')}</span>
		{/if}
	</figcaption>
	<!-- A keyboard-steppable image: arrows move the read-out, a pointer picks a day. -->
	<svg
		bind:this={svg}
		viewBox="0 0 {W} {H + PAD * 2}"
		role="slider"
		tabindex="0"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={last}
		aria-valuenow={selected}
		aria-valuetext="{day(selected)}: {value(selected)}"
		onpointerdown={pick}
		onpointermove={(e) => e.buttons > 0 && pick(e)}
		onkeydown={step}
	>
		{#if amounts.hidden}
			<line class="masked" x1={PAD} x2={W - PAD} y1={H / 2 + PAD} y2={H / 2 + PAD} />
		{:else}
			<path class="area" d={area} />
			<polyline class="line" pathLength="1" points={line} />
			{#each xy as p, i (i)}
				{#if points[i]?.partial}
					<circle class="dot partial" cx={p.x} cy={p.y} r="3" data-partial="1" />
				{/if}
			{/each}
		{/if}
		{#if at && !amounts.hidden}
			<line class="cursor" x1={at.x} x2={at.x} y1={PAD} y2={H + PAD} />
			<circle class="dot now" class:partial={points[selected]?.partial} cx={at.x} cy={at.y} r="4" />
		{/if}
	</svg>
	<p class="axis num" aria-hidden="true">
		<span>{day(0)}</span><span>{day(last)}</span>
	</p>
</figure>

<style>
	.trend {
		display: grid;
		gap: 8px;
		margin: 0;
		--trend: var(--money-in);
	}
	.trend.down {
		--trend: var(--money-up);
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
	.partial-note {
		color: var(--muted);
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
	.line {
		fill: none;
		stroke: var(--trend);
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.area {
		fill: color-mix(in srgb, var(--trend) 12%, transparent);
		stroke: none;
	}
	.dot {
		fill: var(--trend);
	}
	/* A partial day: a hollow, lighter dot, so a flat stretch is never mistaken for a complete figure. */
	.dot.partial {
		fill: var(--bg);
		stroke: var(--muted);
		stroke-width: 1.5;
	}
	.cursor {
		stroke: var(--line);
		stroke-width: 1;
	}
	.masked {
		stroke: var(--line);
		stroke-width: 2;
		stroke-dasharray: 4 4;
	}
	/* FN-51: the line draws from the left when the chart mounts; the area, dots and cursor fade in after it. */
	@media (prefers-reduced-motion: no-preference) {
		.line {
			stroke-dasharray: 1;
			animation: draw var(--duration-slow) var(--ease) backwards;
		}
		.area,
		.dot,
		.cursor {
			animation: trend-in var(--duration-base) var(--ease) var(--duration-fast) backwards;
		}
	}
	@keyframes draw {
		from {
			stroke-dashoffset: 1;
		}
	}
	@keyframes trend-in {
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
