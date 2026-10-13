<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { formatShortMonth } from '#lib/shared/dates';
	import { laporanHref, stepPeriod, switchMode, type LaporanView } from '#lib/shared/laporan-query';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import PeriodStepper from '#lib/ui/kit/PeriodStepper.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';

	// Laporan's header actions: Bulanan/Tahunan and the period stepper. The switch is a GET form (field `m`,
	// with the current period as hidden fields) so it works without JavaScript; with it, a choice navigates
	// at once. The stepper's steps are plain links.
	let { view, today }: { view: LaporanView; today: string } = $props();
	const { tr, locale } = useI18n();

	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const options = $derived([
		{ value: 'bulan', label: tr('Bulanan') },
		{ value: 'tahun', label: tr('Tahunan') }
	]);
	function choose(mode: string) {
		if (mode === 'bulan' || mode === 'tahun')
			goto(laporanHref(switchMode(view, mode, today), today));
	}
	const prev = $derived(stepPeriod(view, -1, today));
	const next = $derived(stepPeriod(view, 1, today));
	const label = $derived(
		view.mode === 'tahun'
			? view.year
			: `${formatShortMonth(view.month, locale)} '${view.month.slice(2, 4)}`
	);
</script>

<div class="period">
	<form method="GET" action="/laporan" class="switch">
		{#if view.mode === 'tahun'}
			<input type="hidden" name="y" value={view.year} />
		{:else}
			<input type="hidden" name="p" value={view.month} />
		{/if}
		{#if view.direction === 'masuk'}<input type="hidden" name="arah" value="masuk" />{/if}
		<Segmented
			name="m"
			label={tr('Periode laporan')}
			{options}
			value={view.mode}
			onchange={hydrated ? choose : undefined}
		/>
		{#if !hydrated}<Button type="submit" variant="secondary">{tr('Tampilkan')}</Button>{/if}
	</form>
	<PeriodStepper
		{label}
		prevHref={prev ? laporanHref(prev, today) : null}
		nextHref={next ? laporanHref(next, today) : null}
	/>
</div>

<style>
	.period,
	.switch {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	/* A phone keeps Bulanan/Tahunan and the stepper on one row. */
	@media (max-width: 600px) {
		.period {
			flex-wrap: nowrap;
		}
	}
</style>
