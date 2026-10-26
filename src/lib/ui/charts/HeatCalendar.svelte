<script lang="ts">
	import { formatShortDay } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import { mondayColumn } from './geometry';

	let {
		days,
		today,
		currency = 'IDR',
		label,
		hrefFor,
		marks,
		selected = null
	}: {
		/** Every day of one month, in order; `level` 0–4 is the shade, `future` days are blank. */
		days: { date: string; minor: number | null; level: 0 | 1 | 2 | 3 | 4; future: boolean }[];
		today: string;
		currency?: string;
		label: string;
		/** Where tapping a day goes: that day's transactions. */
		hrefFor: (date: string) => string;
		/**
		 * FN-54 /kalender: shape-coded marks per date (a ring for a closed day, a square for a bill or recurring item
		 * still to come), each also named for assistive tech, plus their legend. A future day with a mark is a link
		 * too (its detail lists what is due).
		 */
		marks?: Readonly<Record<string, { closed?: boolean; due?: boolean }>>;
		/** FN-54: the day whose detail is shown under the grid. */
		selected?: string | null;
	} = $props();

	const { tr, locale } = useI18n();
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
	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const amount = (minor: number | null) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, currency, 'auto', locale));
	const CLOSED = msg('Hari ditutup');
	const DUE = msg('Ada tagihan atau transaksi berulang');
	/** The marks of `date` as words, after the figure ("…: Rp 25.000, Hari ditutup"). */
	const markWords = (date: string) => {
		const m = marks?.[date];
		return [m?.closed ? tr(CLOSED) : '', m?.due ? tr(DUE) : ''].filter(Boolean);
	};
</script>

{#snippet markShapes(date: string)}
	{#if marks?.[date]?.closed}<span class="mark ring" aria-hidden="true"></span>{/if}
	{#if marks?.[date]?.due}<span class="mark square" aria-hidden="true"></span>{/if}
{/snippet}

<figure class="heat">
	<div class="grid" role="group" aria-label={label}>
		{#each weekdays as w, i (i)}<span class="wd" aria-hidden="true">{w}</span>{/each}
		{#each Array.from({ length: lead }, (_, i) => i) as i (i)}<span class="blank"></span>{/each}
		{#each days as d (d.date)}
			{#if d.future && marks?.[d.date]?.due}
				<a
					class="cell future"
					class:selected={d.date === selected}
					href={hrefFor(d.date)}
					aria-label="{formatShortDay(d.date, locale)}: {markWords(d.date).join(', ')}"
				>
					<span class="day">{Number(d.date.slice(8))}</span>
					{@render markShapes(d.date)}
				</a>
			{:else if d.future}
				<span class="cell future" aria-hidden="true">{Number(d.date.slice(8))}</span>
			{:else}
				<a
					class="cell l{d.level}"
					class:today={d.date === today}
					class:selected={d.date === selected}
					href={hrefFor(d.date)}
					aria-label="{formatShortDay(d.date, locale)}: {[
						amount(d.minor),
						...markWords(d.date)
					].join(', ')}"
					aria-current={d.date === today ? 'date' : undefined}
				>
					<span class="day">{Number(d.date.slice(8))}</span>
					{@render markShapes(d.date)}
				</a>
			{/if}
		{/each}
	</div>
	<figcaption class="legend">
		<span>{tr('sedikit')}</span>
		<span class="swatch l1" aria-hidden="true"></span>
		<span class="swatch l2" aria-hidden="true"></span>
		<span class="swatch l3" aria-hidden="true"></span>
		<span class="swatch l4" aria-hidden="true"></span>
		<span>{tr('banyak')}</span>
		{#if marks}
			<span class="key"><span class="mark ring" aria-hidden="true"></span>{tr(CLOSED)}</span>
			<span class="key"><span class="mark square" aria-hidden="true"></span>{tr(DUE)}</span>
		{/if}
	</figcaption>
</figure>

<style>
	.heat {
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
		text-decoration: none;
	}
	a.cell:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.future {
		color: var(--faint);
		background: transparent;
	}
	.l0 {
		background: var(--chart-track);
		color: var(--ink-2);
	}
	.l1 {
		background: var(--heat-1);
	}
	.l2 {
		background: var(--heat-2);
	}
	.l3 {
		background: var(--heat-3);
	}
	.l4 {
		background: var(--heat-4);
	}
	/* No text token clears AA on the light --heat-4 fill (white 4.49:1, ink 4.0:1), so the busiest days keep
	   the full shade and draw their number on a small --bg dot: --ink on --bg in both themes. */
	.l4 .day {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--bg);
		color: var(--ink);
	}
	.today {
		box-shadow: inset 0 0 0 2px var(--ink);
	}
	/* FN-54: the day shown under the grid (/kalender): a second, outer ring, so today's inset ring stays readable. */
	.selected {
		outline: 2px solid var(--ink-2);
		outline-offset: 1px;
	}
	a.future {
		color: var(--ink-2);
	}
	/* FN-54 marks: shape, not colour, tells them apart (a ring = closed day, a square = something due). */
	.mark {
		display: inline-block;
		flex: none;
		width: 7px;
		height: 7px;
		border: 1.5px solid var(--ink);
		background: var(--bg);
	}
	.cell .mark {
		position: absolute;
		top: 4px;
	}
	.cell .ring {
		left: 4px;
	}
	.cell .square {
		right: 4px;
	}
	.ring {
		border-radius: 50%;
	}
	.square {
		border-radius: 1px;
		background: var(--ink);
	}
	.key {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: 8px;
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
	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 4px;
		color: var(--muted);
		font-size: 12px;
	}
	.swatch {
		width: 14px;
		height: 14px;
		border-radius: 4px;
	}
</style>
