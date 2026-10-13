<script lang="ts">
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import { stackRects } from './geometry';
	import './series.css';

	let {
		months,
		averageMinor,
		legend,
		currency = 'IDR',
		label
	}: {
		/** One bar per month; segments bottom-up, `series` a tile key or 'other'. */
		months: { label: string; total: number; segments: { series: string; minor: number }[] }[];
		averageMinor: number;
		legend: { series: string; label: string }[];
		currency?: string;
		label: string;
	} = $props();

	const { trf, locale } = useI18n();
	const money = (minor: number) => shown(formatMoney(minor, currency, 'auto', locale));
	const compact = (minor: number) => shown(formatMoneyCompact(minor, currency, locale));
	const W = 320;
	const H = 150;
	const TOP = 18;
	const max = $derived(Math.max(0, ...months.map((m) => m.total)));
	const col = $derived(W / Math.max(1, months.length));
	const bar = $derived(Math.min(22, col * 0.6));
	const avgY = $derived(max > 0 ? TOP + H - (averageMinor / max) * H : TOP + H);
	let selected = $state(-1);
	const current = $derived(months[selected]);

	function key(event: KeyboardEvent, i: number) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		selected = i;
	}
</script>

<figure class="stacked">
	<figcaption class="readout num" aria-live="polite">
		{#if current}
			<strong>{current.label}</strong>
			{money(current.total)}
		{:else}
			{trf('rata-rata {jumlah}/bln', { jumlah: compact(averageMinor) })}
		{/if}
	</figcaption>
	<svg viewBox="0 0 {W} {TOP + H + 18}" role="group" aria-label={label}>
		{#each months as m, i (i)}
			{@const rects = stackRects(
				m.segments.map((s) => s.minor),
				max,
				H
			)}
			<g transform="translate({i * col + (col - bar) / 2} {TOP})" aria-hidden="true">
				{#each m.segments as s, j (j)}
					{@const r = rects[j]}
					{#if r && r.height > 0}
						<rect
							class="seg series-{s.series}"
							class:dim={selected >= 0 && selected !== i}
							x="0"
							y={r.y}
							width={bar}
							height={r.height}
						/>
					{/if}
				{/each}
			</g>
			<text class="month" x={i * col + col / 2} y={TOP + H + 14} text-anchor="middle"
				>{m.label}</text
			>
			<rect
				class="hit"
				x={i * col}
				y="0"
				width={col}
				height={TOP + H}
				role="button"
				tabindex="0"
				aria-pressed={selected === i ? 'true' : 'false'}
				aria-label="{m.label}: {money(m.total)}"
				onclick={() => (selected = selected === i ? -1 : i)}
				onkeydown={(e) => key(e, i)}
			/>
		{/each}
		{#if max > 0}
			<line class="avg" x1="0" x2={W} y1={avgY} y2={avgY} />
			<text class="avg-label" x={W} y={avgY - 4} text-anchor="end">
				{compact(averageMinor)}
			</text>
		{/if}
	</svg>
	<ul class="legend">
		{#each legend as l, i (i)}
			<li class="chip series-{l.series}"><span class="dot" aria-hidden="true"></span>{l.label}</li>
		{/each}
	</ul>
</figure>

<style>
	.stacked {
		display: grid;
		gap: 8px;
		margin: 0;
	}
	.readout {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.readout strong {
		margin-right: 6px;
		color: var(--ink);
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	.seg {
		fill: var(--c);
	}
	/* FN-51: the bars grow up from the baseline when the chart mounts (keyed: a selection does not replay it). */
	@media (prefers-reduced-motion: no-preference) {
		.seg {
			transform-box: fill-box;
			transform-origin: 50% 100%;
			animation: bar-grow var(--duration-base) var(--ease) backwards;
		}
	}
	@keyframes bar-grow {
		from {
			transform: scaleY(0);
		}
	}
	.dim {
		opacity: 0.35;
	}
	.month,
	.avg-label {
		fill: var(--muted);
		font-size: 10px;
	}
	.avg {
		stroke: var(--faint);
		stroke-width: 1;
		stroke-dasharray: 4 4;
	}
	.hit {
		fill: transparent;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline: 2px solid var(--brand);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: var(--r-pill);
		background: var(--panel);
		font-size: 13px;
		font-weight: 600;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--c);
	}
</style>
