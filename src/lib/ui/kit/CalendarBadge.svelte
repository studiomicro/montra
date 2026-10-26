<script lang="ts">
	import { formatDayLabel, formatShortMonth, monthOf } from '#lib/shared/dates';
	import { useI18n } from '#lib/ui/i18n-context';

	/**
	 * FN-54 B7: the date as a small calendar page, linking to /kalender. Always the server's WIB date (`today`, from
	 * the load), never the device clock. Ink and white only (mono-safe), flat, no motion.
	 */
	let { today, id }: { today: string; id?: string } = $props();
	const { trf, locale } = useI18n();
	const month = $derived(formatShortMonth(monthOf(today), locale).replace('.', ''));
	const day = $derived(Number(today.slice(8, 10)));
</script>

<a
	{id}
	class="badge"
	href="/kalender"
	aria-label={trf('Kalender, {tanggal}', { tanggal: formatDayLabel(today, locale) })}
>
	<span class="month" aria-hidden="true">{month}</span>
	<span class="day num" aria-hidden="true">{day}</span>
</a>

<style>
	.badge {
		display: grid;
		flex: none;
		grid-template-rows: 18px 1fr;
		width: 48px;
		height: 52px;
		overflow: hidden;
		border: 1.5px solid var(--ink);
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		text-decoration: none;
	}
	.badge:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.month {
		display: grid;
		place-items: center;
		background: var(--action);
		color: var(--on-action);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.day {
		display: grid;
		place-items: center;
		font-size: 18px;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
	}
</style>
