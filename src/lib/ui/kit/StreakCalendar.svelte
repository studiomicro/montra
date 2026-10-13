<script lang="ts">
	import { formatShortDay } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import type { BudgetDayState, ClosureDayState } from '#lib/shared/streak';
	import { mondayColumn } from '#lib/ui/charts/geometry';
	import { useI18n } from '#lib/ui/i18n-context';

	type State = ClosureDayState | BudgetDayState;

	/**
	 * FN-34b: one WIB month of a streak, laid out like HeatCalendar (weekday header, Monday first, 44 px cells),
	 * but each day is a state, never a heat level: closed / within (filled), frozen (dashed outline), over (red
	 * outline), missed / no budget (flat), today (ring), future (blank). Shape tells the states apart, not colour
	 * alone, and every cell says its date and state to assistive tech. Informational only: no cell is a link.
	 */
	let {
		days,
		label,
		legend
	}: {
		/** Every day of one month, in order. */
		days: { date: string; state: State }[];
		label: string;
		/** The states the legend explains, in order. */
		legend: readonly State[];
	} = $props();

	const { tr, locale } = useI18n();
	const STATE_LABELS: Record<State, string> = {
		closed: msg('Ditutup'),
		frozen: msg('Dijaga pembeku'),
		missed: msg('Terlewat'),
		within: msg('Sesuai anggaran'),
		over: msg('Melebihi anggaran'),
		no_budget: msg('Tanpa anggaran'),
		today: msg('Hari ini'),
		future: msg('Belum tiba')
	};
	const weekdays = $derived([
		tr('Sen'),
		tr('Sel'),
		tr('Rab'),
		tr('Kam'),
		tr('Jum'),
		tr('Sab'),
		tr('Min')
	]);
	const lead = $derived(days[0] ? mondayColumn(days[0].date) : 0);
</script>

<figure class="streak-cal">
	<div class="grid" role="group" aria-label={label}>
		{#each weekdays as w, i (i)}<span class="wd" aria-hidden="true">{w}</span>{/each}
		{#each Array.from({ length: lead }, (_, i) => i) as i (i)}<span class="blank"></span>{/each}
		{#each days as d (d.date)}
			<span class="cell {d.state}" aria-current={d.state === 'today' ? 'date' : undefined}>
				<span aria-hidden="true">{Number(d.date.slice(8))}</span>
				<span class="sr">{formatShortDay(d.date, locale)}: {tr(STATE_LABELS[d.state])}</span>
			</span>
		{/each}
	</div>
	<figcaption class="legend">
		{#each legend as state (state)}
			<span class="key"
				><span class="swatch {state}" aria-hidden="true"></span>{tr(STATE_LABELS[state])}</span
			>
		{/each}
	</figcaption>
</figure>

<style>
	.streak-cal {
		display: grid;
		gap: 12px;
		margin: 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 4px;
	}
	.wd {
		padding-bottom: 2px;
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
		text-align: center;
	}
	.cell {
		position: relative;
		display: grid;
		place-items: center;
		min-height: 44px;
		border-radius: 10px;
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	/* Filled: a closed day, a day within the budget. --bg on --ink holds AA in every theme. */
	.closed,
	.within {
		background: var(--ink);
		color: var(--bg);
	}
	/* Bridged by a freeze: kept, not closed. An outline, never a coin or snowflake. */
	.frozen {
		border: 2px dashed var(--ink-2);
	}
	.over {
		border: 2px solid var(--money-up);
		color: var(--money-up);
	}
	.missed,
	.no_budget {
		background: var(--panel);
		color: var(--muted);
	}
	.today {
		box-shadow: inset 0 0 0 2px var(--ink);
	}
	.future {
		color: var(--faint);
	}
	/* FN-40: the month's days fade in when the calendar appears. */
	@media (prefers-reduced-motion: no-preference) {
		.cell {
			animation: cell-in var(--duration-base) var(--ease) backwards;
		}
	}
	@keyframes cell-in {
		from {
			opacity: 0;
			transform: scale(0.92);
		}
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 14px;
		color: var(--muted);
		font-size: 12px;
	}
	.key {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.swatch {
		box-sizing: border-box;
		width: 14px;
		height: 14px;
		border-radius: 4px;
	}
	.swatch.today {
		box-shadow: inset 0 0 0 2px var(--ink);
	}
	.swatch.future {
		border: 1px solid var(--line);
	}
</style>
