<script lang="ts">
	import { formatShortDate } from '#lib/shared/dates';
	import type { TanyaCard } from '#lib/shared/tanya';
	import Donut from '#lib/ui/charts/Donut.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import BarChart from '#lib/ui/kit/BarChart.svelte';
	import { shown } from '#lib/ui/kit/amounts.svelte';

	/**
	 * One figure card of a Tanya answer (FN-22): every value was computed and formatted by the server from stored
	 * rows. The list is the chart's text equivalent, so screen readers get every figure without the chart.
	 */
	let { card }: { card: TanyaCard } = $props();
	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	const period = $derived(
		card.period
			? trf('{dari} – {sampai}', {
					dari: formatShortDate(card.period.from, locale),
					sampai: formatShortDate(card.period.to, locale)
				})
			: ''
	);
</script>

<section class="card" aria-labelledby="{uid}-title">
	<h3 id="{uid}-title">{tr(card.title)}</h3>
	{#if period}<p class="period">{period}</p>{/if}
	{#if card.chart?.type === 'donut' && card.chart.slices.length > 0}
		<div class="chart" aria-hidden="true">
			<Donut
				slices={card.chart.slices.map((s) => ({
					series: s.series,
					minor: s.minor,
					label: s.label || tr('Lainnya'),
					href: null
				}))}
				title={tr(card.title)}
				value=""
				sub=""
				label={tr(card.title)}
			/>
		</div>
	{:else if card.chart?.type === 'bars' && card.chart.bars.length > 0}
		<div class="chart">
			<BarChart
				days={card.chart.bars.map((b) => ({ label: b.label, minor: b.minor, tick: b.label }))}
				label={tr(card.title)}
				currency={card.chart.currency}
			/>
		</div>
	{/if}
	{#if card.rows.length > 0}
		<dl class="rows">
			{#each card.rows as row, i (i)}
				<div class="row">
					<dt>{row.raw ? row.label : tr(row.label)}</dt>
					<dd class="num">{row.value ? shown(row.value) : ''}</dd>
				</div>
			{/each}
		</dl>
	{/if}
</section>

<style>
	.card {
		display: grid;
		gap: 8px;
		padding: 14px 16px;
		border-radius: var(--r-group);
		background: var(--panel);
		min-width: 0;
	}
	h3 {
		margin: 0;
		font-size: 15px;
		font-weight: 700;
	}
	.period {
		margin: -4px 0 0;
		color: var(--muted);
		font-size: 13px;
	}
	.chart {
		min-width: 0;
	}
	.rows {
		display: grid;
		gap: 6px;
		margin: 0;
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 14px;
	}
	dt {
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--muted);
	}
	dd {
		margin: 0;
		font-weight: 600;
		text-align: right;
		white-space: nowrap;
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
</style>
