<script lang="ts">
	import { formatMoneyCompact } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from '#lib/ui/kit/amounts.svelte';

	/**
	 * FN-54 B3, chip 2: the budget in words, a link to /anggaran. With money left, the same compact remaining figure
	 * as the budget line under the charts ("Rp1,2 jt masih bisa dipakai"); spent, over and no budget use the existing
	 * phrases. Every amount goes through `shown()`, so the eye button masks the text and its accessible name alike.
	 * Colour is never the only signal: the words carry the state.
	 */
	let {
		safeToSpend,
		currency
	}: {
		/** Null without a budget. */
		safeToSpend:
			| { kind: 'left'; remainingMinor: number }
			| { kind: 'spent' }
			| { kind: 'over'; overMinor: number | null }
			| null;
		/** The budget's currency (the budget line's). */
		currency: string;
	} = $props();
	const { tr, trf, locale } = useI18n();
	const compact = (minor: number) => shown(formatMoneyCompact(minor, currency, locale));
	const text = $derived(
		safeToSpend === null
			? tr('Atur anggaran')
			: safeToSpend.kind === 'left'
				? trf('{sisa} masih bisa dipakai', { sisa: compact(safeToSpend.remainingMinor) })
				: safeToSpend.kind === 'spent'
					? tr('Anggaran bulan ini sudah habis.')
					: safeToSpend.overMinor === null
						? tr('Sudah melebihi anggaran.')
						: trf('Sudah melebihi anggaran sebesar {jumlah}', {
								jumlah: compact(safeToSpend.overMinor)
							})
	);
	const over = $derived(safeToSpend !== null && safeToSpend.kind !== 'left');
</script>

<a class="chip-budget num" class:over href="/anggaran">{text}</a>

<style>
	.chip-budget {
		display: inline-flex;
		align-items: center;
		margin: 0;
		padding: 6px 14px;
		border-radius: var(--r-pill);
		background: var(--bg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}
	.chip-budget:hover {
		text-decoration: underline;
	}
	.over {
		color: var(--money-up);
	}
	@media (pointer: coarse) {
		.chip-budget {
			min-height: 44px;
		}
	}
</style>
