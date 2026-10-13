<script lang="ts">
	import CumulativeChart from '#lib/ui/charts/CumulativeChart.svelte';
	import Donut from '#lib/ui/charts/Donut.svelte';
	import HeatCalendar from '#lib/ui/charts/HeatCalendar.svelte';
	import StackedBars from '#lib/ui/charts/StackedBars.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import AllocationBar from '#lib/ui/net-worth/AllocationBar.svelte';
	import TrendChart from '#lib/ui/net-worth/TrendChart.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	// Fixed fictional figures (integer minor units) for reviewing the chart components; never real data.
	const { tr } = useI18n();
	const spend = [
		8, 12, 0, 25, 6, 18, 9, 30, 4, 11, 0, 16, 22, 7, 5, 9, 14, 3, 0, 21, 8, 6, 10, 2, 0, 17, 12, 9,
		4, 11, 6
	];
	const heat = spend.map((v, i) => ({
		date: `2026-10-${String(i + 1).padStart(2, '0')}`,
		minor: v * 1_000_000,
		level: (v === 0 ? 0 : Math.min(4, Math.ceil(v / 7.5))) as 0 | 1 | 2 | 3 | 4,
		future: i >= 8
	}));
	const run = (values: number[]) =>
		values.map((_, i) => values.slice(0, i + 1).reduce((a, b) => a + b, 0) * 1_000_000);
	const current = run(spend.slice(0, 8));
	const previous = run(spend.map((v) => v + 2));
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt'].map(
		(label, i) => {
			const segments = [
				{ series: 'makan', minor: (20 + i) * 10_000_000 },
				{ series: 'transportasi', minor: (8 + (i % 3)) * 10_000_000 },
				{ series: 'tagihan', minor: 15 * 10_000_000 },
				{ series: 'other', minor: (5 + (i % 4)) * 10_000_000 }
			];
			return { label, segments, total: segments.reduce((s, x) => s + x.minor, 0) };
		}
	);
	// FN-51: the Kekayaan charts, for the motion checks (e2e/motion.spec.ts).
	const trend = spend.slice(0, 14).map((v, i) => ({
		date: `2026-10-${String(i + 1).padStart(2, '0')}`,
		totalMinor: (1_000 + v * 10) * 100_000,
		partial: i === 5
	}));
	const allocation = {
		slices: [
			{ cls: 'wallets' as const, minor: 500_000_000, pct: 50 },
			{ cls: 'investment' as const, minor: 300_000_000, pct: 30 },
			{ cls: 'gold' as const, minor: 200_000_000, pct: 20 }
		],
		assetsMinor: 1_000_000_000,
		outside: []
	};
</script>

<svelte:head><title>Charts</title></svelte:head>
<ScreenTitle title="Charts" />
<p><Badge>{tr('Data demo')}</Badge></p>

<section>
	<h2>HeatCalendar</h2>
	<HeatCalendar days={heat} today="2026-10-08" label="Heatmap" hrefFor={() => '/dev/ui/charts'} />
</section>
<section>
	<h2>CumulativeChart</h2>
	<CumulativeChart
		{current}
		{previous}
		axisLength={31}
		slotLabel={(i) => `${i + 1} Okt`}
		currentName="Oktober"
		previousName="September"
		markerIndex={7}
		label="Cumulative"
	/>
</section>
<section>
	<h2>Donut</h2>
	<Donut
		slices={[
			{ series: 'makan', minor: 313_000_00, label: 'Makan', href: null },
			{ series: 'transportasi', minor: 120_000_00, label: 'Transportasi', href: null },
			{ series: 'kopi', minor: 60_000_00, label: 'Kopi', href: null }
		]}
		title="Uang keluar"
		value="Rp4,93 jt"
		sub="3 kategori"
		label="Donut"
	/>
</section>
<section>
	<h2>StackedBars</h2>
	<StackedBars
		{months}
		averageMinor={500_000_000}
		legend={[
			{ series: 'makan', label: 'Makan' },
			{ series: 'transportasi', label: 'Transportasi' },
			{ series: 'tagihan', label: 'Tagihan' },
			{ series: 'other', label: 'Lainnya' }
		]}
		label="Stacked"
	/>
</section>
<section>
	<h2>TrendChart</h2>
	<TrendChart points={trend} label="Trend" />
</section>
<section>
	<h2>AllocationBar</h2>
	<AllocationBar {allocation} />
</section>

<style>
	section {
		display: grid;
		gap: 12px;
		margin-top: 28px;
	}
	h2 {
		margin: 0;
		font-size: 19px;
	}
</style>
