<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import { useLocale } from '#lib/ui/i18n-context';
	import { shown } from './amounts.svelte';

	let {
		label,
		inMinor,
		outMinor,
		currency = 'IDR'
	}: { label: string; inMinor: number; outMinor: number; currency?: string } = $props();
	const locale = useLocale();
</script>

<div class="day">
	<span class="label">{label}</span>
	<span class="num">
		{#if inMinor > 0}<span class="in"
				>{shown(formatMoney(inMinor, currency, 'signed', locale))}</span
			>{/if}
		{#if outMinor !== 0}<span
				>{shown(formatMoney(-Math.abs(outMinor), currency, 'auto', locale))}</span
			>{/if}
	</span>
</div>

<style>
	.day {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 20px 4px 8px;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	/* FN-51: arrives with the first row of its list (the same row-in as GroupList). */
	@media (prefers-reduced-motion: no-preference) {
		.day {
			animation: row-in var(--duration-base) var(--ease) backwards;
		}
	}
	@keyframes row-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	.label {
		color: var(--ink);
	}
	.num {
		display: inline-flex;
		gap: 10px;
	}
	.in {
		color: var(--money-in);
	}
</style>
