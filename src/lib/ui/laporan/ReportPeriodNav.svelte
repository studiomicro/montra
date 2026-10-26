<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		periodStepLabel,
		reportPeriodHref,
		stepReportPeriod,
		switchReportKind,
		type ReportKind,
		type ReportPeriod
	} from '#lib/shared/report-period';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import PeriodStepper from '#lib/ui/kit/PeriodStepper.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';

	// FN-53: Bulan | Kuartal | Tahun and the period stepper for /alur-uang and /kekayaan/laporan. The switch is a GET
	// form (field `m`, with the current period as hidden fields) so it works without JavaScript; with it, a choice
	// navigates at once. The stepper's steps are plain links, so Back returns to the previous period. Below 600 px the
	// three-option control takes its own full-width row under the title, the stepper the row below it.
	let {
		path,
		period,
		today,
		defaultKind
	}: { path: string; period: ReportPeriod; today: string; defaultKind: ReportKind } = $props();
	const { tr, locale } = useI18n();

	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const options = $derived([
		{ value: 'bulan', label: tr('Bulan') },
		{ value: 'kuartal', label: tr('Kuartal') },
		{ value: 'tahun', label: tr('Tahun') }
	]);
	const href = (p: ReportPeriod) => reportPeriodHref(path, p, today, defaultKind);
	function choose(kind: string) {
		if (kind === 'bulan' || kind === 'kuartal' || kind === 'tahun')
			void goto(href(switchReportKind(period, kind, today)));
	}
	const prev = $derived(stepReportPeriod(period, -1, today));
	const next = $derived(stepReportPeriod(period, 1, today));
</script>

<div class="period report-period">
	<form method="GET" action={path} class="switch">
		{#if period.kind === 'bulan'}
			<input type="hidden" name="p" value={period.month} />
		{:else if period.kind === 'kuartal'}
			<input type="hidden" name="k" value="{period.year}-Q{period.quarter}" />
		{:else}
			<input type="hidden" name="y" value={period.year} />
		{/if}
		<Segmented
			name="m"
			label={tr('Jenis periode')}
			{options}
			value={period.kind}
			onchange={hydrated ? choose : undefined}
		/>
		{#if !hydrated}<Button type="submit" variant="secondary">{tr('Tampilkan')}</Button>{/if}
	</form>
	<PeriodStepper
		label={periodStepLabel(period, locale)}
		prevHref={prev ? href(prev) : null}
		nextHref={next ? href(next) : null}
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
	/* A phone: the switch on its own full-width row, the stepper under it (no horizontal scroll at 360 px). */
	@media (max-width: 600px) {
		/* ScreenTitle's actions slot: a row of its own after the title and its subtitle. */
		:global(.screen-title .actions:has(> .report-period)) {
			order: 4;
			flex: 1 0 100%;
			margin-left: 0;
		}
		.period {
			flex: 1 0 100%;
			flex-direction: column;
			align-items: stretch;
		}
		.switch {
			flex-wrap: nowrap;
		}
		.switch :global(.segmented) {
			flex: 1;
		}
		.switch :global(.segment) {
			flex: 1 1 0;
		}
		.period :global(.stepper) {
			align-self: flex-start;
		}
	}
</style>
