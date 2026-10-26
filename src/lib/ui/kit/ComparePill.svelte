<script lang="ts">
	import { formatMoneyCompact } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from './amounts.svelte';
	import { comparisonKind, hasComparison } from './category';

	let {
		currentMinor,
		diffMinor,
		monthName
	}: {
		/** This period's total (null when too large to show); with a zero difference, zero hides the pill. */
		currentMinor: number | null;
		/** This period minus the compared one (positive = spent more). */
		diffMinor: number;
		monthName: string;
	} = $props();

	/** "Hampir sama" within Rp 5 jt either way. */
	const SAME_THRESHOLD_MINOR = 5_000_000;
	const { trf, locale } = useI18n();
	const kind = $derived(comparisonKind(diffMinor, SAME_THRESHOLD_MINOR));
	const amount = $derived(shown(formatMoneyCompact(Math.abs(diffMinor), 'IDR', locale)));
	/** The glyph carries the direction; the words carry it too (colour is never the only signal). */
	const GLYPH = { same: '≈', more: '↑', less: '↓' } as const;
</script>

{#if hasComparison(currentMinor, diffMinor)}
	<p class="pill {kind}">
		<span class="glyph" aria-hidden="true">{GLYPH[kind]}</span>
		<span class="text">
			{#if kind === 'same'}
				{trf('Hampir sama dengan {bulan}', { bulan: monthName })}
			{:else if kind === 'more'}
				{trf('{jumlah} lebih boros dari {bulan}', { jumlah: amount, bulan: monthName })}
			{:else}
				{trf('{jumlah} lebih hemat dari {bulan}', { jumlah: amount, bulan: monthName })}
			{/if}
		</span>
	</p>
{/if}

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		padding: 6px 14px 6px 10px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
	}
	.glyph {
		font-size: 15px;
		font-weight: 700;
	}
	.same .glyph {
		color: var(--same);
	}
	.more .glyph {
		color: var(--money-up);
	}
	.less .glyph {
		color: var(--money-in);
	}
</style>
