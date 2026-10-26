<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import { useLocale } from '#lib/ui/i18n-context';
	import { shown } from './amounts.svelte';
	import { cappedBars } from './chart-scale';

	let {
		days,
		selected = $bindable(days.length - 1),
		label,
		currency = 'IDR',
		today,
		dayLink
	}: {
		/** Oldest → newest. `tick`: the short axis label under the bar (the day of the month). */
		days: { label: string; minor: number; tick?: string }[];
		selected?: number;
		label: string;
		currency?: string;
		/** Index of today: its tick is bold and underlined. */
		today?: number;
		/** The selected day's list (link text and href), shown in the readout. */
		dayLink?: (index: number) => { href: string; text: string };
	} = $props();

	const locale = useLocale();
	/** Chart height: also the height of every day's hit column (≥44 px touch target). */
	const H = 120;
	/** Height of the axis row under the bars. */
	const AXIS = 22;
	/** Width of one day's hit column (the touch target, ≥44 px) and of the visible bar drawn inside it. */
	const COL = 44;
	const BAR = 22;

	/** One outlier (rent) no longer flattens the other days: it is capped and drawn with a break mark. */
	const scale = $derived(
		cappedBars(
			days.map((d) => d.minor),
			H
		)
	);
	const heights = $derived(scale.heights);
	const current = $derived(days[selected]);
	const link = $derived(dayLink?.(selected));
	const width = $derived(days.length * COL);
	const hasTicks = $derived(days.some((d) => d.tick));
	const money = (minor: number) => shown(formatMoney(minor, currency, 'auto', locale));

	function select(event: KeyboardEvent, i: number) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault(); // Space would otherwise scroll the page
		selected = i;
	}

	// The days run oldest → newest: start scrolled to the end, so today is in view on a narrow screen.
	let scroller: HTMLDivElement | undefined = $state();
	$effect(() => {
		if (scroller) scroller.scrollLeft = scroller.scrollWidth;
	});
</script>

<figure class="chart">
	<figcaption class="readout num">
		{#if current}<span class="day">{current.label}</span><span>{money(current.minor)}</span>{/if}
		{#if link}<a class="link text-link" href={link.href}>{link.text}</a>{/if}
	</figcaption>
	<div class="scroll" bind:this={scroller}>
		<svg
			{width}
			height={hasTicks ? H + AXIS : H}
			viewBox="0 0 {width} {hasTicks ? H + AXIS : H}"
			role="group"
			aria-label={label}
		>
			{#each heights as h, i (i)}
				<rect
					class="bar"
					class:active={i === selected}
					x={i * COL + (COL - BAR) / 2}
					y={H - h}
					width={BAR}
					height={h}
					rx="4"
					aria-hidden="true"
				/>
				{#if scale.clipped[i]}
					<path
						class="break"
						d="M{i * COL + (COL - BAR) / 2 - 1} {H - h + 16} l{BAR + 2} -6 m0 5 l-{BAR + 2} 6"
						aria-hidden="true"
					/>
				{/if}
				{#if days[i]?.tick}
					<text
						class="tick"
						class:today={i === today}
						x={i * COL + COL / 2}
						y={H + 15}
						text-anchor="middle"
						aria-hidden="true">{days[i]?.tick}</text
					>
					{#if i === today}
						<rect
							class="underline"
							x={i * COL + COL / 2 - 7}
							y={H + 19}
							width="14"
							height="2"
							rx="1"
							aria-hidden="true"
						/>
					{/if}
				{/if}
				<rect
					class="hit"
					x={i * COL}
					y="0"
					width={COL}
					height={H}
					role="button"
					tabindex="0"
					aria-pressed={i === selected ? 'true' : 'false'}
					aria-label="{days[i]?.label}: {money(days[i]?.minor ?? 0)}"
					onclick={() => (selected = i)}
					onkeydown={(e) => select(e, i)}
				/>
			{/each}
		</svg>
	</div>
</figure>

<style>
	.chart {
		margin: 0;
		min-width: 0; /* lets .scroll scroll inside a grid/flex parent instead of widening it */
	}
	.readout {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 8px;
		margin-bottom: 8px;
		font-weight: 600;
	}
	.day {
		color: var(--muted);
		font-weight: 400;
	}
	.link {
		margin-left: auto;
	}
	.scroll {
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}
	.bar {
		fill: var(--chart-bar);
		pointer-events: none;
	}
	.bar.active {
		fill: var(--accent);
	}
	/* Two page-coloured slashes across a bar cut at the top of the scale: "taller than drawn". */
	.break {
		fill: none;
		stroke: var(--bg);
		stroke-width: 2;
		pointer-events: none;
	}
	/* FN-40: the bars grow from the baseline when the chart appears (not on a re-render: rows are keyed). */
	@media (prefers-reduced-motion: no-preference) {
		.bar {
			transform-box: fill-box;
			transform-origin: 50% 100%;
			animation: grow var(--duration-slow) var(--ease) backwards;
		}
	}
	@keyframes grow {
		from {
			transform: scaleY(0);
		}
	}
	.tick {
		fill: var(--muted);
		font-size: 11px;
	}
	.tick.today {
		fill: var(--ink);
		font-weight: 700;
	}
	.underline {
		fill: var(--ink);
	}
	.hit {
		fill: transparent;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: -2px;
	}
</style>
